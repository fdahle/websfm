// What each step of Reduce Overlap does to this project (ReduceOverlapModal.vue): the
// one-line effects under its numbered steps, from core/sfm/reduceOverlap.js, which the
// dialog runs on the current settings (`kept`: null while it counts).
import { plural, fmtCount } from './format.js'

// project: { enabled (photos with a pose, not disabled), disabled (with a pose, already
//            disabled), points (sparse points sampled), kept (of `enabled`) }
export function reduceOverlapEffects(s, { enabled = 0, disabled = 0, points = 0, kept = null } = {}) {
  if (!enabled) {
    const none = 'Build the sparse model first: the photos it places are the ones reduced.'
    return { visibility: none, coverage: none }
  }
  const visibility =
    `${plural(points, 'sparse point')} stand in for the surface; a photo sees one that is in its frame and ` +
    `within ${s.maxAngle}° of the direction the point's own photos see it from.`
  const already = disabled ? ` The ${plural(disabled, 'photo')} already disabled stay so.` : ''
  let coverage
  if (kept == null) coverage = 'Counting…'
  else if (kept >= enabled)
    coverage = `Every one of the ${plural(enabled, 'enabled photo')} is needed for ${plural(s.coverage, 'photo')} per point: none is disabled.${already}`
  else
    coverage =
      `Keeps ${fmtCount(kept)} of the ${plural(enabled, 'enabled photo')}, so every point stays in at least ` +
      `${plural(s.coverage, 'photo')} (or all that see it); ${plural(enabled - kept, 'photo')} are disabled.${already}`
  return { visibility, coverage }
}
