// Stationary-match filter (Metashape's "filter stationary points"): drop putative
// matches whose keypoint sits at (almost) the same pixel position in both images.
//
// A real scene point moves between two views by the baseline's parallax, while a
// feature fixed to the camera or the scanner does not move at all: film fiducials,
// the frame edge and data strip, reseau crosses (KH-9 mapping camera), dust on the
// scanner platen, a lens blemish. Matched across every pair, such features agree
// with ANY epipolar geometry that keeps the image centre fixed and drag pairs toward
// the identity — Casa Grande's raw 1978 scans, unmasked, accepted 665 of 666 pairs.
//
// The tolerance is a fraction of the image diagonal: a scan offset of a few pixels
// between two scans of the same frame still counts as stationary, a genuine
// near-duplicate view (a burst, a hover) loses its matches too — which costs nothing,
// since such a pair carries no parallax.
//
// Pure: keypoint sets (`x(i)`, `y(i)` accessors) and `[{ ia, ib }]` matches in.

/**
 * @param {{x:(i:number)=>number, y:(i:number)=>number}} kpsA
 * @param {{x:(i:number)=>number, y:(i:number)=>number}} kpsB
 * @param {Array<{ia:number, ib:number}>} matches
 * @param {{tolPx:number}} opts  displacement at or below which a match is stationary
 * @returns {{matches: Array, dropped: number}}
 */
export function filterStationaryMatches(kpsA, kpsB, matches, { tolPx }) {
  if (!(tolPx > 0) || !matches?.length) return { matches: matches ?? [], dropped: 0 }
  const t2 = tolPx * tolPx
  const kept = []
  for (const m of matches) {
    const dx = kpsA.x(m.ia) - kpsB.x(m.ib),
      dy = kpsA.y(m.ia) - kpsB.y(m.ib)
    if (dx * dx + dy * dy > t2) kept.push(m)
  }
  return { matches: kept, dropped: matches.length - kept.length }
}

/** Tolerance in pixels from a percentage of the image diagonal. */
export function stationaryTolPx(width, height, pct) {
  return pct > 0 && width > 0 && height > 0 ? (pct / 100) * Math.hypot(width, height) : 0
}
