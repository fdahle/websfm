// What each step of Contour Lines does (ContoursModal.vue): pick the levels, trace
// and shape the lines, then place or download them (core/products/contours.js).
import { fmtCount, plural } from './format.js'

// project: { interval (resolved), levels (count, Infinity when too many), max,
//   zMin, zMax, unit, onMap }
export function contoursEffects(
  s,
  { interval = 0, levels = 0, max = Infinity, zMin = 0, zMax = 0, unit = 'units', onMap = false } = {},
) {
  const z = (v) => Number(v.toPrecision(5))
  const levelsLine =
    levels > max
      ? `That interval gives too many levels (more than ${fmtCount(max)}): use a larger one.`
      : `${plural(levels, 'level')} every ${interval} ${unit}, between ${z(zMin)} and ${z(zMax)} ${unit}` +
        `${s.indexEvery > 1 ? `; one line in ${s.indexEvery} is an index contour` : '; every line is an index contour'}.`
  const shape =
    `${s.smooth > 0 ? `Smoothed with ${plural(s.smooth, 'pass', 'passes')}` : 'Exact grid crossings, not smoothed'}` +
    `${s.minLength > 0 ? `; lines shorter than ${s.minLength} are dropped` : '; no line is dropped for length'}.`
  const fmt = { geojson: 'GeoJSON', dxf: 'DXF' }[s.format]
  const result = onMap
    ? `The lines go on the 2D map as a layer under Products${fmt ? `, and are downloaded as ${fmt}` : ''}.`
    : `This DEM has no coordinate system, so the lines cannot go on the map: they are downloaded as ${fmt ?? 'GeoJSON'}.`
  return { levels: levelsLine, shape, result }
}
