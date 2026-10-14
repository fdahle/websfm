// The 2D map's projected grid: which lines to draw for a view, and how to label
// them. Pure — components/viewers/map/mapGridLayer.js turns the result into
// OpenLayers features once per rendered frame.
//
// `ol/layer/Graticule` is hardcoded to EPSG:4326 meridians and parallels — it
// draws *geographic* lines whatever the view projection is, and there is no
// option to switch it to the view's units. On EPSG:3031 that means lines
// converging on the pole: useful for knowing where you are, useless for reading
// a distance off the map. So for a projected CRS the map draws this grid instead —
// straight lines at round intervals in the view's own units (10 km squares over
// Antarctica).

import { buffer, getIntersection, isEmpty as extentIsEmpty } from 'ol/extent'

// Desired on-screen gap between grid lines. Full coordinates are wide labels
// ("E -1,300,000 m" ≈ 85 px at 11 px type), so the spacing has to clear one.
export const GRID_TARGET_PX = 150
export const GRID_MAX_LINES = 400  // per axis; a stale resolution can't hang the renderer

/** Round spacing (1/2/5 × 10ⁿ) no smaller than `target` map units. */
export function niceGridSpacing(target) {
  if (!(target > 0)) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(target)))
  const norm = target / pow
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow
}

// Labels are the **full projected coordinate** in the CRS's own units, the number
// you would type into a GCP row — for Adelaide Island on EPSG:3031 that is
// "E -1,300,000 m", not "-1,300 km". Abbreviating to km reads as a *distance from
// somewhere*, which is exactly what a projected easting/northing is not; and near
// the projection origin it degenerates to "0 km / 200 km" whatever the CRS.
// Decimals only appear if the spacing is sub-metre (a metre grid never needs them).
export function formatGridLabel(v, spacing, axis, units) {
  const dec = spacing >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(spacing)))
  const num = v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
  return `${axis} ${num} ${units}`
}

/**
 * Label suffix: the frame's own unit if it names one (the model frame), else the
 * projection's. OL reports 'm' for metric projections, 'ft'/'us-ft' for the
 * handful in feet; coordinates are printed in that unit as-is, never rescaled.
 */
export function gridUnitFor(info, olUnits) {
  return info.gridUnit ?? (olUnits === 'us-ft' ? 'ft' : (olUnits || 'm'))
}

/** Identity of a rendered view: an unchanged key means the grid is still current. */
export function gridViewKey(center, resolution, size) {
  return `${center[0]}|${center[1]}|${resolution}|${size[0]}x${size[1]}`
}

/**
 * The grid for one view: `viewExtent` is the visible extent, `validExtent` the
 * CRS validity area (or null). Returns null when nothing is left to draw, else
 * `{ bounds, spacing, xs, ys, labelX, labelY }` — the vertical lines at `xs` and
 * horizontal ones at `ys` span `bounds`; the x labels sit at `labelY`, the y labels
 * at `labelX`.
 *
 * The generation area is the view plus a 10 % buffer: the grid is regenerated every
 * frame while the map moves, so the buffer only has to cover one frame's motion.
 * Labels ride the edge of the *visible* viewport, not the buffered area —
 * anchoring them to the buffer parks them off-screen, and the grid then reads as
 * unlabelled at anything but the widest zoom.
 */
export function computeGrid({ viewExtent, resolution, size, validExtent }) {
  let bounds = buffer(viewExtent, Math.max(size[0], size[1]) * resolution * 0.1)
  // Stop at the CRS validity edge — beyond it the coordinates aren't meaningful.
  if (validExtent) bounds = getIntersection(bounds, validExtent)
  if (extentIsEmpty(bounds)) return null

  const spacing = niceGridSpacing(resolution * GRID_TARGET_PX)
  const labelX = Math.max(viewExtent[0], bounds[0]) + resolution * 2
  const labelY = Math.max(viewExtent[1], bounds[1]) + resolution * 2

  // Accumulated (not start + i·spacing) so the values match what was always drawn.
  const xs = []
  let n = 0
  // `+ 0` folds the -0 that ceil of a small negative gives, so the origin line
  // reads "E 0 m", not "E -0 m".
  for (let x = Math.ceil(bounds[0] / spacing) * spacing + 0; x <= bounds[2] && n < GRID_MAX_LINES; x += spacing, n++) xs.push(x)
  const ys = []
  n = 0
  for (let y = Math.ceil(bounds[1] / spacing) * spacing + 0; y <= bounds[3] && n < GRID_MAX_LINES; y += spacing, n++) ys.push(y)

  return { bounds, spacing, xs, ys, labelX, labelY }
}
