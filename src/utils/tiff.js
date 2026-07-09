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
export async function tiffToDisplayBlob(blob, { jpegQuality = 0.92, onThumbnail, onDisplay } = {}) {
  const tiff = await fromBlob(blob)
  const image = await tiff.getImage()
  const width = image.getWidth()
  const height = image.getHeight()

  const rgb = await image.readRGB({ interleave: true })
  const spp = rgb.length / (width * height) // 3 (RGB) or 4 (RGBA)
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let px = 0, s = 0; px < width * height; px++, s += spp) {
    rgba[px * 4]     = rgb[s]
    rgba[px * 4 + 1] = rgb[s + 1]
    rgba[px * 4 + 2] = rgb[s + 2]
    rgba[px * 4 + 3] = spp === 4 ? rgb[s + 3] : 255
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
  const displayPromise = canvas.convertToBlob({ type: 'image/jpeg', quality: jpegQuality })
  const computePromise = canvas.convertToBlob({ type: 'image/png' })
  if (onDisplay) displayPromise.then(onDisplay).catch(() => {})
  const [displayBlob, computeBlob] = await Promise.all([displayPromise, computePromise])
  return { displayBlob, computeBlob, width, height }
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
