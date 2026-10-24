// What each step of Clip to Polygon does (ClipRasterModal.vue): the polygon, then the
// clipped GeoTIFF (core/products/rasterClip.js).
import { plural } from './format.js'

// project: { product ('dem' | 'ortho'), mode ('measurement' | 'file'), measurement
//   (its name, or null), polygons (count) }
export function clipRasterEffects(s, { product = 'dem', mode = 'measurement', measurement = null, polygons = 0 } = {}) {
  const polygon = !polygons
    ? mode === 'file'
      ? 'Choose a GeoJSON file with a polygon in the product’s coordinates.'
      : 'No saved area measurement on this product yet: draw one with Measure ▸ Area and save it.'
    : mode === 'file'
      ? `${plural(polygons, 'polygon')} from the file.`
      : `The area of measurement "${measurement}".`
  const outside = product === 'ortho' ? 'transparent' : 'nodata'
  const save =
    `One GeoTIFF cropped to the polygon, every pixel outside it ${outside}, ` +
    `${s.compression === 'none' ? 'uncompressed' : 'DEFLATE-compressed'}.`
  return { polygon, save }
}
