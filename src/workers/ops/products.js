// Product ops (DEM, orthophoto, raster tools) as one op table for the compute worker:
// dem.js, ortho.js and rasterTools.js; their shared helpers are productsShared.js.
// Pure compute is in core/products/*.

import { makeDemOps } from './dem.js'
import { makeOrthoOps } from './ortho.js'
import { makeRasterToolOps } from './rasterTools.js'

// `rasterize` (injected) decodes the ortho's source photos.
export function makeProductsOps({ rasterize } = {}) {
  return { ...makeDemOps(), ...makeOrthoOps({ rasterize }), ...makeRasterToolOps() }
}
