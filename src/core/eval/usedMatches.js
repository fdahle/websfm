// Which image pairs' matches became tie-points in a sparse model.
//
// A pair of observations on one tie-point is a "used correspondence" of that
// image pair. The sidebar and the match list only need HOW MANY per pair, and a
// keypoint belongs to at most one tie-point (TrackStore's keypoint → point index;
// a COLMAP import gives every observation its own synthetic keypoint), so each
// (kpA, kpB) occurs once per pair and a plain count equals the distinct set's size.
// The per-keypoint keys are only built for the one pair the match preview shows.
//
// This used to build a Set of "kpA:kpB" strings per pair for the whole model on
// every render: O(Σ track_len²) string allocations, tens of seconds on a large
// model at project open.

const pairIdOf = (ua, ub) => (ua < ub ? `${ua}--${ub}` : `${ub}--${ua}`)

/**
 * Per-pair count of used correspondences.
 * @param {import('../sfm/sparsePoints.js').SparsePoints} points sparse points
 * @returns {Map<string, number>} pairId (`sorted([a,b]).join('--')`) → count
 */
export function usedPairCounts(points) {
  const out = new Map()
  if (!points?.length) return out
  // Numeric camera-index keys over the CSR tracks, no per-observation objects.
  const { viewUuids, vstart, vcam } = points
  const nV = viewUuids.length
  const counts = new Map()
  for (let i = 0; i < points.length; i++) {
    const end = vstart[i + 1]
    for (let a = vstart[i]; a < end; a++) {
      const ca = vcam[a]
      for (let b = a + 1; b < end; b++) {
        const cb = vcam[b]
        const key = ca < cb ? ca * nV + cb : cb * nV + ca
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  for (const [key, n] of counts) {
    out.set(pairIdOf(viewUuids[Math.floor(key / nV)], viewUuids[key % nV]), n)
  }
  return out
}

/**
 * The used correspondences of ONE pair as `"kpA:kpB"` keys, A being the image
 * whose uuid sorts first (the pairId order). O(observations of image A).
 * @returns {Set<string>}
 */
export function usedKeysForPair(points, pairId) {
  const keys = new Set()
  const sep = pairId ? pairId.indexOf('--') : -1
  if (!points?.length || sep < 0) return keys
  const ua = pairId.slice(0, sep)
  const ub = pairId.slice(sep + 2)
  points.forEachPointOf(ua, (i, k) => {
    const kb = points.kpOf(i, ub)
    if (kb !== undefined) keys.add(`${points.vkp[k]}:${kb}`)
  })
  return keys
}

/**
 * The sidebar's summary of the match store. `verified` counts the usable pairs: a
 * user-excluded pair is still verified but feeds no reconstruction, and a weak pair
 * (valid F below the accept gate) is a PnP-only bridge, so both are counted apart.
 * `used` is how many of the verified pairs share at least one tie-point in the model
 * (null without one). Not `usedCounts.size`: that is every co-visible image pair, and
 * a track over A, B and C makes A–C co-visible though A–C was never matched, so it
 * could exceed the number of pairs.
 * @param {Map<string, { status: string, inlierCount?: number, enabled?: boolean, weak?: boolean }>} matchStore
 * @param {Map<string, number> | null} usedCounts usedPairCounts of the main model, or null
 * @returns {{ total: number, verified: number, running: number, error: number,
 *   used: number | null, excluded: number, weak: number }}
 */
export function matchPairStats(matchStore, usedCounts) {
  let total = 0
  let verified = 0
  let running = 0
  let error = 0
  let excluded = 0
  let weak = 0
  let used = 0
  for (const [pid, entry] of matchStore) {
    total++
    if (entry.status === 'running') running++
    else if (entry.status === 'error') error++
    else if (entry.status === 'done' && entry.inlierCount > 0) {
      if (entry.enabled === false) excluded++
      else if (entry.weak) weak++
      else {
        verified++
        if (usedCounts?.get(pid) > 0) used++
      }
    }
  }
  return { total, verified, running, error, used: usedCounts ? used : null, excluded, weak }
}
