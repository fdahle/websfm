import { ensureProjection, transform } from '../core/crs.js'
import { polygonAreaTest } from '../core/products/vectorLayers.js'

// A cell test for a DEM: inside every given polygon layer (useFootprintsStore sets; null
// entries skipped), as (x, y) in the DEM's CRS → bool. Layers are stored in the project
// CRS `crs`; the DEM may be in another one. null when no layer is given. Used by Quality
// Report ▸ DEM vs reference and Co-register DEM (stable ground, an area of interest).
export async function demLayerTest(dem, layers, crs) {
  const tests = []
  for (const set of layers) {
    if (!set) continue
    if (!dem.crs || dem.crs === 'local') throw new Error('Limiting the comparison to a layer needs a DEM in a CRS')
    let polygons = set.footprints.map((f) => f.rings)
    if (crs && dem.crs !== crs) {
      await Promise.all([ensureProjection(crs), ensureProjection(dem.crs)])
      polygons = polygons.map((rings) => rings.map((ring) => ring.map((p) => transform(p, crs, dem.crs))))
    }
    tests.push(polygonAreaTest(polygons))
  }
  return tests.length ? (x, y) => tests.every((t) => t(x, y)) : null
}
