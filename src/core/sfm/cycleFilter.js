import { matMul3, matT3, rotAngleDeg } from './rotations.js'

// ── Rotation-cycle consistency filter (repetitive-structure defense, pure) ────
// A verified pair can still be false: on repetitive structure (a row of near-
// identical façades) RANSAC fits a clean fundamental matrix to the WRONG
// correspondences, yielding a high inlier count but a bogus relative pose. Such a
// pair clears every count/ratio gate. What it CANNOT do is agree with the rest of
// the graph: decompose each pair's essential matrix into a relative rotation R_ij,
// then for every triangle (i,j,k) the cycle R_ik⁻¹·R_jk·R_ij must be ≈ identity.
// A true edge is cycle-consistent in nearly all its triangles; a false edge breaks
// essentially every cycle it sits in, regardless of inlier count. Greedily drop the
// least-consistent edge until every survivor with enough triangles clears the
// support floor. Edges in fewer than `minTriangles` triangles are unjudgeable → kept.
//
// Robustness (else a globally noisy graph mass-executes true edges): rotations
// estimated from few-inlier F fits are themselves noisy, so
//  1. **evidence weighting** — a triangle's verdict counts in proportion to its
//     weakest edge's inlier count (capped), so a 5000-inlier edge is not condemned
//     by triangles whose other edges have 15 inliers;
//  2. **adaptive threshold** — the pass/fail angle is max(cycleErrorDeg, mult ×
//     median triangle cycle error), so a uniformly-noisy graph isn't judged at a
//     fixed 5°; and
//  3. **strong-edge protection** — an edge whose inlier count is above the graph's
//     `strongPercentile` is never dropped unless its *weighted* support is ~0.
//     Auto-disabled when inlier counts don't discriminate (see `strongInlierFloor`).
//
// `edges`: [{ idA, idB, R, inliers }] — R is the relative rotation idA→idB (from
// essential decomposition), `inliers` its F-inlier count (optional; defaults to 1).
// When `inliers` is absent/uniform across the graph, weighting is a no-op (all
// weights equal) and protection self-disables, so the old unweighted behaviour is
// recovered. Pure graph
// reasoning so it can be unit-tested without WASM; the caller (reconstruct) supplies
// R via recoverPose. Returns { drop, summary } where each drop entry is
// { idA, idB, tri, good, ratio, inliers } (idA<idB canonical order) and summary
// carries the effective threshold + counts for a single log line.
export function rotationCycleFilter(edges, opts = {}) {
  const baseErrDeg = opts.cycleErrorDeg ?? 5
  // Ceiling on the adaptive threshold: a genuinely noisy graph should loosen the
  // gate, but the median is not robust to heavy contamination (a tiny graph that is
  // half false pairs would otherwise lift the gate past the false rotations
  // themselves). Beyond ~15° a cycle is inconsistent regardless of noise.
  const maxErrDeg = opts.maxErrorDeg ?? 15
  const minTri = opts.minTriangles ?? 2
  const minSupport = opts.minSupport ?? 0.3
  const weightCap = opts.weightCap ?? 200
  const adaptiveMult = opts.adaptiveMult ?? 2
  const strongPercentile = opts.strongPercentile ?? 0.75
  const strongEscapeSupport = opts.strongEscapeSupport ?? 0.05
  const pk = (a, b) => (a < b ? `${a}--${b}` : `${b}--${a}`)

  // pid → { a, b, R, inliers, active } with a<b, so R (a→b) is canonical min→max.
  const E = new Map()
  for (const e of edges) {
    if (!e.R) continue
    const [a, b] = e.idA < e.idB ? [e.idA, e.idB] : [e.idB, e.idA]
    E.set(pk(a, b), {
      a, b,
      R: e.idA < e.idB ? e.R : matT3(e.R),
      inliers: Math.max(1, e.inliers ?? 1),
      active: true,
    })
  }

  // Inlier count above which an edge is "strong" and shielded from dropping.
  // Protection only makes sense when the counts actually discriminate: if every
  // edge shares the same count (e.g. callers that pass none → all default to 1),
  // a percentile floor would shield *every* edge, silently degrading the filter to
  // near-off. In that degenerate case set the floor to Infinity (protection off).
  const inlierCounts = [...E.values()].map((e) => e.inliers).sort((x, y) => x - y)
  const discriminates = inlierCounts.length > 0 && inlierCounts[0] < inlierCounts[inlierCounts.length - 1]
  const strongInlierFloor = discriminates
    ? inlierCounts[Math.min(inlierCounts.length - 1, Math.floor(strongPercentile * inlierCounts.length))]
    : Infinity

  // Weighted per-edge { tri, good, wTri, wGood } over every triangle in the
  // currently-active graph. Each triangle {i<j<k} is generated exactly once — from
  // its (min,mid) edge, scanning for a common neighbour k>j — then credited to all
  // three of its edges. A triangle's weight is its weakest edge's inlier count,
  // capped, so weak-evidence triangles can't outvote strong edges. `errsOut`, when
  // passed, collects each triangle's raw cycle error (deg) for adaptive thresholding.
  const support = (errDeg, errsOut = null) => {
    const stats = new Map()
    const bump = (pid, ok, w) => {
      const s = stats.get(pid) ?? { tri: 0, good: 0, wTri: 0, wGood: 0 }
      s.tri++; s.wTri += w; if (ok) { s.good++; s.wGood += w }
      stats.set(pid, s)
    }
    const adj = new Map()
    const add = (u, v) => { if (!adj.has(u)) adj.set(u, new Set()); adj.get(u).add(v) }
    for (const e of E.values()) if (e.active) { add(e.a, e.b); add(e.b, e.a) }
    for (const e of E.values()) {
      if (!e.active) continue
      const i = e.a, j = e.b // i<j
      const ni = adj.get(i), nj = adj.get(j)
      for (const k of ni) {
        if (k <= j || !nj.has(k)) continue // i<j<k, each triangle once
        const eij = E.get(pk(i, j)), ejk = E.get(pk(j, k)), eik = E.get(pk(i, k))
        const deg = rotAngleDeg(matMul3(matT3(eik.R), matMul3(ejk.R, eij.R)))
        if (errsOut) errsOut.push(deg)
        const ok = deg <= errDeg
        const w = Math.min(weightCap, Math.min(eij.inliers, ejk.inliers, eik.inliers))
        bump(pk(i, j), ok, w); bump(pk(j, k), ok, w); bump(pk(i, k), ok, w)
      }
    }
    return stats
  }

  // Adaptive threshold from the initial (full-graph) triangle error distribution.
  const errs = []
  const initialStats = support(baseErrDeg, errs)
  errs.sort((x, y) => x - y)
  const medErr = errs.length ? errs[Math.floor(errs.length / 2)] : 0
  const effErrDeg = Math.min(maxErrDeg, Math.max(baseErrDeg, adaptiveMult * medErr))

  const drop = []
  // Reuse the initial full-graph pass for the first iteration when the adaptive
  // threshold didn't move (effErrDeg === baseErrDeg) — the stats are identical, so
  // recomputing them is pure waste. Nulled after each drop (the graph changed).
  let stats = effErrDeg === baseErrDeg ? initialStats : null
  while (true) {
    if (!stats) stats = support(effErrDeg)
    let worst = null
    for (const [pid, s] of stats) {
      if (s.tri < minTri) continue
      const ratio = s.wTri > 0 ? s.wGood / s.wTri : (s.good / s.tri)
      if (ratio >= minSupport) continue
      // Shield strong edges: only condemn one whose weighted support is ~0.
      if (E.get(pid).inliers >= strongInlierFloor && ratio >= strongEscapeSupport) continue
      if (!worst || ratio < worst.ratio || (ratio === worst.ratio && s.tri > worst.tri)) {
        worst = { pid, ratio, tri: s.tri, good: s.good }
      }
    }
    if (!worst) break
    const e = E.get(worst.pid)
    e.active = false
    drop.push({ idA: e.a, idB: e.b, tri: worst.tri, good: worst.good, ratio: worst.ratio, inliers: e.inliers })
    stats = null // graph changed — recompute support on the next iteration
  }
  return {
    drop,
    summary: {
      effErrDeg,
      baseErrDeg,
      medianTriErrDeg: medErr,
      triangles: errs.length,
      dropped: drop.length,
      strongInlierFloor,
    },
  }
}
