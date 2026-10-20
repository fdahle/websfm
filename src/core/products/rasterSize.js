// The size of the raster a DEM or ortho run builds — pure, shared by the products
// worker (which builds it) and the DEM / Orthophoto dialogs (which show it before the
// run), so the readout and the run cannot drift apart.
//
// Every grid here is the cells covering a frame box at a cell size `gsd`: the longer
// side is ceil(span / gsd) + 1 cells (surface.js gridGeometry, dem.js demGeometry). A
// size given as the long side in pixels (`longSide`) is the cell size that makes the
// longer side exactly that many cells.

import { gridGeometry, resampledGeometry } from './surface.js'
import { planDemWindow, demCogLevels } from './demWindow.js'

// An auto DEM fits one plane of this many cells a side; a GSD (or size) the user
// chose past it is built block by block into a GeoTIFF (SAT-3), whose plane is then
// its overview of at most this many cells.
export const DEM_PLANE_MAX = 4096
// The longest side any computed raster may have (the block builders' grid cap). Past
// 4 GiB the stored GeoTIFF is a BigTIFF (geotiff.js assembleCog), so size is bounded by
// this side, not by the file format.
export const MAX_RASTER_SIDE = 65535
export const ORTHO_TILE = 512
export const DEM_TILE = 512
// Bytes per cell of the stored rasters: RGBA 8-bit for the ortho, Float32 heights.
export const ORTHO_BYTES_PER_CELL = 4
export const DEM_BYTES_PER_CELL = 4

/** The cell size whose grid over a box spanning `spanMax` on its longer side is
 *  `longSide` cells long; 0 when either is not usable. */
export function gsdForLongSide(spanMax, longSide) {
  return longSide > 1 && spanMax > 0 ? spanMax / (longSide - 1) : 0
}

/** The cell size a run asks for: `gsd` when set, else the one `longSide` implies over
 *  a box spanning `spanMax`, else 0 (auto). */
export function requestedGsd({ gsd = 0, longSide = 0 } = {}, spanMax) {
  if (gsd > 0) return gsd
  return gsdForLongSide(spanMax, longSide)
}

/** The ortho grid over a surface grid ({ width, height, gsd, originX, originY }) for the
 *  run's `gsd` / `longSide` (0 = the surface's own cells), capped at MAX_RASTER_SIDE.
 *  → { geom (resampledGeometry), want, coarsened } | null; `want` is the cell size asked
 *  for (0 = auto), `coarsened` when the side cap grew it. */
export function orthoGridFor(surface, settings = {}) {
  if (!surface) return null
  const want = requestedGsd(settings, Math.max(surface.width, surface.height) * surface.gsd)
  const geom = resampledGeometry(surface, want, MAX_RASTER_SIDE)
  if (!geom) return null
  return { geom, want, coarsened: want > 0 && geom.gsd > want * (1 + 1e-9) }
}

/** The DEM surface an ortho reads: the DEM's own plane, or for a block-built DEM the
 *  finest GeoTIFF level the memory budget allows (the worker's readDemGrid: a fifth of
 *  a fifth of the budget in cells). `dem`: the record. → a grid geometry | null */
export function orthoDemSurface(dem, budgetBytes) {
  if (!dem) return null
  if (!dem.cog) return dem.width > 0 ? { width: dem.width, height: dem.height, gsd: dem.gsd, originX: dem.originX, originY: dem.originY } : null
  const plan = planDemWindow(dem, demCogLevels(dem.fullWidth, dem.fullHeight, dem.tileSize ?? DEM_TILE), null,
    Math.floor(budgetBytes / 5 / 5))
  return plan && { width: plan.width, height: plan.height, gsd: plan.gsd, originX: plan.originX, originY: plan.originY }
}

/** The DEM grid over a frame box `box` ({ minX, minY, maxX, maxY }, the extent of the
 *  points that go in) holding `count` points, as the DEM worker builds it: auto ≈ one
 *  point per cell in one plane of ≤ DEM_PLANE_MAX; a chosen cell size or long side past
 *  that plane builds blocks, capped at MAX_RASTER_SIDE.
 *  → { geom: { width, height, gsd, originX, originY }, blocks, coarsened, requestedGsd } | null */
export function demGridFor(box, count, settings = {}) {
  if (!box || !(box.maxX > box.minX) || !(box.maxY > box.minY)) return null
  const spanMax = Math.max(box.maxX - box.minX, box.maxY - box.minY)
  const chosen = requestedGsd(settings, spanMax)
  const auto = Math.sqrt(((box.maxX - box.minX) * (box.maxY - box.minY)) / Math.max(1, count))
  const gsd0 = chosen > 0 ? chosen : auto
  const at = (gsd, maxGrid) => gridGeometry(box.minX, box.minY, box.maxX, box.maxY, gsd, maxGrid)
  if (chosen > 0) {
    const full = at(gsd0, MAX_RASTER_SIDE)
    if (full && Math.max(full.width, full.height) > DEM_PLANE_MAX) {
      return { geom: full, blocks: true, coarsened: full.gsd > gsd0 * (1 + 1e-9), requestedGsd: gsd0 }
    }
  }
  const geom = at(gsd0, DEM_PLANE_MAX)
  return geom && { geom, blocks: false, coarsened: geom.gsd > gsd0 * (1 + 1e-9), requestedGsd: gsd0 }
}

/** The stored size of a raster grid, uncompressed. */
export const rasterBytes = (geom, bytesPerCell) => geom.width * geom.height * bytesPerCell
