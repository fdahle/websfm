// SIFT orientation siblings → one feature per physical point.
//
// With `max_orientations` > 1 the detector (crates/sift) emits, for an extremum whose
// orientation histogram has secondary peaks, one keypoint per orientation at the SAME
// x, y and scale ("siblings") with different descriptors. Matching should see them all
// (that is the point: the other image may describe the feature at either orientation),
// but geometry must not — two indices for one physical point split its track: B can
// match orientation 1 and C orientation 2, and the split-track merge then refuses to
// join them because the union would hold two keypoints of one image.
//
// So right after descriptor matching, each match is re-expressed in canonical indices
// (the first keypoint of each sibling group) and the result deduplicated. Everything
// downstream — verification, the persisted match list, SfM — then works on one index
// per feature, with the evidence of every orientation. Pure; no DOM/worker.

/**
 * canon[i] = the lowest keypoint index with bit-identical x, y and scale as i.
 * Returns null when the image has no siblings (every keypoint is its own canon) —
 * the common case for pre-2026-10 detections and SuperPoint — so callers can skip.
 *
 * @param {{x:number,y:number,scale?:number}[]} keypoints
 * @returns {Int32Array|null}
 */
export function siblingCanonicalMap(keypoints) {
  const n = keypoints?.length ?? 0
  if (!n) return null
  const firstAt = new Map()
  let canon = null
  for (let i = 0; i < n; i++) {
    const k = keypoints[i]
    if (k.scale === undefined) return null // no scale ⇒ not SIFT ⇒ no siblings
    const key = `${k.x},${k.y},${k.scale}`
    const first = firstAt.get(key)
    if (first === undefined) { firstAt.set(key, i); continue }
    if (!canon) {
      canon = new Int32Array(n)
      for (let j = 0; j < n; j++) canon[j] = j
    }
    canon[i] = first
  }
  return canon
}

/**
 * Rewrite putative matches into canonical indices and resolve what that collapses:
 * identical canonical pairs merge into one (the smallest descriptor distance wins);
 * a canonical feature matched to two DIFFERENT features on the other side is
 * ambiguous and all of its matches are dropped (cross-check guaranteed uniqueness per
 * keypoint, not per feature). Order of the survivors follows their first occurrence.
 *
 * @param {{ia:number,ib:number,dist?:number}[]} matches
 * @param {Int32Array|null} canonA
 * @param {Int32Array|null} canonB
 * @returns {{ matches: {ia,ib,dist}[], merged: number, ambiguous: number }}
 */
export function canonicalizeMatches(matches, canonA, canonB) {
  if (!canonA && !canonB) return { matches, merged: 0, ambiguous: 0 }
  const ca = (i) => (canonA ? canonA[i] : i)
  const cb = (i) => (canonB ? canonB[i] : i)
  const byPair = new Map() // "a,b" → index into out
  const out = []
  const partnerOfA = new Map()
  const partnerOfB = new Map()
  const badA = new Set()
  const badB = new Set()
  let merged = 0
  for (const m of matches) {
    const a = ca(m.ia)
    const b = cb(m.ib)
    const key = `${a},${b}`
    const at = byPair.get(key)
    if (at !== undefined) {
      merged++
      if ((m.dist ?? Infinity) < (out[at].dist ?? Infinity)) out[at].dist = m.dist
      continue
    }
    byPair.set(key, out.length)
    out.push({ ia: a, ib: b, dist: m.dist })
    if (partnerOfA.has(a) && partnerOfA.get(a) !== b) badA.add(a)
    else partnerOfA.set(a, b)
    if (partnerOfB.has(b) && partnerOfB.get(b) !== a) badB.add(b)
    else partnerOfB.set(b, a)
  }
  if (!badA.size && !badB.size) return { matches: out, merged, ambiguous: 0 }
  const kept = out.filter((m) => !badA.has(m.ia) && !badB.has(m.ib))
  return { matches: kept, merged, ambiguous: out.length - kept.length }
}
