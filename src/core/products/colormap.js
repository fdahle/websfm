// Shared colour ramps for visualising scalar fields (depth maps, costs, …).
// Pure, no Vue/Pinia/OPFS/DOM/WASM — used by both the compute worker (when it
// bakes generated depth maps to PNG) and ViewerImage.vue (imported depth maps),
// which previously each carried their own copy of the ramp.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Turbo-ish ramp: maps a normalised value t∈[0,1] to [r,g,b] (0..255).
// Smooth blue → cyan → green → yellow → red.
export function depthColor(t) {
  const r = Math.round(255 * clamp(1.5 - Math.abs(4 * t - 3), 0, 1))
  const g = Math.round(255 * clamp(1.5 - Math.abs(4 * t - 2), 0, 1))
  const b = Math.round(255 * clamp(1.5 - Math.abs(4 * t - 1), 0, 1))
  return [r, g, b]
}

// Piecewise-linear ramp through evenly spaced RGB control points.
function lerpRamp(stops, t) {
  const c = clamp(t, 0, 1)
  const span = (c * (stops.length - 1))
  const i = Math.min(stops.length - 2, Math.floor(span))
  const f = span - i
  const a = stops[i], b = stops[i + 1]
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ]
}

// Perceptually-uniform sequential ramp (viridis control points).
export function viridisColor(t) {
  return lerpRamp([[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]], t)
}

// Diverging red→yellow→green. The right default for a normalised-difference
// index, where the SIGN is the message (NDVI < 0 is water, > 0 is vegetation) —
// a sequential ramp hides the zero crossing that carries the meaning.
export function rdYlGnColor(t) {
  return lerpRamp([[165, 0, 38], [253, 174, 97], [255, 255, 191], [166, 217, 106], [26, 152, 80]], t)
}

// Diverging blue→white→red (ColorBrewer RdBu, reversed so red = positive). For a
// signed difference centred on zero — a cloud-to-cloud distance — where white must
// mean "no change"; pair it with a symmetric range.
export function rdBuColor(t) {
  return lerpRamp([[33, 102, 172], [146, 197, 222], [247, 247, 247], [244, 165, 130], [178, 24, 43]], t)
}

export function grayColor(t) {
  const v = Math.round(255 * clamp(t, 0, 1))
  return [v, v, v]
}

// Named ramps for the band-math UI. Keys are what a raster's persisted style
// stores, so they are part of the on-disk shape — rename one and old projects
// silently fall back to the default.
export const RAMPS = {
  rdylgn: rdYlGnColor,
  rdbu: rdBuColor,
  viridis: viridisColor,
  turbo: depthColor,
  gray: grayColor,
}

export function rampByName(name) {
  return RAMPS[name] || RAMPS.rdylgn
}

// Colourise + hillshade an elevation grid into RGBA bytes (nodata → transparent).
// The elevation ramp above, multiplied by a Lambertian hillshade from the height
// gradient, lit from the north-west at 45°.
//
// Shared by the computed-DEM preview (workers/ops/products.js) and the imported
// reference-DEM preview (workers/ops/io.js) — the two previews should look the
// same, and a second copy of this would quietly drift.
//
// grid: { width, height, data, mask?, gsd, zMin, zMax }
//   `mask` (1 = valid) is optional; without it, non-finite values are nodata,
//   which is the shape a float GeoTIFF arrives in.
// → Uint8ClampedArray(width·height·4), ready for `new ImageData(rgba, w, h)`.
export function hillshadeRgba(grid) {
  const { width: w, height: h, data, mask, gsd, zMin, zMax } = grid
  const span = zMax > zMin ? zMax - zMin : 1
  const out = new Uint8ClampedArray(w * h * 4)

  // Light from the north-west, 45° up.
  const lx = -0.7071, ly = 0.7071, lz = 1
  const llen = Math.hypot(lx, ly, lz)
  const valid = mask
    ? (i) => !!mask[i]
    : (i) => Number.isFinite(data[i])
  const at = (c, r) => { const i = r * w + c; return valid(i) ? data[i] : NaN }

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const o = (r * w + c) * 4
      const z = at(c, r)
      if (Number.isNaN(z)) { out[o + 3] = 0; continue }
      const [cr, cg, cb] = depthColor((z - zMin) / span)
      // Central-difference slope (fall back to this cell at borders/holes).
      const zl = at(Math.max(0, c - 1), r), zr = at(Math.min(w - 1, c + 1), r)
      const zt = at(c, Math.max(0, r - 1)), zb = at(c, Math.min(h - 1, r + 1))
      const dzdx = ((Number.isNaN(zr) ? z : zr) - (Number.isNaN(zl) ? z : zl)) / (2 * gsd)
      const dzdy = ((Number.isNaN(zb) ? z : zb) - (Number.isNaN(zt) ? z : zt)) / (2 * gsd)
      const nlen = Math.hypot(dzdx, dzdy, 1)
      const shade = Math.max(0.25, Math.min(1, (-dzdx * lx - dzdy * ly + lz) / (nlen * llen)))
      out[o] = cr * shade; out[o + 1] = cg * shade; out[o + 2] = cb * shade; out[o + 3] = 255
    }
  }
  return out
}
