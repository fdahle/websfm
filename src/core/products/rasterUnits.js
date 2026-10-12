// Units and ground scale of a raster (computed DEM/ortho or imported reference
// raster) — the ONE place every raster readout, measurement and export asks.
//
// Copies of these rules had drifted: the raster tab labelled an imported metric DEM
// "model units", an export computed the point scale factor without the geographic
// guard (a degrees grid has no linear scale, so its k was meaningless), and the
// worker spelled the same label in five places.

import { ensureProjection, isGeographic, linearCrsUnit, metresPerCrsUnit, transform } from '../crs.js'
import { pixelToWorld } from '../io/rasterSample.js'
import { pointScaleFactor } from './localFrame.js'

/** A product/frame `unit` field as a label: 'model' → 'model units'; empty → null. */
export function unitName(unit) {
  if (!unit) return null
  return unit === 'model' ? 'model units' : unit
}

/**
 * Horizontal and vertical unit labels of a raster record. An explicit `unit`
 * (a computed product's frame unit) wins; else a projected CRS's linear unit (an
 * imported raster records only its CRS); else model units. Vertical follows the
 * horizontal unless the record says otherwise — a metre is never assumed.
 * @returns {{ horizontal: string, vertical: string }}
 */
export function rasterUnits(product) {
  const crs = product?.crs
  const horizontal = unitName(product?.unit)
    ?? (crs && crs !== 'local' ? linearCrsUnit(crs) : 'model units')
  return { horizontal, vertical: unitName(product?.verticalUnit) ?? horizontal }
}

/** `m³`, or `m²·ft` when the vertical unit differs. */
export function volumeUnitLabel({ horizontal, vertical }) {
  return vertical === horizontal ? `${horizontal}³` : `${horizontal}²·${vertical}`
}

/**
 * Point scale factor k at the raster's centre: grid lengths are ground lengths × k
 * in a projected CRS (heights are not scaled), so a horizontal length divides by k
 * and an area by k² (localFrame.js, measure.js groundVolume).
 * @param desc a raster descriptor ({ width, height, geoTransform }, rasterSource.js)
 * @returns {Promise<number|null>} 1 for a local/model frame, null for a geographic
 *   CRS (no linear scale — the caller must not measure), else k.
 */
export async function rasterGroundScale(desc, crs) {
  if (!crs || crs === 'local' || !desc) return 1
  await ensureProjection(crs)
  if (isGeographic(crs)) return null
  const c = pixelToWorld(desc, desc.width / 2, desc.height / 2)
  if (!c) return 1
  const k = pointScaleFactor((xy) => transform(xy, crs, 'EPSG:4326'), c.x, c.y,
    { metresPerUnit: metresPerCrsUnit(crs) ?? 1 })
  return k > 0 ? k : 1
}
