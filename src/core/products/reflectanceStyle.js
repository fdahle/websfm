// The style a reflectance map opens with (Reference Data ▸ Style bands…), from its band
// names: NDVI where it has NIR and red, else true colour, else its first band in grey.
import { bandForRole, indexBands } from '../io/rasterStyle.js'

export function reflectanceStyle(names) {
  const ndvi = indexBands(names, 'ndvi')
  if (ndvi) return { mode: 'index', index: 'ndvi', ...ndvi, ramp: 'rdylgn' }
  const [r, g, b] = ['Red', 'Green', 'Blue'].map((role) => bandForRole(names, role))
  if (r >= 0 && g >= 0 && b >= 0) return { mode: 'rgb', bandR: r, bandG: g, bandB: b, stretch: 'percentile' }
  return names?.length ? { mode: 'gray', band: 0, stretch: 'percentile' } : null
}
