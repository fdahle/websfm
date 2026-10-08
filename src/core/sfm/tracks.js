import { makeP34flat } from './reconstruction.js'
import { cameraCenter, projectWithDepth, triangulationAngle } from './geometry.js'
import { hasKp, kpX, kpY } from './keypointSet.js'

// ── Retriangulation + track merging (A3, pure) ───────────────────────────────
// Standard COLMAP-style post-BA structure recovery, factored out of `reconstruct`
// so it's testable in isolation. Shared signature:
//   points3d : [{ x, y, z, views: Map<uuid,kpIdx> }]
//   cameras  : Map<uuid, { R, t, K }>
//   pairs    : verified match pairs [{ idA, idB, matches: [[iaKp, ibKp], …] }]
//   keypointsOf(uuid) → the image's KeypointSet (keypointSet.js) | null
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

// reprojErr against keypoint k of a KeypointSet.
export const reprojErrAt = (cam, x, y, z, set, k) => {
  const p = projectWithDepth(cam, x, y, z)
  return p ? Math.hypot(p.u - set.xy[2 * k], p.v - set.xy[2 * k + 1]) : Infinity
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
// in production). Mutates `points3d`; returns { added, lowParallax }.
export async function retriangulatePairs({
  points3d, cameras, pairs, keypointsOf, maxReprojPx, triangulate,
  minTriAngleDeg = 0,
}) {
  const index = buildViewIndex(points3d)
  const addIndexed = (pt, uuid, kp) => {
    pt.views.set(uuid, kp)
    let m = index.get(uuid); if (!m) { m = new Map(); index.set(uuid, m) }
    m.set(kp, pt)
  }
  let added = 0, lowParallax = 0
  for (const e of pairs) {
    const camA = cameras.get(e.idA), camB = cameras.get(e.idB)
    if (!camA || !camB) continue // both endpoints must be registered
    const idxA = index.get(e.idA), idxB = index.get(e.idB)
    const fresh = e.matches.filter(([ia, ib]) => !idxA?.has(ia) && !idxB?.has(ib))
    if (!fresh.length) continue

    const KA = camA.K, KB = camB.K
    const PA = camToP34flat(camA), PB = camToP34flat(camB)
    const CA = minTriAngleDeg > 0 ? cameraCenter(camA) : null
    const CB = minTriAngleDeg > 0 ? cameraCenter(camB) : null
    const sA = keypointsOf(e.idA), sB = keypointsOf(e.idB)
    const nA = [], nB = [], keep = []
    for (const [ia, ib] of fresh) {
      if (!hasKp(sA, ia) || !hasKp(sB, ib)) continue
      nA.push(toNorm(kpX(sA, ia), kpY(sA, ia), KA)); nB.push(toNorm(kpX(sB, ib), kpY(sB, ib), KB)); keep.push([ia, ib])
    }
    if (!keep.length) continue

    const tri = await triangulate(nA, nB, PA, PB) // [{ x, y, z, srcIdx }]
    for (const { x, y, z, srcIdx } of tri) {
      const [ia, ib] = keep[srcIdx]
      // A point added earlier in this batch may already own one endpoint.
      if (index.get(e.idA)?.has(ia) || index.get(e.idB)?.has(ib)) continue
      if (reprojErrAt(camA, x, y, z, sA, ia) > maxReprojPx) continue
      if (reprojErrAt(camB, x, y, z, sB, ib) > maxReprojPx) continue
      // Reprojection alone cannot constrain depth when the viewing rays are almost
      // parallel: a wrong correspondence displaced along its epipolar line can fit
      // both images yet triangulate arbitrarily far away. Apply the same geometric
      // floor as the track filter before allocating these bulk-recovered points.
      if (minTriAngleDeg > 0 && triangulationAngle(CA, CB, { x, y, z }) < minTriAngleDeg) {
        lowParallax++
        continue
      }
      const pt = { x, y, z, views: new Map() }
      addIndexed(pt, e.idA, ia)
      addIndexed(pt, e.idB, ib)
      points3d.push(pt)
      added++
    }
  }
  return { added, lowParallax }
}

// Final-output quality gate. Two-view points remain available throughout camera
// registration and BA because they are necessary to bootstrap an incremental model.
// Once the solve is complete, however, they are also the only tracks for which an
// epipolar-consistent wrong match has no independent observation to contradict it.
//
// Apply the gate only when the model already has a healthy core of multi-view tracks;
// this preserves legitimate two-camera reconstructions and tiny/weak datasets instead
// of turning them into an empty result. Pure so the policy can be regression-tested.
export function pruneFinalTwoViewTracks(points3d, {
  minViews = 3,
  minSupportedTracks = 50,
  minSupportedShare = 0.2,
} = {}) {
  const total = points3d.length
  const supported = points3d.filter((pt) => (pt.views?.size ?? 0) >= minViews)
  const supportedShare = total ? supported.length / total : 0
  const applied = minViews > 2
    && supported.length >= minSupportedTracks
    && supportedShare >= minSupportedShare
  return {
    points3d: applied ? supported : points3d,
    applied,
    removed: applied ? total - supported.length : 0,
    supported: supported.length,
    supportedShare,
    total,
  }
}

// Merge tracks split across two points: a match whose endpoints belong to two
// *different* points means the same physical feature was reconstructed twice.
// Fold the loser into the winner when the union is consistent (no image twice) and
// every added observation still reprojects ≤ gate against the winner. Returns the
// surviving array + { merged }.
export function mergeSplitTracks({ points3d, cameras, pairs, keypointsOf, maxReprojPx }) {
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
        const cam = cameras.get(uuid), set = keypointsOf(uuid)
        if (!cam || !hasKp(set, kp) || reprojErrAt(cam, p1.x, p1.y, p1.z, set, kp) > maxReprojPx) { ok = false; break }
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

// Track completion (COLMAP's `CompleteTracks`): for every verified match between two
// registered images where EXACTLY ONE endpoint already belongs to a point, add the
// other endpoint's observation to that point when it reprojects within `maxReprojPx`
// and the point does not observe that image yet. Both/neither-assigned matches are
// the other two cases (mergeSplitTracks / retriangulatePairs).
//
// Repeats until a round adds nothing or `maxRounds` is reached: an observation added
// through A↔C can enable C↔D in the next round (within a round the live index already
// carries some of that forward, in pair order). The incremental solver passes its
// live keypoint→point `index` + `addView` so its index stays consistent; standalone
// callers omit both and get a private index.
//
// Returns { added, rounds, lifted } — `lifted` = points that had ≤2 views
// before and ≥3 after, i.e. what the final 2-view prune no longer removes.
export function completeTracks({
  points3d, cameras, pairs, keypointsOf, maxReprojPx,
  maxRounds = 1, index = null, addView = null,
}) {
  const idx = index ?? buildViewIndex(points3d)
  const add = addView ?? ((pt, uuid, kp) => {
    pt.views.set(uuid, kp)
    let m = idx.get(uuid); if (!m) { m = new Map(); idx.set(uuid, m) }
    m.set(kp, pt)
  })
  const sizeBefore = new Map() // pt → view count before its first addition
  const sweep = (list) => {
    let n = 0
    for (const e of list) {
      if (!cameras.has(e.idA) || !cameras.has(e.idB)) continue
      for (const [ia, ib] of e.matches) {
        const ptA = idx.get(e.idA)?.get(ia)
        const ptB = idx.get(e.idB)?.get(ib)
        if (!!ptA === !!ptB) continue
        const pt = ptA || ptB
        const tgtUuid = ptA ? e.idB : e.idA
        const tgtKp = ptA ? ib : ia
        if (pt.views.has(tgtUuid)) continue // one keypoint per image per track
        const set = keypointsOf(tgtUuid)
        if (!hasKp(set, tgtKp)) continue
        if (reprojErrAt(cameras.get(tgtUuid), pt.x, pt.y, pt.z, set, tgtKp) > maxReprojPx) continue
        if (!sizeBefore.has(pt)) sizeBefore.set(pt, pt.views.size)
        add(pt, tgtUuid, tgtKp)
        n++
      }
    }
    return n
  }
  let added = 0, rounds = 0
  while (rounds < maxRounds) {
    rounds++
    const a = sweep(pairs)
    added += a
    if (!a) break
  }
  let lifted = 0
  for (const [pt, before] of sizeBefore) if (before <= 2 && pt.views.size >= 3) lifted++
  return { added, rounds, lifted }
}
