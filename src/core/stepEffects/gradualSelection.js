// What each step of Sparse gradual selection does (GradualSelectionModal.vue): select
// tie points by a quality criterion, then delete them and re-adjust
// (core/sfm/gradualSelection.js).
import { fmtCount } from './format.js'

const CRITERION = {
  error: (t) => `with a reprojection error above ${t} px`,
  track: (t) => `seen in fewer than ${t} views`,
  angle: (t) => `with a triangulation angle below ${t}°`,
}

// project: { selected (null while the statistics are computed), total, error }
export function gradualSelectionEffects(s, { selected = null, total = 0, error = '' } = {}) {
  const select = error
    ? error
    : selected === null
      ? 'Computing point statistics…'
      : `${fmtCount(selected)} points ${(CRITERION[s.metric] ?? CRITERION.error)(s.threshold)} are selected; ` +
        `${fmtCount(total - selected)} remain.`
  const refine =
    selected && total - selected < 6
      ? 'Too few points would remain: lower the threshold.'
      : 'The selected points are deleted and the model is re-adjusted; a failed refinement keeps the original.'
  return { select, refine }
}
