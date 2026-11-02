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

// The effect line of step 5, Repair a split graph, with Detect gaps again at full size.
//   small: the SIFT images detected at under tuning.gapMaxScale of their size
//   ({ images, scale: their median detection scale, nativeMax: the largest native side })
//   run: { lightglue, selection } — the run never detects gaps again with LightGlue or
//   on a selection (stores/matching/matchAll.js ▸ gapPossible)
export function repairEffect(
  s,
  tuning = MATCH_TUNING,
  small = { images: 0 },
  { lightglue = false, selection = false } = {},
) {
  if (s.repairSplits === false)
    return 'Off: a block that matching leaves in pieces stays in pieces, and SfM can only place them apart.'
  const repair =
    `If matching leaves the block in pieces, or a piece hangs on it by a few weak pairs, up to ` +
    `${tuning.bridgePerComponent} pairs between each piece and the main block (${tuning.bridgeMaxPairs} in all) are ` +
    `matched again with looser gates; F-RANSAC still verifies them.`
  let gap
  if (s.gapRedetect === false) gap = 'Pieces still apart then keep the features they were detected with.'
  else if (lightglue)
    gap = 'With LightGlue, pieces still apart keep their features: only brute-force matching detects them again.'
  else if (selection)
    gap = 'A run on a selection never detects its images again: pieces still apart keep their features.'
  else if (!small.images)
    gap = 'Every image was detected at full size or by a learned detector: nothing to detect again.'
  else
    gap =
      `Pieces still apart then are detected again at full size (${plural(small.images, 'image')} were detected at ` +
      `${small.scale.toFixed(2)}× of up to ${small.nativeMax.toLocaleString('en-US')} px), with about ` +
      `${Math.round(100 * tuning.gapPartnerShare)} % as many images of the main block, and their pairs matched again.`
  return `${repair} ${gap}`
}

// The images Detect gaps again at full size could act on (repairEffect's `small`).
//   images: [{ kpStatus, detector?, detectScale?, meta: { width, height } }]
export function smallDetection(images, tuning = MATCH_TUNING) {
  const small = images.filter(
    (im) => im.kpStatus === 'done' && (im.detector ?? 'sift') === 'sift' && (im.detectScale ?? 1) < tuning.gapMaxScale,
  )
  if (!small.length) return { images: 0, scale: null, nativeMax: 0 }
  const scales = small.map((im) => im.detectScale).sort((a, b) => a - b)
  return {
    images: small.length,
    scale: scales[scales.length >> 1],
    nativeMax: Math.max(...small.map((im) => Math.max(im.meta?.width || 0, im.meta?.height || 0))),
  }
}
