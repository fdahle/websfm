// Terrain derivatives of a DEM — slope, aspect and hillshade as exportable data
// rasters. Pure, no Vue/Pinia/OPFS/DOM.
//
// All three share one 3×3 gradient: Horn's (1981) weighted finite difference,
// the estimator GDAL's `gdaldem slope|aspect|hillshade` uses. For the window
//
//      a b c        row r−1 (north)
//      d e f        row r
//      g h i        row r+1 (south)
//
//   ∂z/∂x (east)  = ((c + 2f + i) − (a + 2d + g)) / (8·Δx)
//   ∂z/∂y (north) = ((a + 2b + c) − (g + 2h + i)) / (8·Δy)
//
// Row 0 is north, so +row is SOUTH: the north gradient is top-minus-bottom.
// That sign is the whole difference between a correct aspect and one mirrored
// north↔south, and it is pinned by a test.
//
// Units. Grid E/N spacing in a projected CRS is the ground distance times the
// point scale factor k (CLAUDE.md ▸ CRS / GCP / poses), so the true horizontal
// spacing is Δx = Δy = gsd / k; heights are never scaled by k. `zFactor`
// converts height units into horizontal units (e.g. 0.3048 for feet over
// metres) and multiplies the gradient. k = zFactor = 1 is the identity.
//
// Nodata (non-finite, mask 0, or equal to `grid.nodata`) follows GDAL's
// `-compute_edges`: a missing or off-grid neighbour is replaced by the centre
// value, so border and hole-edge cells still get a (one-sided) estimate; a
// nodata centre is nodata in every product. This module is the exportable
// product — colormap.js `hillshadeRgba` stays the cheap preview and is not
// meant to agree with it pixel for pixel.

const DEG = 180 / Math.PI
const RAD = Math.PI / 180

export const TERRAIN_PRODUCTS = ['slope', 'aspect', 'hillshade']

function checkGrid(grid) {
  const { width, height, data, gsd } = grid || {}
  if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) {
    throw new Error('terrain: grid needs positive integer width/height')
  }
  if (!data || data.length < width * height) throw new Error('terrain: grid.data is shorter than width·height')
  if (!(gsd > 0) || !Number.isFinite(gsd)) throw new Error('terrain: grid.gsd must be a positive number')
}

function checkPositive(name, v) {
  if (!(v > 0) || !Number.isFinite(v)) throw new Error(`terrain: ${name} must be a positive number`)
}

// Shape shared by every output raster: same geometry as the input DEM.
function outGrid(grid, data, mask) {
  return { width: grid.width, height: grid.height, gsd: grid.gsd, originX: grid.originX, originY: grid.originY, data, mask }
}

// Walk every cell once, handing `visit(i, p, q)` the Horn gradient — p = ∂z/∂x
// (east), q = ∂z/∂y (north), both dimensionless rise/run in true horizontal
// units with zFactor applied — or `visit(i, NaN, NaN)` for a nodata centre.
// Callback-based so no per-cell gradient arrays are ever materialised.
function hornGradient(grid, k, zFactor, visit) {
  const { width: w, height: h, data, mask } = grid
  const nodata = grid.nodata
  const hasNodata = typeof nodata === 'number' && Number.isFinite(nodata)
  const valid = (i) => (!mask || mask[i] !== 0) && Number.isFinite(data[i]) && !(hasNodata && data[i] === nodata)
  // Δz per true horizontal unit: zFactor·Δz / (8·gsd/k).
  const s = (zFactor * k) / (8 * grid.gsd)
  // Neighbour height, or the centre value when it is off-grid / nodata.
  const at = (c, r, z) => {
    if (c < 0 || r < 0 || c >= w || r >= h) return z
    const i = r * w + c
    return valid(i) ? data[i] : z
  }
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c
      if (!valid(i)) { visit(i, NaN, NaN); continue }
      const z = data[i]
      const a = at(c - 1, r - 1, z), b = at(c, r - 1, z), cc = at(c + 1, r - 1, z)
      const d = at(c - 1, r, z), f = at(c + 1, r, z)
      const g = at(c - 1, r + 1, z), hh = at(c, r + 1, z), ii = at(c + 1, r + 1, z)
      const p = ((cc + 2 * f + ii) - (a + 2 * d + g)) * s
      const q = ((a + 2 * b + cc) - (g + 2 * hh + ii)) * s
      visit(i, p, q)
    }
  }
}

// Lambertian illumination of the surface with gradient (p, q) by a sun at
// azimuth (radians, clockwise from north) and altitude (radians):
//   n = (−p, −q, 1)/√(1+p²+q²),  L = (sin A·cos H, cos A·cos H, sin H)
// Negative (self-shadowed) values are returned as-is; callers clamp.
function illumination(p, q, sinA, cosA, sinH, cosH) {
  return (sinH - (p * sinA + q * cosA) * cosH) / Math.sqrt(1 + p * p + q * q)
}

// GDAL's byte encoding: 0 is reserved for nodata, so a lit value maps to 1..255.
function shadeByte(cang) {
  if (!(cang > 0)) return 1
  const v = Math.round(1 + 254 * cang)
  return v > 255 ? 255 : v
}

// GDAL `-multidirectional` (Mark 1992, USGS OF 92-422): four suns at 225/270/
// 315/360°, each weighted by cos²(angle between its azimuth and the gradient
// direction) — i.e. (ĝ·û)² — so a slope is lit mostly along its fall line. Over
// four axes 45° apart the weights sum to 2·|g|², which GDAL folds into a 0.5
// (its "127"); a flat cell gets sin(altitude) from every sun.
const MULTI_AZ = [225, 270, 315, 360].map(a => ({ s: Math.sin(a * RAD), c: Math.cos(a * RAD) }))
function multiIllumination(p, q, sinH, cosH) {
  const g2 = p * p + q * q
  if (g2 === 0) return sinH
  let acc = 0
  for (const az of MULTI_AZ) {
    const proj = p * az.s + q * az.c
    const shade = illumination(p, q, az.s, az.c, sinH, cosH)
    if (shade > 0) acc += proj * proj * shade
  }
  return acc / (2 * g2)
}

/**
 * Compute any subset of slope / aspect / hillshade in ONE pass over the DEM.
 *
 * grid: { width, height, data: Float32Array (row 0 = north), mask?, gsd, originX, originY, nodata? }
 * opts:
 *   products        — subset of ['slope','aspect','hillshade'] (default all three)
 *   k               — point scale factor of the projected CRS (true spacing = gsd/k)
 *   zFactor         — height units → horizontal units (default 1)
 *   units           — slope: 'degrees' (default) | 'percent' (100·rise/run)
 *   flatValue       — aspect value where the gradient is flat (default −1)
 *   flatSlope       — rise/run at or below which aspect is "flat" (default 0, as GDAL)
 *   azimuth/altitude— hillshade sun, degrees (default 315 / 45)
 *   multidirectional— hillshade: GDAL -multidirectional weighting (default false)
 *   onLog           — optional (message, level, source) hook
 * → { slope?, aspect?, hillshade? }, each { width, height, gsd, originX, originY,
 *   data, mask:Uint8Array (1 = valid) }. slope/aspect data are Float32Array with
 *   NaN at nodata; hillshade data is Uint8Array, 1..255 lit, 0 at nodata.
 */
export function terrainProducts(grid, opts = {}) {
  const {
    products = TERRAIN_PRODUCTS, k = 1, zFactor = 1, units = 'degrees',
    flatValue = -1, flatSlope = 0, azimuth = 315, altitude = 45, multidirectional = false, onLog,
  } = opts
  checkGrid(grid)
  checkPositive('k', k)
  checkPositive('zFactor', zFactor)
  for (const p of products) if (!TERRAIN_PRODUCTS.includes(p)) throw new Error(`terrain: unknown product '${p}'`)
  if (units !== 'degrees' && units !== 'percent') throw new Error(`terrain: unknown slope units '${units}'`)

  const n = grid.width * grid.height
  const mask = new Uint8Array(n)
  const want = new Set(products)
  const slopeData = want.has('slope') ? new Float32Array(n) : null
  const aspectData = want.has('aspect') ? new Float32Array(n) : null
  const shadeData = want.has('hillshade') ? new Uint8Array(n) : null
  const percent = units === 'percent'
  const sinA = Math.sin(azimuth * RAD), cosA = Math.cos(azimuth * RAD)
  const sinH = Math.sin(altitude * RAD), cosH = Math.cos(altitude * RAD)

  let valid = 0
  hornGradient(grid, k, zFactor, (i, p, q) => {
    if (Number.isNaN(p)) {
      if (slopeData) slopeData[i] = NaN
      if (aspectData) aspectData[i] = NaN
      return // hillshade stays 0, mask stays 0
    }
    mask[i] = 1; valid++
    const tan = Math.hypot(p, q)
    if (slopeData) slopeData[i] = percent ? 100 * tan : Math.atan(tan) * DEG
    if (aspectData) {
      if (tan <= flatSlope) aspectData[i] = flatValue
      else {
        // Downhill direction (−p, −q) in (east, north), as a compass bearing.
        const a = Math.atan2(-p, -q) * DEG
        aspectData[i] = a < 0 ? a + 360 : a + 0 // + 0 turns −0 into 0
      }
    }
    if (shadeData) {
      shadeData[i] = shadeByte(multidirectional
        ? multiIllumination(p, q, sinH, cosH)
        : illumination(p, q, sinA, cosA, sinH, cosH))
    }
  })

  const out = {}
  if (slopeData) out.slope = { ...outGrid(grid, slopeData, mask), units }
  if (aspectData) out.aspect = { ...outGrid(grid, aspectData, mask.slice()), flatValue }
  if (shadeData) out.hillshade = outGrid(grid, shadeData, mask.slice())
  onLog?.(
    `Terrain: ${products.join(' + ')} over ${grid.width}×${grid.height} (${valid} valid cells), `
    + `k=${k}, zFactor=${zFactor}, true spacing ${(grid.gsd / k).toPrecision(6)}`
    + (shadeData ? `, sun ${multidirectional ? 'multidirectional' : `az ${azimuth}°`} alt ${altitude}°` : ''),
    'info', 'Products')
  return out
}

/** Slope (Horn). opts: { k = 1, zFactor = 1, units = 'degrees' | 'percent' }. */
export function slope(grid, opts = {}) {
  return terrainProducts(grid, { ...opts, products: ['slope'] }).slope
}

/**
 * Aspect: compass bearing of the DOWNHILL direction, degrees clockwise from
 * north in [0, 360) — a plane rising to the east faces west (270), one rising to
 * the north faces south (180). Flat cells get `flatValue`. Invariant to k and
 * zFactor (both scale the gradient isotropically); they are accepted for symmetry.
 */
export function aspect(grid, opts = {}) {
  return terrainProducts(grid, { ...opts, products: ['aspect'] }).aspect
}

/**
 * Hillshade as GDAL encodes it: 1 + 254·cos(incidence), clamped to 1..255,
 * self-shadowed cells 1, nodata 0 (and mask 0).
 * opts: { k = 1, zFactor = 1, azimuth = 315, altitude = 45, multidirectional = false }.
 */
export function hillshade(grid, opts = {}) {
  return terrainProducts(grid, { ...opts, products: ['hillshade'] }).hillshade
}
