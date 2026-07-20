// Pure DEM-vs-GCP vertical check for Evaluate ▸ DEM vs GCPs (PLAN-eval-views
// step 7). An independent end-to-end accuracy check (DEM height vs surveyed GCP Z),
// not a fit residual — the most valuable number in the tab.
//
// The DEM is a top-left-origin raster (row 0 = max-Y; see core/products/dem.js):
// cell (col,row) centre is at [originX + (col+0.5)·gsd, originY - (row+0.5)·gsd].
// GCPs and DEM are already in the same project CRS — no reprojection here.
// (An *imported* reference DEM is not: it keeps its native CRS and the query
// point is reprojected into raster space at sample time — see useExternalStore.)

import { sampleRaster } from '../io/rasterSample.js'

// dem: { width, height, gsd, originX, originY, data:Float32(NaN=nodata), mask:Uint8 }
// gcps: [{ id, name, x, y, z }]
// → [{ gcpId, name, x, y, demZ, gcpZ, dz }]. demZ null where the GCP is outside the
//   raster or lands on nodata (report as outside/nodata, never as dz 0).
export function sampleDemAtGcps(dem, gcps) {
  return (gcps || []).map((g) => {
    const demZ = sampleDem(dem, g.x, g.y)
    const gcpZ = g.z ?? null
    const dz = (demZ != null && gcpZ != null) ? demZ - gcpZ : null
    return { gcpId: g.id, name: g.name, x: g.x, y: g.y, demZ, gcpZ, dz }
  })
}

// Bilinear sample when all four neighbour cells are unmasked; else nearest cell;
// else null (outside the raster or nodata).
//
// This is a thin adapter over the shared sampler in core/io/rasterSample.js —
// the computed DEM's { gsd, originX, originY } is just a north-up geoTransform
// with scaleY = -gsd. Imported reference rasters go through the same code, so
// there is exactly one bilinear/nodata implementation to get right.
export function sampleDem(dem, x, y) {
  if (!dem) return null
  return sampleRaster(toRasterDesc(dem), x, y)
}

// Computed-DEM shape → the shared raster descriptor. Cached on the DEM object:
// sampleDemAtGcps calls this once per GCP, and rebuilding the wrapper each time
// would allocate per sample for no reason.
export function toRasterDesc(dem) {
  if (dem._rasterDesc) return dem._rasterDesc
  const desc = {
    width: dem.width,
    height: dem.height,
    data: dem.data,
    mask: dem.mask,
    geoTransform: {
      originX: dem.originX,
      originY: dem.originY,
      scaleX: dem.gsd,
      scaleY: -dem.gsd, // row 0 is the northern edge
    },
  }
  try { Object.defineProperty(dem, '_rasterDesc', { value: desc, enumerable: false }) } catch { /* frozen */ }
  return desc
}
