import { makeP34flat } from './reconstruction.js'
import { cameraCenter, projectWithDepth, triangulationAngle } from './geometry.js'
import { hasKp, kpX, kpY } from './keypointSet.js'

// ── Retriangulation + track merging (A3, pure) ───────────────────────────────
// Standard COLMAP-style post-BA structure recovery, factored out of `reconstruct`
// so it's testable in isolation. Shared signature:
//   tracks      : the run's TrackStore (trackStore.js) — points, views, keypoint index
//   ids         : makeImageIds — uuid ↔ the image index the store uses
//   cameras     : Map<uuid, { R, t, K }>
//   pairs       : verified match pairs [{ idA, idB, matches: [[iaKp, ibKp], …] }]
//   keypointsAt(img) → that image's KeypointSet (keypointSet.js) | null
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

// Retriangulate matches whose *both* keypoints are still unassigned, using the
// current (post-BA) poses. Adds a point when it's in front of both cameras and
// reprojects ≤ gate in both. `triangulate(nA, nB, PA, PB)` is injected (WASM DLT
// in production). Adds to `tracks`; returns { added, lowParallax }.
export async function retriangulatePairs({
  tracks, ids, cameras, pairs, keypointsAt, maxReprojPx, triangulate,
  minTriAngleDeg = 0,
}) {
  // A fresh index, as the private one this function used to build.
  tracks.reindex()
  let added = 0, lowParallax = 0
  for (const e of pairs) {
    const camA = cameras.get(e.idA), camB = cameras.get(e.idB)
    if (!camA || !camB) continue // both endpoints must be registered
    const iA = ids.img(e.idA), iB = ids.img(e.idB)
    const fresh = e.matches.filter(([ia, ib]) => tracks.pointAt(iA, ia) < 0 && tracks.pointAt(iB, ib) < 0)
    if (!fresh.length) continue

    const KA = camA.K, KB = camB.K
    const PA = camToP34flat(camA), PB = camToP34flat(camB)
    const CA = minTriAngleDeg > 0 ? cameraCenter(camA) : null
    const CB = minTriAngleDeg > 0 ? cameraCenter(camB) : null
    const sA = keypointsAt(iA), sB = keypointsAt(iB)
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
      if (tracks.pointAt(iA, ia) >= 0 || tracks.pointAt(iB, ib) >= 0) continue
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
      const p = tracks.addPoint(x, y, z)
      tracks.addView(p, iA, ia)
      tracks.addView(p, iB, ib)
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
// Removes the pruned points from `tracks`.
export function pruneFinalTwoViewTracks(tracks, {
  minViews = 3,
  minSupportedTracks = 50,
  minSupportedShare = 0.2,
} = {}) {
  const total = tracks.liveCount()
  let supported = 0
  tracks.forEachPoint((p) => { if (tracks.viewCount(p) >= minViews) supported++ })
  const supportedShare = total ? supported / total : 0
  const applied = minViews > 2
    && supported >= minSupportedTracks
    && supportedShare >= minSupportedShare
  if (applied) tracks.forEachPoint((p) => { if (tracks.viewCount(p) < minViews) tracks.removePoint(p) })
  return {
    applied,
    removed: applied ? total - supported : 0,
    supported,
    supportedShare,
    total,
  }
}

// Merge tracks split across two points: a match whose endpoints belong to two
// *different* points means the same physical feature was reconstructed twice.
// Fold the loser into the winner when the union is consistent (no image twice) and
// every added observation still reprojects ≤ gate against the winner. The loser is
// removed from `tracks`. Returns { merged }.
export function mergeSplitTracks({ tracks, ids, cameras, pairs, keypointsAt, maxReprojPx }) {
  // A fresh index, as the private one this function used to build.
  tracks.reindex()
  let merged = 0
  for (const e of pairs) {
    if (!cameras.has(e.idA) || !cameras.has(e.idB)) continue
    const iA = ids.img(e.idA), iB = ids.img(e.idB)
    for (const [ia, ib] of e.matches) {
      // A merged-away point has released its keypoints, so it is never returned here.
      const p1 = tracks.pointAt(iA, ia), p2 = tracks.pointAt(iB, ib)
      if (p1 < 0 || p2 < 0 || p1 === p2) continue
      // No image may be observed with two different keypoints across the union.
      const conflict = tracks.someView(p2, (img, kp) => {
        const k1 = tracks.viewKp(p1, img)
        return k1 >= 0 && k1 !== kp
      })
      if (conflict) continue
      // Every added observation must still reproject within the gate against p1.
      const x = tracks.x(p1), y = tracks.y(p1), z = tracks.z(p1)
      const bad = tracks.someView(p2, (img, kp) => {
        const cam = cameras.get(ids.uuid(img)), set = keypointsAt(img)
        return !cam || !hasKp(set, kp) || reprojErrAt(cam, x, y, z, set, kp) > maxReprojPx
      })
      if (bad) continue
      tracks.forEachView(p2, (img, kp) => tracks.addView(p1, img, kp))
      tracks.removePoint(p2)
      merged++
    }
  }
  return { merged }
}

// Track completion (COLMAP's `CompleteTracks`): for every verified match between two
// registered images where EXACTLY ONE endpoint already belongs to a point, add the
// other endpoint's observation to that point when it reprojects within `maxReprojPx`
// and the point does not observe that image yet. Both/neither-assigned matches are
// the other two cases (mergeSplitTracks / retriangulatePairs).
//
// Repeats until a round adds nothing or `maxRounds` is reached: an observation added
// through A↔C can enable C↔D in the next round (within a round the live index already
// carries some of that forward, in pair order). Works on the store's live index.
//
// Returns { added, rounds, lifted } — `lifted` = points that had ≤2 views
// before and ≥3 after, i.e. what the final 2-view prune no longer removes.
export function completeTracks({
  tracks, ids, cameras, pairs, keypointsAt, maxReprojPx, maxRounds = 1,
}) {
  const sizeBefore = new Map() // p → view count before its first addition
  const sweep = (list) => {
    let n = 0
    for (const e of list) {
      if (!cameras.has(e.idA) || !cameras.has(e.idB)) continue
      const iA = ids.img(e.idA), iB = ids.img(e.idB)
      for (const [ia, ib] of e.matches) {
        const pA = tracks.pointAt(iA, ia)
        const pB = tracks.pointAt(iB, ib)
        if ((pA >= 0) === (pB >= 0)) continue
        const p = pA >= 0 ? pA : pB
        const tgtImg = pA >= 0 ? iB : iA
        const tgtKp = pA >= 0 ? ib : ia
        if (tracks.viewKp(p, tgtImg) >= 0) continue // one keypoint per image per track
        const set = keypointsAt(tgtImg)
        if (!hasKp(set, tgtKp)) continue
        if (reprojErrAt(cameras.get(ids.uuid(tgtImg)), tracks.x(p), tracks.y(p), tracks.z(p), set, tgtKp) > maxReprojPx) continue
        if (!sizeBefore.has(p)) sizeBefore.set(p, tracks.viewCount(p))
        tracks.addView(p, tgtImg, tgtKp)
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
  for (const [p, before] of sizeBefore) if (before <= 2 && tracks.viewCount(p) >= 3) lifted++
  return { added, rounds, lifted }
}
