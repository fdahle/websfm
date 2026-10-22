// What each step of Build Dense Cloud does to this project (DenseModal.vue): the
// one-line effects under its numbered steps, with Auto's thresholds as fusion picks
// them (core/dense/fusionPlan.js: minViews = min(2, maps − 1), the default cost gate).
import { DENSE_FUSE_DEFAULTS } from '../defaults.user.js'
import { plural } from './format.js'

export function denseEffects(s, { maps = 0 } = {}) {
  const sample = !maps
    ? 'Compute depth maps first: the dense cloud is fused from them.'
    : s.step > 1
      ? `Every ${s.step}th pixel of the ${plural(maps, 'depth map')}, across and down, is a candidate point ` +
        `(about 1 in ${s.step * s.step}).`
      : `Every pixel of the ${plural(maps, 'depth map')} is a candidate point: the densest cloud.`

  const minViews = s.auto ? Math.max(1, Math.min(2, maps - 1)) : s.minViews
  const maxCost = s.auto ? DENSE_FUSE_DEFAULTS.maxCost : s.maxCost
  const views = s.auto && !maps ? '2 other depth maps (1 when there are only two)' : plural(minViews, 'other depth map')
  const agree =
    `A point is kept where at least ${views} put the same surface within ${s.depthTolPct} % of its depth, ` +
    `from pixels matched at a cost of ${maxCost} or less${s.auto ? ' (Auto)' : ''}.`

  const tri =
    s.minTriAngleDeg > 0 ? `Points whose agreeing views are less than ${s.minTriAngleDeg}° apart are dropped` : ''
  const inc =
    s.maxIncidenceDeg > 0 && s.maxIncidenceDeg < 90
      ? `points seen more than ${s.maxIncidenceDeg}° off their surface's normal`
      : ''
  const gates =
    tri && inc
      ? `${tri}, and so are ${inc}.`
      : tri
        ? `${tri}; no incidence gate.`
        : inc
          ? `No triangulation-angle gate; ${inc} are dropped.`
          : 'Off: neither the triangulation angle nor the incidence angle drops a point.'

  const isolated = s.removeIsolated
    ? 'Lone points with too few neighbours, left over from fusion, are removed.'
    : 'Off: lone points stay in the cloud.'
  return { sample, agree, gates, isolated }
}
