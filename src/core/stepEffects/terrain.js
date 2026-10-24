// What each step of Slope, Aspect, Hillshade does (TerrainModal.vue): one GeoTIFF
// per product from Horn's 3 × 3 gradient on the DEM's grid (core/products/terrain.js).
import { plural } from './format.js'

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']
const from = (az) => COMPASS[Math.round((((az % 360) + 360) % 360) / 45) % 8]

export function terrainEffects(s) {
  const on = (id) => s.products.includes(id)
  const slope = on('slope')
    ? `Steepness of every cell, in ${s.slopeUnits === 'percent' ? 'percent (rise / run × 100)' : 'degrees'}.`
    : 'Off.'
  const aspect = on('aspect') ? 'The direction each cell faces, in degrees clockwise from north.' : 'Off.'
  const hillshade = !on('hillshade')
    ? 'Off.'
    : s.multidirectional
      ? `Shaded by four suns ${s.altitude}° high, blended, so no slope disappears into shadow.`
      : `Shaded by a sun from ${s.azimuth}° (${from(s.azimuth)}), ${s.altitude}° above the horizon.`
  const n = s.products.length
  const save = n
    ? `${plural(n, 'GeoTIFF')} on the DEM’s grid and CRS, ${s.compression === 'none' ? 'uncompressed' : 'DEFLATE-compressed'}.`
    : 'Pick at least one raster.'
  return { slope, aspect, hillshade, save }
}
