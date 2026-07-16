// Browsers other than Safari (Chrome/Skia, Firefox) can't decode TIFF in an
// <img>, new Image(), or createImageBitmap — Safari only works because WebKit
// hands decoding to Apple's system ImageIO. Since the whole app (viewer,
// metadata dimension probe, and the worker's rasterize) consumes `image.url`
// through the browser's native decoder, TIFF inputs are invisible everywhere in
// Chrome. We fix it once, at ingest/restore, by transcoding the TIFF to a PNG
// blob and using that as `image.url` — every downstream consumer then works
// unchanged in every browser.
import { fromBlob } from 'geotiff'

// True for anything that looks like a TIFF, from a File/Blob (type + name) or a
// bare filename string (used on restore, where the OPFS Blob carries no name).
export function isTiff(fileOrName) {
  if (!fileOrName) return false
  const name = (typeof fileOrName === 'string' ? fileOrName : fileOrName.name || '').toLowerCase()
  const type = typeof fileOrName === 'string' ? '' : (fileOrName.type || '').toLowerCase()
  return type === 'image/tiff' || type === 'image/tif' || name.endsWith('.tif') || name.endsWith('.tiff')
}

// Cached per session: can this engine decode TIFF natively (Safari/WebKit via
// ImageIO), meaning the JS transcode below can be skipped entirely? Probed
// lazily against the first real TIFF blob encountered (cheap either way — a
// native decode is near-instant, and a rejection on Chrome/Firefox is too),
// then reused for every subsequent TIFF in the session.
let nativeDecodeCache = null
export async function canDecodeTiffNatively(blob) {
  if (nativeDecodeCache !== null) return nativeDecodeCache
  try {
    const bmp = await createImageBitmap(blob)
    bmp.close()
    nativeDecodeCache = true
  } catch {
    nativeDecodeCache = false
  }
  return nativeDecodeCache
}

// The session-cached native-decode result (true/false), or null if not yet
// probed. Lets callers avoid loading an original blob just to feed the probe
// when the answer is already known (e.g. restore's per-image cache lookup).
export function nativeTiffDecodeResult() {
  return nativeDecodeCache
}

// Header-only read: width/height via the IFD, without the expensive full
// pixel decode (readRGB, below) — lets callers show real dimensions near-
// instantly while the slow decode+encode still runs in the background.
export async function readTiffDimensions(blob) {
  const tiff = await fromBlob(blob)
  const image = await tiff.getImage()
  return { width: image.getWidth(), height: image.getHeight() }
}

// Decode a TIFF blob (handles BigTIFF / tiled / compressed / geo, via geotiff),
// once, then encode it two ways from the same decoded pixels: a JPEG for
// display (fast + small — this is what the viewer shows) and a lossless PNG
// for compute (SIFT detection, dense MVS both read pixels back out of the
// image, not the original TIFF — see useImagesStore's `computeUrl`), so the
// JPEG's quantization never reaches the reconstruction pipeline. readRGB()
// resolves photometric interpretation (RGB / grayscale / palette / CMYK /
// YCbCr) to 8-bit RGB, so we just pack it into RGBA and re-encode both.
//
// The full-res decode is unavoidably the dominant cost (geotiff.js decodes
// every compressed tile/strip at native resolution — there's no pyramid/
// overview to read a cheap low-res version from). Once decoded, though, an
// `onThumbnail` callback fires with a small (≤512px) preview blob *before*
// the two full-res encodes run, so callers can show something well before
// the (comparatively slow) full JPEG+PNG encode finishes.
export async function tiffToDisplayBlob(blob, { jpegQuality = 0.92, onThumbnail, onDisplay, decoder } = {}) {
  // Per-stage wall-clock timings (ms), surfaced in the returned result so the
  // caller can log the decode/repack/JPEG/PNG split — the baseline that showed
  // decode (pure-JS geotiff) is ~87% of ingest and drove the native decoder. See
  // the TIFF-codec plan (TODO ▸ TC).
  const timings = {}
  const t0 = performance.now()

  // Decode is the dominant cost. Prefer the injected native (Rust/WASM) decoder,
  // which returns interleaved 8-bit RGBA directly (no repack); on ANY failure
  // (exotic photometric / JPEG-in-TIFF / float the `tiff` crate can't handle)
  // fall back to the pure-JS geotiff path so no input regresses. `srcInfo` is
  // diagnostic only (compression/bit-depth for the baseline log).
  let width, height, rgba
  const srcInfo = { srcBytes: blob.size }
  timings.backend = 'geotiff'

  if (decoder) {
    try {
      const dec = await decoder(blob)               // { width, height, rgba: Uint8Array(RGBA) }
      width = dec.width
      height = dec.height
      rgba = dec.rgba instanceof Uint8ClampedArray ? dec.rgba : new Uint8ClampedArray(dec.rgba.buffer, dec.rgba.byteOffset, dec.rgba.byteLength)
      timings.backend = 'wasm'
      timings.decodeMs = performance.now() - t0
      timings.repackMs = 0
    } catch {
      // fall through to geotiff below
    }
  }

  if (!rgba) {
    const tiff = await fromBlob(blob)
    const image = await tiff.getImage()
    width = image.getWidth()
    height = image.getHeight()

    // Source shape (before readRGB collapses everything to 8-bit RGB): grayscale
    // / high-bit-depth / compression — the factors that sized the native win.
    // Prefer geotiff's accessor methods (fileDirectory tag names can be absent on
    // some IFDs); fall back to the raw directory for the compression tag.
    const fd = (typeof image.getFileDirectory === 'function' ? image.getFileDirectory() : image.fileDirectory) || {}
    const bps = typeof image.getBitsPerSample === 'function' ? image.getBitsPerSample() : fd.BitsPerSample
    srcInfo.photometric = typeof image.getPhotometricInterpretation === 'function'
      ? image.getPhotometricInterpretation() : fd.PhotometricInterpretation // 1=gray, 2=RGB, 3=palette, 6=YCbCr…
    srcInfo.samplesPerPixel = typeof image.getSamplesPerPixel === 'function' ? image.getSamplesPerPixel() : fd.SamplesPerPixel
    srcInfo.bitsPerSample = Array.isArray(bps) ? bps[0] : bps
    srcInfo.compression = fd.Compression             // 1=none, 5=LZW, 8=Deflate, 32773=PackBits, 7=JPEG…

    const rgb = await image.readRGB({ interleave: true })
    timings.decodeMs = performance.now() - t0

    const tRepack = performance.now()
    const spp = rgb.length / (width * height) // 3 (RGB) or 4 (RGBA)
    rgba = new Uint8ClampedArray(width * height * 4)
    for (let px = 0, s = 0; px < width * height; px++, s += spp) {
      rgba[px * 4]     = rgb[s]
      rgba[px * 4 + 1] = rgb[s + 1]
      rgba[px * 4 + 2] = rgb[s + 2]
      rgba[px * 4 + 3] = spp === 4 ? rgb[s + 3] : 255
    }
    timings.repackMs = performance.now() - tRepack
  }

  const canvas = new OffscreenCanvas(width, height)
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0)

  if (onThumbnail) {
    const maxDim = 512
    const scale = Math.min(1, maxDim / Math.max(width, height))
    const tw = Math.max(1, Math.round(width * scale))
    const th = Math.max(1, Math.round(height * scale))
    const thumbCanvas = new OffscreenCanvas(tw, th)
    thumbCanvas.getContext('2d').drawImage(canvas, 0, 0, tw, th)
    onThumbnail(await thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 }), tw, th)
  }

  // Kick off both encodes concurrently (convertToBlob offloads to the browser's
  // codec threads, so JPEG and PNG genuinely overlap — do NOT serialize them or
  // ingest slows by the JPEG time per image). But hand the display JPEG back via
  // onDisplay the moment it lands (well before the slower PNG) so the viewer is
  // fully usable while compute (computeUrl) waits on the final result — nothing
  // lossy ever reaches detection/dense.
  const tEncode = performance.now()
  const displayPromise = canvas.convertToBlob({ type: 'image/jpeg', quality: jpegQuality })
  const computePromise = canvas.convertToBlob({ type: 'image/png' })
  let jpegDoneAt = null
  if (onDisplay) displayPromise.then(onDisplay).catch(() => {})
  displayPromise.then(() => { jpegDoneAt = performance.now() }).catch(() => {})
  const [displayBlob, computeBlob] = await Promise.all([displayPromise, computePromise])
  // JPEG and PNG encode concurrently, so these overlap rather than sum: jpegMs
  // is time-to-JPEG, pngMs is total encode time (dominated by the slower PNG).
  timings.jpegMs = (jpegDoneAt ?? performance.now()) - tEncode
  timings.pngMs = performance.now() - tEncode
  timings.totalMs = performance.now() - t0
  return { displayBlob, computeBlob, width, height, timings, srcInfo }
}

// Convenience: given a File/Blob (+ optional name for restore Blobs), return a
// browser-displayable object URL — transcoding TIFF, passing everything else
// straight through URL.createObjectURL. Skips the transcode when the engine
// can already decode the TIFF itself.
export async function displayUrlFor(blob, name = null) {
  if (isTiff(name ?? blob)) {
    if (await canDecodeTiffNatively(blob)) return URL.createObjectURL(blob)
    const { displayBlob } = await tiffToDisplayBlob(blob)
    return URL.createObjectURL(displayBlob)
  }
  return URL.createObjectURL(blob)
}
