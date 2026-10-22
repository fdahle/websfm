// What the steps of Detect and Match Features do to this project
// (MatchFeaturesModal.vue). Only the split-graph repair is here so far; the other
// steps' lines are still computed in the dialog.
import { MATCH_TUNING } from '../tuning.js'

// The effect line of step 5, Repair a split graph.
export function repairEffect(s, tuning = MATCH_TUNING) {
  if (s.repairSplits === false)
    return 'Off: a block that matching leaves in pieces stays in pieces, and SfM can only place them apart.'
  return (
    `If matching leaves the block in pieces, up to ${tuning.bridgePerComponent} pairs between each piece and the ` +
    `main block (${tuning.bridgeMaxPairs} in all) are matched again with looser gates; F-RANSAC still verifies them.`
  )
}
