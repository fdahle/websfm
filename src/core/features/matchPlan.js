// What a matching run will do, for MatchFeaturesModal's live readout. Pure; mirrors
// the decisions useMatchesStore.matchAll makes once the pairs are built, so the modal
// can say *before* the run which settings are going to matter.

import { sequentialPairs } from './sequentialPairs.js'
import { MATCH_TUNING } from '../tuning.js'

/**
 * How many image pairs a strategy produces for `n` images with keypoints.
 * Returns `{ count, exact }` — preselection keeps each image's nearest cameras, so
 * only an upper bound is known before the positions are read (`exact: false`); a
 * footprint preselection depends on the polygons and returns `count: null`.
 */
export function estimatePairCount(
  n,
  {
    strategy = 'exhaustive',
    sequentialOverlap = 10,
    sequentialLoopClosure = false,
    preselectMethod = 'position',
    maxNeighbors = 10,
  } = {},
) {
  const all = n > 1 ? (n * (n - 1)) / 2 : 0
  if (strategy === 'sequential') {
    // The real builder over placeholders: O(n·overlap), and exactly the run's count.
    const count = sequentialPairs(
      Array.from({ length: n }, (_, i) => i),
      { overlap: sequentialOverlap, loopClosure: sequentialLoopClosure },
    ).length
    return { count, exact: true }
  }
  if (strategy === 'preselect') {
    if (preselectMethod === 'footprint') return { count: null, exact: false }
    return { count: Math.min(all, n * Math.max(1, maxNeighbors)), exact: false }
  }
  return { count: all, exact: true }
}

/**
 * Whether the brute-force subset gate will run, and if not, why — the same two
 * run-level bypasses useMatchesStore.matchAll applies (an overlap prefilter already
 * chose the pairs; too few pairs for the saving to exist). `reason` is UI text.
 */
export function subsetGateStatus({
  matcher = 'bruteforce',
  strategy = 'exhaustive',
  subsetGate = true,
  pairCount = null,
} = {}) {
  if (matcher === 'lightglue') return { active: false, reason: 'LightGlue matches every pair in full.' }
  if (!subsetGate) return { active: false, reason: null }
  if (strategy === 'sequential') {
    return {
      active: false,
      reason:
        'Not used with Sequential pairing: capture order has already chosen overlapping pairs, and a false veto would break the chain.',
    }
  }
  if (strategy === 'preselect') {
    return {
      active: false,
      reason: 'Not used with Preselect: camera positions or footprints have already chosen overlapping pairs.',
    }
  }
  const minPairs = MATCH_TUNING.subsetGateMinPairs
  if (pairCount != null && pairCount < minPairs) {
    return {
      active: false,
      reason: `Not used for ${pairCount} pair${pairCount === 1 ? '' : 's'} (fewer than ${minPairs}): matching them in full is cheap.`,
    }
  }
  return { active: true, reason: null }
}
