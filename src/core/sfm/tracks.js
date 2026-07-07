import { makeP34flat } from './reconstruction.js'
import { projectWithDepth } from './geometry.js'

// ── Retriangulation + track merging (A3, pure) ───────────────────────────────
// Standard COLMAP-style post-BA structure recovery, factored out of `reconstruct`
// so it's testable in isolation. Shared signature:
//   points3d : [{ x, y, z, views: Map<uuid,kpIdx> }]
//   cameras  : Map<uuid, { R, t, K }>
//   pairs    : verified match pairs [{ idA, idB, matches: [[iaKp, ibKp], …] }]
//   keypointOf(uuid, kpIdx) → { x, y } | null
//   maxReprojPx : reprojection gate (px)
//
// toNorm / camToP34flat / reprojErr live here (rather than in the orchestrator)
// because retriangulatePairs consumes them; sfm.js imports them back for its own
// use, keeping the dependency one-directional (sfm.js → tracks.js).

// Convert pixel coord to normalised (K^-1 applied).
export function toNorm(px, py, K) {
  return { x: (px - K.cx) / K.fx, y: (py - K.cy) / K.fy }
}

// Build flat P34 for a camera in *normalised* image coords (no K).
export function camToP34flat(cam) {
  return makeP34flat(cam.R, cam.t)
}

export const reprojErr = (cam, x, y, z, kp) => {
  const p = projectWithDepth(cam, x, y, z) // null when behind the camera
  return p ? Math.hypot(p.u - kp.x, p.v - kp.y) : Infinity
}

// uuid → Map<kpIdx, point> reverse index over a track list.
function buildViewIndex(points3d) {
  const index = new Map()
  for (const pt of points3d) {
    for (const [uuid, kp] of pt.views) {
      let m = index.get(uuid)
      if (!m) { m = new Map(); index.set(uuid, m) }
      m.set(kp, pt)
    }
  }
  return index
}

// Retriangulate matches whose *both* keypoints are still unassigned, using the
// current (post-BA) poses. Adds a point when it's in front of both cameras and
// reprojects ≤ gate in both. `triangulate(nA, nB, PA, PB)` is injected (WASM DLT
// in production). Mutates + returns `points3d`; returns { added }.
export async function retriangulatePairs({ points3d, cameras, pairs, keypointOf, maxReprojPx, triangulate }) {
  const index = buildViewIndex(points3d)
  const addIndexed = (pt, uuid, kp) => {
    pt.views.set(uuid, kp)
    let m = index.get(uuid); if (!m) { m = new Map(); index.set(uuid, m) }
    m.set(kp, pt)
  }
  let added = 0
  for (const e of pairs) {
    const camA = cameras.get(e.idA), camB = cameras.get(e.idB)
    if (!camA || !camB) continue // both endpoints must be registered
    const idxA = index.get(e.idA), idxB = index.get(e.idB)
    const fresh = e.matches.filter(([ia, ib]) => !idxA?.has(ia) && !idxB?.has(ib))
    if (!fresh.length) continue

    const KA = camA.K, KB = camB.K
    const PA = camToP34flat(camA), PB = camToP34flat(camB)
    const nA = [], nB = [], keep = []
    for (const [ia, ib] of fresh) {
      const kA = keypointOf(e.idA, ia), kB = keypointOf(e.idB, ib)
      if (!kA || !kB) continue
      nA.push(toNorm(kA.x, kA.y, KA)); nB.push(toNorm(kB.x, kB.y, KB)); keep.push([ia, ib])
    }
    if (!keep.length) continue

    const tri = await triangulate(nA, nB, PA, PB) // [{ x, y, z, srcIdx }]
    for (const { x, y, z, srcIdx } of tri) {
      const [ia, ib] = keep[srcIdx]
      // A point added earlier in this batch may already own one endpoint.
      if (index.get(e.idA)?.has(ia) || index.get(e.idB)?.has(ib)) continue
      const kA = keypointOf(e.idA, ia), kB = keypointOf(e.idB, ib)
      if (reprojErr(camA, x, y, z, kA) > maxReprojPx) continue
      if (reprojErr(camB, x, y, z, kB) > maxReprojPx) continue
      const pt = { x, y, z, views: new Map() }
      addIndexed(pt, e.idA, ia)
      addIndexed(pt, e.idB, ib)
      points3d.push(pt)
      added++
    }
  }
  return { added }
}

// Merge tracks split across two points: a match whose endpoints belong to two
// *different* points means the same physical feature was reconstructed twice.
// Fold the loser into the winner when the union is consistent (no image twice) and
// every added observation still reprojects ≤ gate against the winner. Returns the
// surviving array + { merged }.
export function mergeSplitTracks({ points3d, cameras, pairs, keypointOf, maxReprojPx }) {
  const index = buildViewIndex(points3d)
  let merged = 0
  for (const e of pairs) {
    if (!cameras.has(e.idA) || !cameras.has(e.idB)) continue
    const idxA = index.get(e.idA), idxB = index.get(e.idB)
    for (const [ia, ib] of e.matches) {
      const p1 = idxA?.get(ia), p2 = idxB?.get(ib)
      if (!p1 || !p2 || p1 === p2 || p1._dead || p2._dead) continue
      // No image may be observed with two different keypoints across the union.
      let conflict = false
      for (const [uuid, kp] of p2.views) {
        if (p1.views.has(uuid) && p1.views.get(uuid) !== kp) { conflict = true; break }
      }
      if (conflict) continue
      // Every added observation must still reproject within the gate against p1.
      let ok = true
      for (const [uuid, kp] of p2.views) {
        const cam = cameras.get(uuid), kpt = keypointOf(uuid, kp)
        if (!cam || !kpt || reprojErr(cam, p1.x, p1.y, p1.z, kpt) > maxReprojPx) { ok = false; break }
      }
      if (!ok) continue
      for (const [uuid, kp] of p2.views) {
        p1.views.set(uuid, kp)
        let m = index.get(uuid); if (!m) { m = new Map(); index.set(uuid, m) }
        m.set(kp, p1)
      }
      p2._dead = true
      merged++
    }
  }
  if (!merged) return { points3d, merged }
  const out = points3d.filter((p) => !p._dead)
  for (const p of out) delete p._dead
  return { points3d: out, merged }
}
