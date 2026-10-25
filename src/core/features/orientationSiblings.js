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
 * @param {import('./keypoints.js').Keypoints} keypoints  typed (core/features/keypoints.js)
 * @returns {Int32Array|null}
 */
export function siblingCanonicalMap(keypoints) {
  const n = keypoints?.length ?? 0
  if (!n) return null
  // Sorted by (x, y, scale, index), not keyed by a string per keypoint (~9 ms an image
  // on the page's main thread, once per image a matching run loads): equal triples are
  // adjacent, their lowest index first. Numeric equality is the strings' (−0 is "0"),
  // except NaN, which a string matches and a comparison does not: that rare image keeps
  // the string keys.
  const xs = new Float64Array(n),
    ys = new Float64Array(n),
    ss = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const sc = keypoints.scale(i)
    if (!(sc > 0)) return null // no scale (a learned detector, an import) ⇒ not SIFT ⇒ no siblings
    xs[i] = keypoints.x(i)
    ys[i] = keypoints.y(i)
    ss[i] = sc
    // eslint-disable-next-line no-self-compare
    if (xs[i] !== xs[i] || ys[i] !== ys[i]) return siblingCanonicalByString(keypoints)
  }
  const order = new Int32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  order.sort((a, b) => xs[a] - xs[b] || ys[a] - ys[b] || ss[a] - ss[b] || a - b)
  let canon = null,
    head = order[0]
  for (let k = 1; k < n; k++) {
    const i = order[k]
    if (xs[i] === xs[head] && ys[i] === ys[head] && ss[i] === ss[head]) {
      if (!canon) {
        canon = new Int32Array(n)
        for (let j = 0; j < n; j++) canon[j] = j
      }
      canon[i] = head
    } else head = i
  }
  return canon
}

// siblingCanonicalMap by string keys: for an image with a NaN coordinate.
function siblingCanonicalByString(keypoints) {
  const n = keypoints.length
  const firstAt = new Map()
  let canon = null
  for (let i = 0; i < n; i++) {
    const key = `${keypoints.x(i)},${keypoints.y(i)},${keypoints.scale(i)}`
    const first = firstAt.get(key)
    if (first === undefined) {
      firstAt.set(key, i)
      continue
    }
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
