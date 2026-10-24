// What each step of Transform Cloud does (TransformCloudModal.vue): rotate and scale
// about the pivot, then move (core/products/cloudAlign.js `transformFromEuler`); or
// the pasted matrix as given.

const PIVOT = { centre: 'the cloud’s centre', origin: 'the coordinate origin' }
const num = (v) => (Number.isFinite(v) ? v : 0)

// p: { tx, ty, tz, rx, ry, rz, scale, pivot }; parsed: { error, note } of the matrix.
export function transformCloudEffects(p, { mode = 'params', parsed = {} } = {}) {
  if (mode === 'matrix') {
    const matrix = parsed.error
      ? `Not applied yet: ${parsed.error}`
      : parsed.note || 'Every point is multiplied by the matrix, as given.'
    return { matrix }
  }
  const r = [p.rx, p.ry, p.rz].map(num)
  const turned = r.some((v) => v !== 0)
  const scaled = num(p.scale) !== 1
  const rotate =
    !turned && !scaled
      ? 'No rotation and scale 1: the shape is unchanged.'
      : `${turned ? `Rotated ${r.join('°, ')}° about X, then Y, then Z` : 'Not rotated'}` +
        `${scaled ? `${turned ? ' and' : ','} scaled ${num(p.scale)}×` : ''}, about ${PIVOT[p.pivot] ?? PIVOT.centre}.`
  const t = [p.tx, p.ty, p.tz].map(num)
  const move = t.every((v) => v === 0) ? 'Not moved.' : `Moved by ${t.join(', ')} along X, Y, Z.`
  return { rotate, move }
}
