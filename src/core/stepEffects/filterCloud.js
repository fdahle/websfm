// What each step of Filter Cloud does to this project (FilterCloudModal.vue): the
// one-line effects under its numbered steps, in the order core/products/cloudEdit.js
// runs the enabled filters — range, voxel, isolated clusters, statistical outliers.
import { fmtLength } from './format.js'

const span = (lo, hi) => {
  const a = Number.isFinite(lo),
    b = Number.isFinite(hi)
  return a && b ? `${lo} – ${hi}` : a ? `at least ${lo}` : b ? `at most ${hi}` : null
}

// project: { mergeCell } — the dense run's merge cell, 0 when unknown.
export function filterCloudEffects(s, { mergeCell = 0 } = {}) {
  const on = (id) => s.methods.includes(id)
  const z = span(s.zMin, s.zMax)
  const luma = span(s.lumaMin, s.lumaMax)
  const range = !on('range')
    ? 'Off: no elevation or brightness limit.'
    : !z && !luma
      ? 'No limit entered yet: every point passes. Set an elevation or brightness bound.'
      : `Points are kept with ${[z && `elevation ${z}`, luma && `brightness ${luma}`].filter(Boolean).join(' and ')}; the rest are removed.`

  const cell = s.voxelCell > 0 ? s.voxelCell : mergeCell
  const voxel = !on('voxel')
    ? 'Off: the point density is left as it is.'
    : cell > 0
      ? `The cloud is thinned to one averaged point per cell of ${fmtLength(cell, 'units')}` +
        `${s.voxelCell > 0 ? '' : ', the dense run’s merge cell'}.`
      : 'The cloud is thinned to one averaged point per cell of about one point spacing.'

  const isolated = !on('isolated')
    ? 'Off: small detached clusters stay.'
    : `On a grid of ${s.isolatedCell > 0 ? fmtLength(s.isolatedCell, 'units') : 'about 4 point spacings'}, ` +
      `cells holding at most ${s.isolatedMaxSupport} ${s.isolatedMaxSupport === 1 ? 'point' : 'points'} with fewer than ` +
      `${s.isolatedMinNeighbors} occupied neighbours are removed.`

  const sor = !on('sor')
    ? 'Off: no statistical outlier test.'
    : `A point is removed when its mean distance to its ${s.sorK} nearest neighbours is more than ` +
      `${s.sorStdRatio} σ above the cloud’s mean.`
  return { range, voxel, isolated, sor }
}
