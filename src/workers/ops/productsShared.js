// What the product ops (dem.js, ortho.js, rasterTools.js) share: the frame rebuild,
// the product extent, the side cap and reading a block-built DEM back as a grid.

import { frameFromSpec, describeFrame } from '../../core/products/frameSpec.js'
import { coreExtent } from '../../core/products/dem.js'
import { MAX_RASTER_SIDE } from '../../core/products/rasterSize.js'
import { planDemWindow, demCogLevels, maskFromNaN } from '../../core/products/demWindow.js'
import { fromBlob } from 'geotiff'

// The raster sizes (tile sizes, the DEM plane cap, the side cap, the classic-TIFF
// ceiling) are core/products/rasterSize.js, shared with the dialogs' size readout. The
// ortho's preview is at most 2,048 px a side (the viewers draw the tiles for detail).
export const MAX_ORTHO_SIDE = MAX_RASTER_SIDE

// A block-built DEM (SAT-3) read back as a plain height grid: the finest COG level
// whose window of `rect` (frame coords, null = all) holds at most `maxCells` cells
// (core/products/demWindow.js). dem: the record's { cog, originX, originY, fullGsd,
// fullWidth, fullHeight }. → { width, height, gsd, originX, originY, data (Float32,
// NaN = nodata), mask, level } or null when the rectangle misses the DEM.
export async function readDemGrid(dem, rect, maxCells) {
  const plan = planDemWindow(dem, demCogLevels(dem.fullWidth, dem.fullHeight, dem.tileSize ?? 512), rect, maxCells)
  if (!plan) return null
  const tiff = await fromBlob(dem.cog)
  const image = await tiff.getImage(plan.level)
  const [c0, r0, c1, r1] = plan.window
  const [data] = await image.readRasters({ window: [c0, r0, c1, r1], samples: [0], interleave: false })
  const plane = data instanceof Float32Array ? data : Float32Array.from(data)
  return {
    width: plan.width,
    height: plan.height,
    gsd: plan.gsd,
    originX: plan.originX,
    originY: plan.originY,
    data: plane,
    mask: maskFromNaN(plane),
    level: plan.level,
  }
}

// Frames carry closures, so they can't cross postMessage — the store sends a
// spec, the worker resolves it (core/products/frameSpec.js, shared with the
// main thread's map placement). `cameras` is the uuid → { R, t } Map here.
export const rebuildFrame = (spec, cameras, points) =>
  frameFromSpec(spec, cameras ? [...cameras.values()] : [], points ?? [])
export const frameDescriptor = describeFrame

// The product extent (dem.js coreExtent): the cloud's dense footprint unless the
// user asked for every point. Logged with what it leaves out, so a cut is never
// silent. `pos` is interleaved xyz in FRAME coordinates. → bounds | undefined
export function productBounds(pos, count, mode, label, unit, emit) {
  if (mode === 'all') return undefined
  const core = coreExtent(pos, count)
  if (!core) return undefined
  const out = count - core.inside
  const f = (v) => v.toPrecision(4)
  emit('log', [
    `${label}: extent is the cloud's dense core, ${f(core.maxX - core.minX)} × ${f(core.maxY - core.minY)} ${unit}` +
      (out
        ? ` — ${out.toLocaleString()} of ${count.toLocaleString()} points (${((100 * out) / count).toFixed(1)}%) lie outside and are left out; choose Extent ▸ All points to keep them`
        : ''),
    out / count > 0.05 ? 'warn' : 'info',
    'Products',
  ])
  return core
}
