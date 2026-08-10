// Raster resampling into the pinhole frame the whole pipeline computes in. Pure —
// no Vue/Pinia/OPFS/DOM, so the worker and the tests run the same code.
//
// websfm folds distortion out of the *keypoints* once at ingest, so the sparse
// model is already pinhole; the stored image pixels are not. Two consumers need
// the pixels moved to match:
//   • dense MVS  — its reference rasters must live in the sparse cloud's frame;
//   • undistorted image export — the handoff to COLMAP `image_undistorter`
//     consumers (OpenMVS, MVE, MVS-Texturing), which want pinhole images + a
//     PINHOLE camera model.
// Both get the *sample map* from core/sfm/displayFrame.js `makeSampleMap` (one
// composition, one place) and the *resampling* from here.
//
// Direction matters: the map runs output → source (an ideal pinhole pixel → the
// pixel the lens/scanner actually recorded), which is what lets the output grid be
// filled with no gaps. Inverting it per pixel would leave holes.

// Bilinear-sample an RGBA buffer at (x,y), clamping to the edge. Writes 4 bytes
// into `out` at `oi`. Clamping (rather than a border colour) is what makes the
// `validSampleRect` crop the only place border policy is decided.
export function sampleRgbaBilinear(data, w, h, x, y, out, oi) {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x)))
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)))
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1)
  const fx = x - x0, fy = y - y0
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4
  const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4
  for (let c = 0; c < 4; c++) {
    const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx
    const bot = data[i01 + c] * (1 - fx) + data[i11 + c] * fx
    out[oi + c] = top * (1 - fy) + bot * fy
  }
}

// Resample an RGBA source into an ow×oh output grid through `map` (output px →
// source px). A null map means the identity, i.e. the source is already in the
// output frame — returned as-is when the sizes agree, so the common
// no-distortion case costs nothing.
export function resampleRgba(src, map, ow, oh) {
  const { data, width: sw, height: sh } = src
  if (!map && ow === sw && oh === sh) return data
  const out = new Uint8ClampedArray(ow * oh * 4)
  for (let v = 0; v < oh; v++) {
    for (let u = 0; u < ow; u++) {
      const s = map ? map(u, v) : { x: u, y: v }
      sampleRgbaBilinear(data, sw, sh, s.x, s.y, out, (v * ow + u) * 4)
    }
  }
  return out
}

// Same map, nearest sample, for a boolean mask LUT — so a mask built in the
// distorted/scan frame lines up with the now-undistorted raster. Bilinear on a
// boolean would invent half-masked pixels at every edge.
export function resampleMaskLut(lut, sw, sh, map, ow, oh) {
  if (!map && ow === sw && oh === sh) return lut
  const out = new Uint8Array(ow * oh)
  for (let v = 0; v < oh; v++) {
    for (let u = 0; u < ow; u++) {
      const s = map ? map(u, v) : { x: u, y: v }
      const su = Math.max(0, Math.min(sw - 1, Math.round(s.x)))
      const sv = Math.max(0, Math.min(sh - 1, Math.round(s.y)))
      out[v * ow + u] = lut[sv * sw + su]
    }
  }
  return out
}

// The output grid for one image, in its pinhole/canonical frame.
//   • film scan → the sensor's canonical frame (the frame the shared K is defined
//     in; the scan raster's own size is irrelevant and usually much larger);
//   • everything else → the native image size, since distortion removal is a
//     warp within the same frame.
// `scale` shrinks the grid (dense works at a reduced resolution); export uses 1.
export function pinholeFrameSize({ meta = null, fiducial = null, scale = 1 } = {}) {
  const w = fiducial?.frame ? fiducial.frame.width : (meta?.width ?? 0)
  const h = fiducial?.frame ? fiducial.frame.height : (meta?.height ?? 0)
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  }
}

// Largest axis-aligned rectangle of the output grid whose every pixel samples
// *inside* the source — COLMAP `image_undistorter`'s `blank_pixels=0` behaviour.
// Outside it, `sampleRgbaBilinear`'s edge clamp would smear the border pixel
// across the invalid margin, which reads as real image content to a downstream
// matcher.
//
// Shrinks the four edges instead of building a validity mask: a mask over a
// 100 MP scan is 100 MB, and only the border ever decides the answer.
//
// Each pass shrinks **only the worst edge** — the one with the most invalid
// pixels — never all four at once. An invalid *corner* invalidates two edges but
// is fixed by retreating either one, so shrinking both costs a row and a column
// that were otherwise fine; and because shrinking is monotone, that loss can't be
// undone later. Retreating one edge per pass and re-measuring is what makes the
// result the tight inset rather than roughly twice it.
//
// Returns null when nothing is valid.
export function validSampleRect(map, ow, oh, sw, sh, { maxPasses = 100000 } = {}) {
  if (!map) return { x: 0, y: 0, width: ow, height: oh }
  const inside = (u, v) => {
    const s = map(u, v)
    return s.x >= 0 && s.y >= 0 && s.x <= sw - 1 && s.y <= sh - 1
  }
  const rowBad = (v, x0, x1) => { let n = 0; for (let u = x0; u <= x1; u++) if (!inside(u, v)) n++; return n }
  const colBad = (u, y0, y1) => { let n = 0; for (let v = y0; v <= y1; v++) if (!inside(u, v)) n++; return n }

  let x0 = 0, y0 = 0, x1 = ow - 1, y1 = oh - 1
  for (let pass = 0; pass < maxPasses; pass++) {
    if (x1 <= x0 || y1 <= y0) return null
    const bad = [
      rowBad(y0, x0, x1),   // 0: top
      rowBad(y1, x0, x1),   // 1: bottom
      colBad(x0, y0, y1),   // 2: left
      colBad(x1, y0, y1),   // 3: right
    ]
    let worst = 0
    for (let i = 1; i < 4; i++) if (bad[i] > bad[worst]) worst = i
    if (bad[worst] === 0) return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
    if (worst === 0) y0++
    else if (worst === 1) y1--
    else if (worst === 2) x0++
    else x1--
  }
  return null
}

// Cut a rect out of an RGBA buffer. Returns the buffer untouched when the rect is
// the whole image.
export function cropRgba(data, ow, oh, rect) {
  const { x, y, width, height } = rect
  if (x === 0 && y === 0 && width === ow && height === oh) return data
  const out = new Uint8ClampedArray(width * height * 4)
  for (let v = 0; v < height; v++) {
    const srcOff = ((y + v) * ow + x) * 4
    out.set(data.subarray(srcOff, srcOff + width * 4), v * width * 4)
  }
  return out
}

// Cropping moves the image origin, so the principal point moves with it. The
// focal length does not — a crop changes the field of view, not the scale.
export function shiftPrincipalPoint(K, rect) {
  return { fx: K.fx, fy: K.fy, cx: K.cx - rect.x, cy: K.cy - rect.y }
}
