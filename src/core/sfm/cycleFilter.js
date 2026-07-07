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
// `edges`: [{ idA, idB, R }] — R is the relative rotation idA→idB (from essential
// decomposition). Pure graph reasoning so it can be unit-tested without WASM; the
// caller (reconstruct) supplies R via recoverPose. Returns { drop } where each entry
// is { idA, idB, tri, good, ratio } for a removed pair (idA<idB canonical order).
export function rotationCycleFilter(edges, opts = {}) {
  const cycleErrDeg = opts.cycleErrorDeg ?? 5
  const minTri = opts.minTriangles ?? 2
  const minSupport = opts.minSupport ?? 0.3
  const pk = (a, b) => (a < b ? `${a}--${b}` : `${b}--${a}`)

  // pid → { a, b, R, active } with a<b, so R (a→b) is canonical min→max direction.
  const E = new Map()
  for (const e of edges) {
    if (!e.R) continue
    const [a, b] = e.idA < e.idB ? [e.idA, e.idB] : [e.idB, e.idA]
    E.set(pk(a, b), { a, b, R: e.idA < e.idB ? e.R : matT3(e.R), active: true })
  }

  // Per-edge { tri, good } over every triangle in the currently-active graph. Each
  // triangle {i<j<k} is generated exactly once — from its (min,mid) edge, scanning
  // for a common neighbour k>j — then credited to all three of its edges.
  const support = () => {
    const stats = new Map()
    const bump = (pid, ok) => { const s = stats.get(pid) ?? { tri: 0, good: 0 }; s.tri++; if (ok) s.good++; stats.set(pid, s) }
    const adj = new Map()
    const add = (u, v) => { if (!adj.has(u)) adj.set(u, new Set()); adj.get(u).add(v) }
    for (const e of E.values()) if (e.active) { add(e.a, e.b); add(e.b, e.a) }
    for (const e of E.values()) {
      if (!e.active) continue
      const i = e.a, j = e.b // i<j
      const ni = adj.get(i), nj = adj.get(j)
      for (const k of ni) {
        if (k <= j || !nj.has(k)) continue // i<j<k, each triangle once
        const Rij = E.get(pk(i, j)).R, Rjk = E.get(pk(j, k)).R, Rik = E.get(pk(i, k)).R
        const ok = rotAngleDeg(matMul3(matT3(Rik), matMul3(Rjk, Rij))) <= cycleErrDeg
        bump(pk(i, j), ok); bump(pk(j, k), ok); bump(pk(i, k), ok)
      }
    }
    return stats
  }

  const drop = []
  while (true) {
    const stats = support()
    let worst = null
    for (const [pid, s] of stats) {
      if (s.tri < minTri) continue
      const ratio = s.good / s.tri
      if (ratio >= minSupport) continue
      if (!worst || ratio < worst.ratio || (ratio === worst.ratio && s.tri > worst.tri)) {
        worst = { pid, ratio, tri: s.tri, good: s.good }
      }
    }
    if (!worst) break
    const e = E.get(worst.pid)
    e.active = false
    drop.push({ idA: e.a, idB: e.b, tri: worst.tri, good: worst.good, ratio: worst.ratio })
  }
  return { drop }
}
