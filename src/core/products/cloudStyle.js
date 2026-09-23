import { RAMPS } from './colormap.js'

const LABELS = {
  intensity: 'Intensity', classification: 'Classification', returnNumber: 'Return number',
  numberOfReturns: 'Number of returns', scanAngle: 'Scan angle (°)', pointSourceId: 'Point source ID',
  userData: 'User data', synthetic: 'Synthetic', keyPoint: 'Key point', withheld: 'Withheld',
  overlap: 'Overlap', scannerChannel: 'Scanner channel', gpsTime: 'GPS time', nir: 'Near infrared',
  scanDirection: 'Scan direction', edgeOfFlightLine: 'Edge of flight line',
}
const CLASSES = {
  0: ['Never classified', '#a7adb6'], 1: ['Unclassified', '#b8bcc4'], 2: ['Ground', '#b88d58'],
  3: ['Low vegetation', '#acd984'], 4: ['Medium vegetation', '#67ad65'], 5: ['High vegetation', '#327c48'],
  6: ['Building', '#d96858'], 7: ['Low noise', '#eb4ded'], 8: ['Reserved / model key point', '#cdbaff'],
  9: ['Water', '#4ca6de'], 10: ['Rail', '#a29aaa'], 11: ['Road surface', '#707985'],
  12: ['Reserved / overlap', '#e3b5e9'], 13: ['Wire guard', '#e4da72'], 14: ['Wire conductor', '#eab540'],
  15: ['Transmission tower', '#c883db'], 16: ['Wire connector', '#e4a586'], 17: ['Bridge deck', '#c47b57'],
  18: ['High noise', '#fd59af'], 19: ['Overhead structure', '#78bdc4'], 20: ['Ignored ground', '#ad9279'],
  21: ['Snow', '#d9ecf2'], 22: ['Temporal exclusion', '#ce9aab'],
}
export const countOf = cloud => cloud?.nVerts ?? cloud?.count ?? cloud?.points?.length ?? 0
export const hasRgb = cloud => !!cloud?.col || !!cloud?.points?.some(p => p.color)
export function styleFields(cloud) {
  return [
    ...(hasRgb(cloud) ? [{ value: 'rgb', label: 'RGB' }] : []),
    { value: 'single', label: 'Single colour' },
    { value: 'elevation', label: 'Elevation (Z)' }, { value: 'x', label: 'X coordinate' }, { value: 'y', label: 'Y coordinate' },
    ...Object.keys(cloud?.attributes || {}).map(name => ({ value: `attribute:${name}`, label: LABELS[name] || name })),
  ]
}
export function resolveCloudStyle(cloud, input = cloud?.style || {}) {
  const field = styleFields(cloud).some(f => f.value === input.field) ? input.field : (hasRgb(cloud) ? 'rgb' : 'single')
  return { field, colour: /^#[a-f\d]{6}$/i.test(input.colour) ? input.colour : '#44aaff',
    opacity: Number.isFinite(input.opacity) ? Math.max(0, Math.min(1, input.opacity)) : 1,
    ramp: Object.hasOwn(RAMPS, input.ramp) ? input.ramp : 'viridis',
    range: ['manual', 'local'].includes(input.range) ? input.range : 'auto', min: input.min ?? 0, max: input.max ?? 1,
    classes: input.classes || {} }
}
export function scalarAt(cloud, field) {
  if (field.startsWith('attribute:')) {
    const values = cloud.attributes?.[field.slice(10)]
    return i => values?.[i] ?? NaN
  }
  const axis = field === 'x' ? 0 : field === 'y' ? 1 : 2
  const key = ['x', 'y', 'z'][axis]
  return cloud.pos ? i => cloud.pos[i * 3 + axis] : i => cloud.points[i][key]
}
export function scalarRange(cloud, field) {
  const at = scalarAt(cloud, field)
  let min = Infinity, max = -Infinity
  for (let i = 0, n = countOf(cloud); i < n; i++) {
    const v = at(i)
    if (Number.isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v) }
  }
  return min === Infinity ? { min: 0, max: 1 } : { min, max }
}

// Automatic elevation uses one absolute Z scale across all participating clouds,
// including hidden ones, so a visibility toggle cannot change a height's colour.
// Other fields (e.g. intensity from different sensors) retain per-cloud ranges.
export function sharedElevationRange(clouds, rangeFor = scalarRange) {
  let min = Infinity, max = -Infinity
  for (const cloud of clouds) {
    const style = resolveCloudStyle(cloud)
    if (style.field !== 'elevation' || style.range !== 'auto' || !countOf(cloud)) continue
    const range = rangeFor(cloud, 'elevation')
    min = Math.min(min, range.min); max = Math.max(max, range.max)
  }
  return min === Infinity ? null : { min, max }
}
export function classEntries(cloud, style = {}) {
  const counts = new Map()
  for (const value of cloud.attributes?.classification || []) {
    if (Number.isFinite(value)) counts.set(value, (counts.get(value) || 0) + 1)
  }
  return [...counts].sort((a, b) => a[0] - b[0]).map(([value, count]) => {
    const [label, colour] = CLASSES[value] || [`Class ${value}`, '#9b8dc4']
    const override = style.classes?.[value]
    return { value, count, label, colour: /^#[a-f\d]{6}$/i.test(override?.colour) ? override.colour : colour,
      visible: override?.visible !== false }
  })
}
const rgb = hex => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16))
export function rampCss(name) {
  const ramp = RAMPS[name] || RAMPS.viridis
  return `linear-gradient(90deg, ${Array.from({ length: 9 }, (_, i) => `rgb(${ramp(i / 8).join(',')})`).join(',')})`
}

// GPU colours are disposable display data: the original RGB and attributes are
// never overwritten. A draw index hides classes without copying coordinates.
export function buildCloudStyle(cloud, input, { elevationRange = null } = {}) {
  const style = resolveCloudStyle(cloud, input)
  const n = countOf(cloud)
  const label = styleFields(cloud).find(f => f.value === style.field)?.label
  const legend = { field: style.field, label, colour: style.colour, opacity: style.opacity }
  if (style.field === 'single') return { style, colors: null, indices: null, legend }
  if (style.field === 'rgb') {
    let colors = cloud.col
    if (!colors) {
      colors = new Uint8Array(n * 3)
      for (let i = 0; i < n; i++) colors.set(cloud.points[i].color || [68, 170, 255], i * 3)
    }
    return { style, colors, indices: null, legend }
  }
  const colors = new Uint8Array(n * 3)
  const at = scalarAt(cloud, style.field)
  let indices = null
  if (style.field === 'attribute:classification') {
    const entries = classEntries(cloud, style)
    const palette = new Map(entries.map(e => [e.value, rgb(e.colour)]))
    const hidden = new Set(entries.filter(e => !e.visible).map(e => e.value))
    if (hidden.size && cloud.kind !== 'mesh') indices = new Uint32Array(n)
    let kept = 0
    for (let i = 0; i < n; i++) {
      const value = at(i)
      colors.set(palette.get(value) || [160, 160, 160], i * 3)
      if (indices && !hidden.has(value)) indices[kept++] = i
    }
    if (indices) indices = indices.subarray(0, kept)
    legend.entries = entries
  } else {
    const range = style.range === 'manual' && Number.isFinite(style.min) && Number.isFinite(style.max) && style.max > style.min
      ? { min: style.min, max: style.max }
      : style.field === 'elevation' && style.range === 'auto' && elevationRange
        ? elevationRange : scalarRange(cloud, style.field)
    const span = range.max - range.min || 1
    const palette = Array.from({ length: 256 }, (_, i) => RAMPS[style.ramp](i / 255))
    for (let i = 0; i < n; i++) {
      const value = at(i)
      const index = Math.max(0, Math.min(255, Math.round((value - range.min) / span * 255)))
      colors.set(Number.isFinite(value) ? palette[index] : [160, 160, 160], i * 3)
    }
    Object.assign(legend, range, { ramp: style.ramp })
  }
  return { style, colors, indices, legend }
}

// Merge only equivalent encodings. Different ramps/ranges or conflicting class
// colours need separate legends, even when their field names match.
export function groupCloudLegends(layers) {
  const groups = []
  for (const layer of layers) {
    const legend = layer.legend
    if (!legend || legend.field === 'rgb' || legend.opacity === 0) continue
    const entries = legend.entries?.filter(entry => entry.visible)
    if (entries && !entries.length) continue
    let group
    if (legend.ramp) {
      group = groups.find(g => g.legend.field === legend.field && g.legend.ramp === legend.ramp
        && g.legend.min === legend.min && g.legend.max === legend.max)
    } else if (entries) {
      group = groups.find(g => g.legend.field === legend.field && g.legend.entries
        && entries.every(e => !g.legend.entries.some(other => other.value === e.value
          && (other.colour !== e.colour || other.label !== e.label))))
    }
    if (!group) {
      group = { id: layer.id, names: [], legend: { ...legend, ...(entries ? { entries: [] } : {}) } }
      groups.push(group)
    }
    group.names.push(layer.name)
    if (entries) {
      for (const entry of entries) if (!group.legend.entries.some(e => e.value === entry.value)) group.legend.entries.push({ ...entry })
      group.legend.entries.sort((a, b) => a.value - b.value)
    }
  }
  return groups
}
