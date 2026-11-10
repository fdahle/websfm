// What each step of Build Dense Cloud does to this project (DenseModal.vue): the
// one-line effects under its numbered steps, with Auto's thresholds as fusion picks
// them (core/dense/fusionPlan.js: minViews = min(2, maps − 1), the default cost gate),
// and an Auto Point position as the project's scene type resolves it.
import { DENSE_FUSE_DEFAULTS } from '../defaults.user.js'
import { resolveFusePosition } from '../dense/fusionPlan.js'
import { plural } from './format.js'
import { ordinal } from '../textFormat.js'

// The resolved Point position and whether Auto chose it.
function positionOf(s, sceneType) {
  const auto = s.position == null || s.position === 'auto'
  return { mean: resolveFusePosition(s.position, sceneType) === 'mean', auto }
}

export function denseEffects(s, { maps = 0, sceneType = null } = {}) {
  const sample = !maps
    ? 'Compute depth maps first: the dense cloud is fused from them.'
    : s.step > 1
      ? `Every ${ordinal(s.step)} pixel of the ${plural(maps, 'depth map')}, across and down, is a candidate point ` +
        `(about 1 in ${s.step * s.step}).`
      : `Every pixel of the ${plural(maps, 'depth map')} is a candidate point: the densest cloud.`

  const minViews = s.auto ? Math.max(1, Math.min(2, maps - 1)) : s.minViews
  const maxCost = s.auto ? DENSE_FUSE_DEFAULTS.maxCost : s.maxCost
  const views = s.auto && !maps ? '2 other depth maps (1 when there are only two)' : plural(minViews, 'other depth map')
  const agree =
    `A point is kept where at least ${views} put the same surface within ${s.depthTolPct} % of its depth, ` +
    `from pixels matched at a cost of ${maxCost} or less${s.auto ? ' (Auto)' : ''}. ` +
    positionLine(positionOf(s, sceneType), sceneType)

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

// The steps' short facts, for the dialog's step chain (≤ SHORT_MAX characters).
function positionLine({ mean, auto }, sceneType) {
  const why = auto ? ` (Auto, ${sceneType === 'object' ? 'an object capture' : 'an aerial / mapping'} project)` : ''
  return mean
    ? `Each point sits at the mean depth of its own map and the agreeing ones, which evens out their noise${why}.`
    : `Each point keeps its own depth map's depth${why}.`
}

export function denseShorts(s, { maps = 0, sceneType = null } = {}) {
  const minViews = s.auto ? Math.max(1, Math.min(2, maps - 1)) : s.minViews
  return {
    sample: !maps ? 'no depth maps' : s.step > 1 ? `every ${ordinal(s.step)} pixel` : 'every pixel',
    agree: `≥ ${plural(minViews, 'view')} · ${s.depthTolPct} % · ${positionOf(s, sceneType).mean ? 'mean' : 'own depth'}`,
    gates:
      s.minTriAngleDeg > 0 || (s.maxIncidenceDeg > 0 && s.maxIncidenceDeg < 90)
        ? [
            s.minTriAngleDeg > 0 ? `≥ ${s.minTriAngleDeg}° apart` : '',
            s.maxIncidenceDeg > 0 && s.maxIncidenceDeg < 90 ? `≤ ${s.maxIncidenceDeg}° incidence` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : 'off',
    isolated: s.removeIsolated ? 'lone points out' : 'off',
  }
}
