// Ratio-test + mutual-NN selection from per-row / per-column top-2 arrays — the
// part of brute-force matching that is NOT the distance matrix. The WASM crate
// (`crates/matching` `match_descriptors`) does the whole thing internally; the
// WebGPU backend (`workers/gpu/matchGpu.js`) computes only the top-2 arrays on the
// GPU and hands them here, so the decision rule lives in one testable place and
// reproduces the crate's exactly.
//
// Conventions shared with the crate (keep in lockstep):
//   • s-space: the search ranks by s = ‖db‖² − 2·q·db, dropping the per-query
//     constant ‖q‖²; it is added back only for the ratio test and the distance.
//   • Ties: the lowest index wins `best`, and `s2` is the second-smallest value of
//     the multiset (so an exact duplicate of the best IS the second). The crate gets
//     this from an ascending scan with a strict `<`; a merge of partial results gets
//     it from (s, idx) lexicographic order — `mergeTop2` below, and `merge` in
//     match.wgsl.
//   • Ratio: d1 < ratio² · d2 on squared distances, both clamped at 0, all in f32
//     (`Math.fround`), so given the same top-2 arrays the verdicts are bit-identical.
//
// Pure: no DOM/GPU/Vue — runs in the worker and under vitest.

/** f32::MAX — the crate's "no candidate yet" sentinel. */
export const S_SENTINEL = 3.4028234663852886e38

const f = Math.fround

/** Empty top-2 accumulator for `n` queries. */
export function makeTop2(n) {
  return {
    best: new Uint32Array(n),
    s1: new Float32Array(n).fill(S_SENTINEL),
    s2: new Float32Array(n).fill(S_SENTINEL),
  }
}

/**
 * Offer candidate (s, idx) to query `q` — the crate's `Nn2::offer`. Only correct
 * when candidates arrive in ascending idx order (that is what makes strict `<` pick
 * the lowest index); use `mergeTop2` to combine out-of-order partial results.
 */
export function offerTop2(t, q, s, idx) {
  if (s < t.s1[q]) {
    t.s2[q] = t.s1[q]
    t.s1[q] = s
    t.best[q] = idx
  } else if (s < t.s2[q]) {
    t.s2[q] = s
  }
}

/**
 * Merge two partial top-2 results over DISJOINT candidate sets, in any order.
 * best = lexicographic min of (s1, idx); s2 = second-smallest of the multiset
 * union = min(s2a, s2b, max(s1a, s1b)). Returns `{ best, s1, s2 }`.
 */
export function mergeTop2(a, b) {
  const bWins = b.s1 < a.s1 || (b.s1 === a.s1 && b.best < a.best)
  return {
    best: bWins ? b.best : a.best,
    s1: Math.min(a.s1, b.s1),
    s2: Math.min(a.s2, b.s2, Math.max(a.s1, b.s1)),
  }
}

/** Squared descriptor norms, accumulated in f32 in index order like the crate. */
export function descriptorNorms(desc, dim) {
  const n = Math.floor(desc.length / dim)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    const o = i * dim
    for (let k = 0; k < dim; k++) s = f(s + f(desc[o + k] * desc[o + k]))
    out[i] = s
  }
  return out
}

// Per-query ratio verdict: ok flag + true L2 distance of the best candidate.
function ratioVerdict(t, norms, ratioSq) {
  const n = t.best.length
  const ok = new Uint8Array(n)
  const dist = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const d1 = Math.max(0, f(norms[i] + t.s1[i]))
    const d2 = Math.max(0, f(norms[i] + t.s2[i]))
    if (d1 < f(ratioSq * d2)) {
      ok[i] = 1
      dist[i] = f(Math.sqrt(d1))
    }
  }
  return { ok, dist }
}

/**
 * The crate's match decision over precomputed top-2 arrays.
 *
 * @param {object} p
 * @param {{best,s1,s2}} p.rows  A→B top-2 (s = ‖b‖² − 2a·b), length nA
 * @param {{best,s1,s2}|null} p.cols  B→A top-2 (s = ‖a‖² − 2a·b), length nB; required when crossCheck
 * @param {Float32Array} p.normsA
 * @param {Float32Array} p.normsB
 * @param {number} p.ratioThreshold
 * @param {boolean} p.crossCheck
 * @returns {{ matches: Array<{ia,ib,dist}>, count: number }} — same shape as
 *   core/features/bruteforce.js `matchDescriptors`, in ascending `ia` order.
 */
export function selectMatches({ rows, cols, normsA, normsB, ratioThreshold, crossCheck }) {
  const ratioSq = f(f(ratioThreshold) * f(ratioThreshold))
  const fwd = ratioVerdict(rows, normsA, ratioSq)
  let bwd = null
  if (crossCheck) {
    if (!cols) throw new Error('selectMatches: crossCheck needs column top-2')
    bwd = ratioVerdict(cols, normsB, ratioSq)
  }
  const matches = []
  for (let i = 0; i < rows.best.length; i++) {
    if (!fwd.ok[i]) continue
    const j = rows.best[i]
    if (bwd && !(bwd.ok[j] && cols.best[j] === i)) continue
    matches.push({ ia: i, ib: j, dist: fwd.dist[i] })
  }
  return { matches, count: matches.length }
}

/**
 * CPU reference for the top-2 arrays (f32 arithmetic, s-space, ascending scan).
 * Slow — for tests and debugging only; the dot product is a sequential f32 sum, so
 * it agrees with the WASM SIMD kernel up to summation order, not bit for bit.
 */
export function top2Reference(descA, descB, dim, { cols: wantCols = true } = {}) {
  const nA = Math.floor(descA.length / dim)
  const nB = Math.floor(descB.length / dim)
  const normsA = descriptorNorms(descA, dim)
  const normsB = descriptorNorms(descB, dim)
  const rows = makeTop2(nA)
  const cols = wantCols ? makeTop2(nB) : null
  for (let i = 0; i < nA; i++) {
    for (let j = 0; j < nB; j++) {
      let dot = 0
      for (let k = 0; k < dim; k++) dot = f(dot + f(descA[i * dim + k] * descB[j * dim + k]))
      offerTop2(rows, i, f(normsB[j] - f(2 * dot)), j)
    }
  }
  if (cols) {
    // Column side visits rows in ascending order per column — same tie rule.
    for (let i = 0; i < nA; i++) {
      for (let j = 0; j < nB; j++) {
        let dot = 0
        for (let k = 0; k < dim; k++) dot = f(dot + f(descA[i * dim + k] * descB[j * dim + k]))
        offerTop2(cols, j, f(normsA[i] - f(2 * dot)), i)
      }
    }
  }
  return { rows, cols, normsA, normsB }
}

/**
 * GPU-vs-CPU agreement verdict for the first-pair A/B check. Floating-point
 * summation order differs between the backends, so a handful of borderline ratio
 * ties may flip; anything beyond that is a bug.
 *
 * Pass ⇔ |count difference| ≤ max(5, 0.5 % of the larger count) AND the shared
 * (ia, ib) pairs are ≥ 99 % of the larger set. Two empty sets agree.
 */
export function compareMatchSets(cpu, gpu, { minShare = 0.99, countSlackAbs = 5, countSlackRel = 0.005 } = {}) {
  const key = (m) => `${m.ia}:${m.ib}`
  const cpuSet = new Set(cpu.map(key))
  let common = 0
  for (const m of gpu) if (cpuSet.has(key(m))) common++
  const nCpu = cpu.length
  const nGpu = gpu.length
  const larger = Math.max(nCpu, nGpu)
  const share = larger === 0 ? 1 : common / larger
  const countSlack = Math.max(countSlackAbs, Math.ceil(countSlackRel * larger))
  const pass = Math.abs(nCpu - nGpu) <= countSlack && share >= minShare
  return { nCpu, nGpu, common, onlyCpu: nCpu - common, onlyGpu: nGpu - common, share, countSlack, pass }
}
