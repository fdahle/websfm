// What each step of Contour Lines does (ContoursModal.vue): pick the levels, trace
// and shape the lines, then place or download them (core/products/contours.js).
import { fmtCount, plural } from './format.js'

// project: { interval (resolved), levels (count, Infinity when too many), max,
//   zMin, zMax, unit, onMap, gsd (the DEM's cell size, for lengths in cells) }
export function contoursEffects(
  s,
  { interval = 0, levels = 0, max = Infinity, zMin = 0, zMax = 0, unit = 'units', onMap = false, gsd = 0 } = {},
) {
  const z = (v) => Number(v.toPrecision(5))
  const levelsLine =
    levels > max
      ? `That interval gives too many levels (more than ${fmtCount(max)}): use a larger one.`
      : `${plural(levels, 'level')} every ${interval} ${unit}, between ${z(zMin)} and ${z(zMax)} ${unit}` +
        `${s.indexEvery > 1 ? `; one line in ${s.indexEvery} is an index contour` : '; every line is an index contour'}.`
  const inUnits = (cells) => (gsd > 0 ? ` (${Number((cells * gsd).toPrecision(3))} ${unit})` : '')
  const shape =
    `${s.generalize > 0 ? `Heights smoothed over about ${s.generalize} cells first, so noise traces no rings; ` : 'Heights traced as they are, noise included; '}` +
    `${s.smooth > 0 ? `lines smoothed with ${plural(s.smooth, 'pass', 'passes')}` : 'exact grid crossings'}` +
    `${s.minCells > 0 ? `; lines shorter than ${plural(s.minCells, 'cell')}${inUnits(s.minCells)} are dropped` : '; no line is dropped for length'}.`
  const fmt = { geojson: 'GeoJSON', dxf: 'DXF' }[s.format]
  const result = onMap
    ? `The lines go on the 2D map as a layer under Products${fmt ? `, and are downloaded as ${fmt}` : ''}.`
    : `This DEM has no coordinate system, so the lines cannot go on the map: they are downloaded as ${fmt ?? 'GeoJSON'}.`
  return { levels: levelsLine, shape, result }
}

// The steps' short facts for Contour Lines' step chain (≤ SHORT_MAX characters).
export function contoursShorts(s, { interval = 0, levels = 0, max = Infinity, unit = 'units', onMap = false } = {}) {
  return {
    levels: levels > max ? 'too many levels' : `${plural(levels, 'level')} · every ${interval} ${unit}`,
    shape: `${s.generalize > 0 ? `σ ${s.generalize}` : 'raw'} · ${plural(s.smooth, 'pass', 'passes')}`,
    result: onMap
      ? `map layer${s.format !== 'none' ? ` + ${s.format === 'dxf' ? 'DXF' : 'GeoJSON'}` : ''}`
      : s.format === 'dxf'
        ? 'DXF'
        : 'GeoJSON',
  }
}
