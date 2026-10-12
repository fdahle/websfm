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
 * @param {Array<{views?: Map<string, number>|object}>} points sparse points
 * @returns {Map<string, number>} pairId (`sorted([a,b]).join('--')`) → count
 */
export function usedPairCounts(points) {
  const out = new Map()
  if (!points?.length) return out
  const tracks = points.packedTracks
  if (tracks && tracks.vcount?.length === points.length) {
    // Packed CSR tracks: numeric camera-index keys, no per-observation objects.
    const { viewUuids, vcount, vcam } = tracks
    const nV = viewUuids.length
    const counts = new Map()
    let start = 0
    for (let i = 0; i < vcount.length; i++) {
      const end = start + vcount[i]
      for (let a = start; a < end; a++) {
        const ca = vcam[a]
        for (let b = a + 1; b < end; b++) {
          const cb = vcam[b]
          const key = ca < cb ? ca * nV + cb : cb * nV + ca
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
      }
      start = end
    }
    for (const [key, n] of counts) {
      out.set(pairIdOf(viewUuids[Math.floor(key / nV)], viewUuids[key % nV]), n)
    }
    return out
  }
  // Map-backed points (a COLMAP import, a fresh in-memory result).
  const uuids = []
  for (const pt of points) {
    if (!pt.views || pt.views.size < 2) continue
    uuids.length = 0
    pt.views.forEach((_kp, uuid) => { uuids.push(uuid) })
    for (let a = 0; a < uuids.length; a++) {
      for (let b = a + 1; b < uuids.length; b++) {
        const pid = pairIdOf(uuids[a], uuids[b])
        out.set(pid, (out.get(pid) ?? 0) + 1)
      }
    }
  }
  return out
}

/**
 * The used correspondences of ONE pair as `"kpA:kpB"` keys, A being the image
 * whose uuid sorts first (the pairId order). O(observations).
 * @returns {Set<string>}
 */
export function usedKeysForPair(points, pairId) {
  const keys = new Set()
  const sep = pairId ? pairId.indexOf('--') : -1
  if (!points?.length || sep < 0) return keys
  const ua = pairId.slice(0, sep)
  const ub = pairId.slice(sep + 2)
  for (const pt of points) {
    if (!pt.views || pt.views.size < 2) continue
    const ka = pt.views.get(ua)
    if (ka === undefined) continue
    const kb = pt.views.get(ub)
    if (kb !== undefined) keys.add(`${ka}:${kb}`)
  }
  return keys
}
