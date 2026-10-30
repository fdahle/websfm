// What the steps of Detect and Match Features do to this project
// (MatchFeaturesModal.vue). The split-graph repair and Match only new pairs are here so
// far; the other steps' lines are still computed in the dialog.
import { MATCH_TUNING } from '../tuning.js'
import { plural } from './format.js'

// Match only new pairs starts on when the project has matched pairs and images with
// features that are in none of them: photos added since the last run.
//   project: { matchedPairs, unpairedImages }
export const onlyNewPairsDefault = ({ matchedPairs = 0, unpairedImages = 0 } = {}) =>
  matchedPairs > 0 && unpairedImages > 0

// Step 1 when the run is limited to a selection (the sidebar's Match features…): the
// pairs with one of the `k` selected images among the `n` with keypoints.
export function selectionPairsEffect(strategy, { k = 0, n = 0 } = {}) {
  if (!k) return 'None of the selected images has keypoints: detect them first.'
  if (strategy === 'exhaustive') {
    const pairs = k * (n - k) + (k * (k - 1)) / 2
    return `${plural(k, 'selected image')} with every other image: ${plural(pairs, 'pair')}.`
  }
  return `${plural(k, 'selected image')}: of the pairs the ${strategy === 'sequential' ? 'capture order' : 'preselection'} chooses, those with one of them.`
}

// What step 1 adds to its pair count when matched pairs exist.
export function onlyNewPairsEffect(s, { matchedPairs = 0, unpairedImages = 0 } = {}) {
  if (!matchedPairs) return ''
  const added = unpairedImages ? ` (${plural(unpairedImages, 'image')} in no pair yet)` : ''
  return s.onlyNewPairs
    ? `The ${plural(matchedPairs, 'pair')} already matched keep their result; only the others are matched${added}.`
    : `The ${plural(matchedPairs, 'pair')} already matched are matched again${added}.`
}

// The effect line of step 5, Repair a split graph.
export function repairEffect(s, tuning = MATCH_TUNING) {
  if (s.repairSplits === false)
    return 'Off: a block that matching leaves in pieces stays in pieces, and SfM can only place them apart.'
  return (
    `If matching leaves the block in pieces, up to ${tuning.bridgePerComponent} pairs between each piece and the ` +
    `main block (${tuning.bridgeMaxPairs} in all) are matched again with looser gates; F-RANSAC still verifies them.`
  )
}
