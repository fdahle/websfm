// Browsers other than Safari (Chrome/Skia, Firefox) can't decode TIFF in an
// <img>, new Image(), or createImageBitmap — Safari only works because WebKit
// hands decoding to Apple's system ImageIO. Since the whole app (viewer,
// metadata dimension probe, and the worker's rasterize) consumes `image.url`
// through the browser's native decoder, TIFF inputs are invisible everywhere in
// Chrome. We fix it once, at ingest/restore, by transcoding the TIFF to a PNG
// blob and using that as `image.url` — every downstream consumer then works
// unchanged in every browser.
import { percentileRange, stretch16ToRgba } from '../core/io/tonalStretch.js'

let geotiffModule
async function openTiff(blob) {
  geotiffModule ??= import('geotiff')
  const { fromBlob } = await geotiffModule
  return fromBlob(blob)
}

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

// Read one IFD tag by name — the ONLY correct way to touch a file directory.
//
// ⚠ geotiff 3.x made the IFD lazy: `getImage().getFileDirectory()` returns an
// `ImageFileDirectory` whose tags live in internal Maps and are fetched from
// the source on demand. Plain property access (`fd.ModelTiepoint`) is therefore
// ALWAYS `undefined` — it doesn't throw, it silently reads a field that isn't
// there, so every `fd.Foo?.[0] ?? fallback` quietly becomes the fallback. That
// is exactly how a properly georeferenced REMA tile came to be ingested as a
// source photo (`fd.ModelTiepoint` → undefined → "no geolocation tags").
//
// Accessor *methods* (`getWidth`, `getSamplesPerPixel`, `getGeoKeys`,
// `getOrigin`, `getResolution`) resolve deferred fields internally and are
// unaffected — prefer them where one exists, and use this helper otherwise.
// Falls back to plain property access so an older/eager geotiff still works.
export async function readTiffTag(fd, name) {
  if (!fd) return undefined
  if (typeof fd.loadValue === 'function') return fd.loadValue(name)
  return fd[name]
}

// The raster model stores only an origin plus independent X/Y scales. A full
// GeoTIFF ModelTransformation can also rotate or shear pixels; silently
// collapsing those terms changes every sample location and displayed bound.
// Keep the format boundary explicit until the raster model grows a full affine.
export function isAxisAlignedModelTransformation(matrix, epsilon = 1e-12) {
  if (!matrix?.length || matrix.length < 16) return false
  const m = Array.from(matrix, Number)
  if (!m.every(Number.isFinite)) return false
  // x = m0*col + m1*row + m3; y = m4*col + m5*row + m7.
  // The final row must describe an affine (not perspective) transform.
  return Math.abs(m[1]) <= epsilon
    && Math.abs(m[4]) <= epsilon
    && Math.abs(m[12]) <= epsilon
    && Math.abs(m[13]) <= epsilon
    && Math.abs(m[14]) <= epsilon
    && Math.abs(m[15] - 1) <= epsilon
}

// Is this TIFF a *georeferenced raster* (a reference DEM / orthophoto) rather
// than a source photo?
//
// The discriminator is the GeoTIFF geolocation tags — ModelTiepoint +
// ModelPixelScale, or a full ModelTransformation. Aerial film scans carry none
// of them, so the split is clean in practice, and it has to happen BEFORE the
// image path: `useImagesStore` ingests any TIFF as a source image, so a dropped
// GeoTIFF DEM would otherwise become a very confused source photo.
//
// Header-only — geotiff parses the IFD without decoding any pixels, the same
// cheap read `readTiffDimensions` does, so this is safe on the main thread even
// for a 200 MB tile. Returns false for anything unreadable (fall back to the
// image path, which is the pre-existing behaviour).
export async function isGeoreferencedTiff(blob) {
  return (await probeTiffGeoTags(blob)).georeferenced
}

// The same header-only probe, but reporting *why* — which of the geolocation
// tags were present, or what went wrong reading the IFD. The verdict silently
// sends a file down one of two very different paths, so the reason has to be
// auditable in the log; "my GeoTIFF was ingested as a photo" is otherwise
// undebuggable without the file.
// Are these geolocation tags *present but meaningless*?
//
// Scanners and TIFF-writing toolchains routinely emit placeholder tags: tiepoint
// (0,0,0 → 0,0,0), pixel scale (1,1,0), no CRS geokey. That is the identity
// transform — pixel coordinates relabelled as world coordinates — which is not
// georeferencing, it is a file saying nothing. Aerial film scans arrive exactly
// like this, and taking the tags at face value routed a whole flight strip into
// Reference Data as "orthophotos" at origin 0/0, scale 1/-1.
//
// A declared CRS overrides all of this: a raster that names EPSG:xxxx is
// georeferenced even at an unlikely origin, so we only call it degenerate when
// there is no CRS to give those numbers meaning.
export function isDegenerateGeoTransform({ pixelScale, tiepoint, transformation, hasCrs }) {
  if (hasCrs) return false

  // The same scanner placeholder can be written as a 4×4
  // ModelTransformation instead of ModelTiepoint + ModelPixelScale. The TMA
  // CA213732V00xx scans use exactly this form: x=column, y=row, origin 0/0,
  // no CRS. It is merely the pixel coordinate system encoded as a GeoTIFF
  // transform, not a placement on the ground.
  if (transformation?.length >= 16) {
    const m = Array.from(transformation, Number)
    const near = (a, b = 0) => Number.isFinite(a) && Math.abs(a - b) <= 1e-12
    return near(Math.abs(m[0]), 1)
      && near(Math.abs(m[5]), 1)
      && near(m[1])
      && near(m[4])
      && near(m[3])
      && near(m[7])
      && near(m[12])
      && near(m[13])
      && near(m[14])
      && near(m[15], 1)
  }

  const sx = pixelScale?.[0]
  const sy = pixelScale?.[1]
  // Unit scale (the identity) or a zero/absent scale (no scale at all).
  const unitScale = (Math.abs(sx) === 1 && Math.abs(sy) === 1) || (!sx && !sy)
  if (!unitScale) return false
  // The tiepoint's WORLD half (indices 3,4,5) — a raster placed at the origin.
  const world = [tiepoint?.[3] ?? 0, tiepoint?.[4] ?? 0, tiepoint?.[5] ?? 0]
  return world.every((v) => v === 0)
}

// Does this file's GeoKeyDirectory name an actual CRS? 32767 is "user-defined",
// which names nothing.
function geoKeysDeclareCrs(geoKeys) {
  if (!geoKeys) return false
  const proj = geoKeys.ProjectedCSTypeGeoKey
  const geog = geoKeys.GeographicTypeGeoKey
  const real = (c) => c != null && c !== 0 && c !== 32767
  return real(proj) || real(geog)
}

export async function probeTiffGeoTags(blob) {
  try {
    const tiff = await openTiff(blob)
    const image = await tiff.getImage()
    const fd = image.getFileDirectory()
    const tiepoint = await readTiffTag(fd, 'ModelTiepoint')
    const pixelScale = await readTiffTag(fd, 'ModelPixelScale')
    const hasTiepoint = !!tiepoint?.length
    const hasPixelScale = !!pixelScale?.length
    const transformation = await readTiffTag(fd, 'ModelTransformation')
    const hasTransformation = !!transformation?.length
    // getGeoKeys is an accessor method, so it resolves the deferred field itself.
    const hasCrs = geoKeysDeclareCrs(image.getGeoKeys?.())
    const degenerate = (hasTransformation || (hasTiepoint && hasPixelScale))
      && isDegenerateGeoTransform({
        pixelScale,
        tiepoint,
        transformation,
        hasCrs,
      })
    return {
      georeferenced: !degenerate && ((hasTiepoint && hasPixelScale) || hasTransformation),
      hasTiepoint,
      hasPixelScale,
      hasTransformation,
      hasCrs,
      degenerate,
      error: null,
    }
  } catch (err) {
    return {
      georeferenced: false,
      hasTiepoint: false,
      hasPixelScale: false,
      hasTransformation: false,
      hasCrs: false,
      degenerate: false,
      error: err?.message ?? String(err),
    }
  }
}

// Header-only read: width/height via the IFD, without the expensive full
// pixel decode (readRGB, below) — lets callers show real dimensions near-
// instantly while the slow decode+encode still runs in the background.
export async function readTiffDimensions(blob) {
  const tiff = await openTiff(blob)
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
      const dec = await decoder(blob)               // { width, height, rgba: Uint8Array(RGBA), bitsPerSample, samplesPerPixel, stretch }
      width = dec.width
      height = dec.height
      rgba = dec.rgba instanceof Uint8ClampedArray ? dec.rgba : new Uint8ClampedArray(dec.rgba.buffer, dec.rgba.byteOffset, dec.rgba.byteLength)
      if (dec.bitsPerSample) srcInfo.bitsPerSample = dec.bitsPerSample
      if (dec.samplesPerPixel) srcInfo.samplesPerPixel = dec.samplesPerPixel
      if (dec.stretch) srcInfo.stretch = dec.stretch
      timings.backend = 'wasm'
      timings.decodeMs = performance.now() - t0
      timings.repackMs = 0
    } catch {
      // fall through to geotiff below
    }
  }

  if (!rgba) {
    const tiff = await openTiff(blob)
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

    // 16-bit gray / RGB(A): stretch between the 0.5 / 99.5 % levels instead of letting
    // readRGB cut to the high byte — the same mapping as the wasm decoder
    // (core/io/tonalStretch.js; parity pinned on both sides).
    const sampleFormat = await readTiffTag(fd, 'SampleFormat')
    const isUint = sampleFormat == null || (Array.isArray(sampleFormat) ? sampleFormat[0] : sampleFormat) === 1
    if (srcInfo.bitsPerSample === 16 && isUint && [0, 1, 2].includes(srcInfo.photometric)
        && [1, 2, 3, 4].includes(srcInfo.samplesPerPixel)) {
      const samples = await image.readRasters({ interleave: true })
      timings.decodeMs = performance.now() - t0
      const tRepack = performance.now()
      const range = percentileRange(samples, srcInfo.samplesPerPixel)
      rgba = stretch16ToRgba(samples, width, height, srcInfo.samplesPerPixel, range,
        { invert: srcInfo.photometric === 0 && srcInfo.samplesPerPixel <= 2 })
      srcInfo.stretch = range
      timings.repackMs = performance.now() - tRepack
    } else {
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
