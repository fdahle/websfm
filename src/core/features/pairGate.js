// Pure pairwise-match acceptance decision, extracted from useMatchesStore.matchPair
// so the gate can be unit-tested in isolation (plain data in, verdict out — no Vue /
// OPFS / worker). Given a geometric-verification result (F-RANSAC inliers + H/F
// degeneracy count) and the positional-spread summary, classify a pair as:
//
//   'accept' — strong geometry. Drives everything: the rotation-cycle filter, init-pair
//              selection, and fresh triangulation of scene structure.
//   'weak'   — a valid fundamental matrix with enough inliers to constrain a pose, but
//              below the ratio / absolute accept gate. COLMAP-style registration
//              fallback: usable ONLY to feed 2D-3D correspondences into PnP (register.js
//              collectCorrespondences); never to seed init or triangulate new points.
//              This keeps a bridge pair (e.g. a 227-inlier film chain link that falls
//              under a user-raised minMatches of 500) in the graph instead of severing it.
//   'reject' — no model, positional collapse (many-to-one / epipole degeneracy), or too
//              few inliers even for the weak floor. Never used downstream.
//
// The decision knobs (minMatches, minInlierRatio, overrideInliers, hfDegenerateRatio,
// minInlierUniqueFrac, minInlierSpreadPx, weakMinInliers) all come from the caller's
// merged settings (defaults.user.js + tuning.js) — no defaults duplicated here.

export function evaluatePairAcceptance({ result, rawCount, spread, settings }) {
  const {
    minMatches,
    minInlierRatio,
    overrideInliers,
    hfDegenerateRatio,
    minInlierUniqueFrac,
    minInlierSpreadPx,
    weakMinInliers,
  } = settings

  const inlierCount = result?.inlierCount ?? 0
  const ratio = result ? inlierCount / Math.max(1, rawCount) : 0
  const ratioOk = ratio >= minInlierRatio
  // R5 absolute-inlier override: a solid RANSAC fit with dozens of inliers is real
  // geometry even below the ratio floor (a medium-overlap façade bridge), not the
  // ~12/100 spurious fit the ratio gate targets.
  const overrode = !ratioOk && result != null && inlierCount >= overrideInliers

  // H-vs-F degeneracy: when a homography captures nearly as many inliers as the
  // fundamental matrix, the scene is planar / the motion a pure rotation — such pairs
  // still bridge the graph but make poor SfM seeds. A quality label, not a rejection.
  const hInlierCount = result?.hInlierCount ?? 0
  const hfRatio = result && inlierCount > 0 ? hInlierCount / inlierCount : 0
  const degenerate = result != null && hfRatio >= hfDegenerateRatio

  // Positional-degeneracy reject (core/features/verify.js inlierSpread): enough inliers,
  // clears every count/ratio/H-F gate, yet the inlier positions collapse in one image —
  // many-to-one convergence (unique spots ≪ inliers) or epipole degeneracy (all inliers
  // in a pinhead region). Neither is real geometry, so it is a HARD reject — never weak.
  let spreadDegenerate = false
  if (spread && spread.count >= minMatches) {
    const collapsed = Math.min(spread.uniqueA, spread.uniqueB) < minInlierUniqueFrac * spread.count
    const tiny = Math.min(spread.extentA, spread.extentB) < minInlierSpreadPx
    spreadDegenerate = collapsed || tiny
  }

  const strong = result != null && inlierCount >= minMatches && (ratioOk || overrode) && !spreadDegenerate

  let classification
  let reason = null
  if (strong) {
    classification = 'accept'
  } else if (!result) {
    classification = 'reject'
    reason = 'no fundamental matrix could be fit'
  } else if (spreadDegenerate) {
    classification = 'reject'
    reason = `inliers collapse positionally — ${inlierCount} inliers map to only `
      + `${spread.uniqueA}/${spread.uniqueB} unique spots (A/B), extent ${spread.extentA.toFixed(0)}/`
      + `${spread.extentB.toFixed(0)}px — many-to-one / epipole degeneracy, not real geometry`
  } else if (inlierCount >= weakMinInliers) {
    // Valid F, enough inliers to constrain PnP, but failed the accept gate → weak.
    classification = 'weak'
    reason = inlierCount < minMatches
      ? `only ${inlierCount} inliers — below the ${minMatches} absolute floor `
        + `(ratio ${ratio.toFixed(2)} cleared its ${minInlierRatio} gate); kept as a weak bridge for PnP`
      : `inlier ratio ${ratio.toFixed(2)} below gate ${minInlierRatio} and ${inlierCount} < `
        + `${overrideInliers} override; kept as a weak bridge for PnP`
  } else {
    classification = 'reject'
    reason = `only ${inlierCount} inliers — below the ${weakMinInliers} weak-pair floor `
      + `(ratio ${ratio.toFixed(2)}); likely false match on repetitive structure`
  }

  return {
    classification,
    accept: classification === 'accept',
    weak: classification === 'weak',
    ratio,
    hfRatio,
    hInlierCount,
    degenerate,
    spreadDegenerate,
    overrode,
    inlierCount,
    reason,
  }
}
