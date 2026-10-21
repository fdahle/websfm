// Registration plausibility: does each registered camera agree with the epipolar
// geometry of its strongest verified pairs? (pure, operates on the run's own state)
//
// Incremental registration can accept a wrong pose and keep it. On South Building
// (128 images, 2026-10-16) a chain of cameras along a corner registered one after the
// other with falling support — 332 at 189/254 PnP inliers, 333 at 61/72 and 334 at 55/62,
// 2–4.5 px — while the images they overlap most (147–153, up to 1,137 verified matches)
// only joined later through another part of the model. 333/334 triangulated their own
// points, so they were self-consistent: residual statistics, the track filter and every
// BA were satisfied, and both ended ~2 units off (out of a 9-unit scene).
//
// What does expose them is the pairwise geometry the matcher verified. For a camera and
// one of its pair partners, the two registered poses imply a fundamental matrix; the
// pair's matches must satisfy it. Scored as the median Sampson distance over a sample
// of the pair's matches, then the median over the camera's `topPairs` strongest pairs
// to registered partners: on that run the two misplaced cameras scored 19–21 px and every
// other camera ≤ 1.05 px (model median 0.42 px).
//
// Pure apart from `deregisterCamera`, which edits the track store in place.

import { asPairList } from './matchCodec.js'

export const REGISTRATION_CHECK_DEFAULTS = {
  topPairs: 5, // a camera's strongest pairs to registered partners that are scored
  samplesPerPair: 200, // matches sampled per pair (evenly spaced)
  factor: 10, // flagged above factor × the model's median score …
  minPx: 5, // … and above this floor (detection px, × the run's scale factor)
}

const mul3 = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]))
const tr3 = (A) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[j][i]))
const kInv = (K) => [
  [1 / K.fx, 0, -K.cx / K.fx],
  [0, 1 / K.fy, -K.cy / K.fy],
  [0, 0, 1],
]

// The fundamental matrix two registered cameras imply (x_b·F·x_a = 0, pixel coords).
export function fundamentalFromPoses(a, b) {
  const R = mul3(b.R, tr3(a.R))
  const ta = R.map((r) => r[0] * a.t[0] + r[1] * a.t[1] + r[2] * a.t[2])
  const t = b.t.map((v, k) => v - ta[k])
  const tx = [
    [0, -t[2], t[1]],
    [t[2], 0, -t[0]],
    [-t[1], t[0], 0],
  ]
  return mul3(mul3(tr3(kInv(b.K)), mul3(tx, R)), kInv(a.K))
}

// Median Sampson distance (px) of a pair's matches under F; null without usable matches.
// `kpA`/`kpB` are KeypointSets ({ xy }); `matches` a pair's packed match list.
export function pairSampsonMedianPx(F, kpA, kpB, matches, samples = REGISTRATION_CHECK_DEFAULTS.samplesPerPair) {
  const m = asPairList(matches)
  const n = m.length
  if (!n) return null
  const step = Math.max(1, Math.floor(n / samples))
  const errs = []
  for (let i = 0; i < n; i += step) {
    const a = m.a(i),
      b = m.b(i)
    const x1 = kpA.xy[2 * a],
      y1 = kpA.xy[2 * a + 1],
      x2 = kpB.xy[2 * b],
      y2 = kpB.xy[2 * b + 1]
    // A keypoint dropped at ingest (fisheye, far off-axis) is NaN.
    // eslint-disable-next-line no-self-compare
    if (x1 !== x1 || x2 !== x2) continue
    const l0 = F[0][0] * x1 + F[0][1] * y1 + F[0][2]
    const l1 = F[1][0] * x1 + F[1][1] * y1 + F[1][2]
    const l2 = F[2][0] * x1 + F[2][1] * y1 + F[2][2]
    const r0 = F[0][0] * x2 + F[1][0] * y2 + F[2][0]
    const r1 = F[0][1] * x2 + F[1][1] * y2 + F[2][1]
    const d = Math.sqrt(l0 * l0 + l1 * l1 + r0 * r0 + r1 * r1)
    if (d > 0) errs.push(Math.abs(x2 * l0 + y2 * l1 + l2) / d)
  }
  if (!errs.length) return null
  errs.sort((p, q) => p - q)
  return errs[errs.length >> 1]
}

// Score every registered camera; flag the ones far off the model's norm.
//   cameras      Map uuid → { R, t, K }        pairs  [{ idA, idB, matches, inlierCount, weak? }]
//   keypointsAt  img index → KeypointSet       ids    { img(uuid) }
//   scale        the run's detection-scale factor (px gates follow detection resolution)
// Returns { scores: Map uuid → px, median, limit, flagged: [{ uuid, px }] } (worst first).
export function registrationOutliers({ cameras, pairs, keypointsAt, ids, scale = 1, cfg = {} }) {
  const c = { ...REGISTRATION_CHECK_DEFAULTS, ...cfg }
  const byCam = new Map()
  for (const e of pairs) {
    if (e.weak || !(e.inlierCount > 0) || !cameras.has(e.idA) || !cameras.has(e.idB)) continue
    for (const u of [e.idA, e.idB]) {
      if (!byCam.has(u)) byCam.set(u, [])
      byCam.get(u).push(e)
    }
  }
  const scores = new Map()
  for (const [u, es] of byCam) {
    const top = es.sort((p, q) => q.inlierCount - p.inlierCount).slice(0, c.topPairs)
    const v = []
    for (const e of top) {
      const F = fundamentalFromPoses(cameras.get(e.idA), cameras.get(e.idB))
      const px = pairSampsonMedianPx(
        F,
        keypointsAt(ids.img(e.idA)),
        keypointsAt(ids.img(e.idB)),
        e.matches,
        c.samplesPerPair,
      )
      if (px != null) v.push(px)
    }
    if (!v.length) continue
    v.sort((p, q) => p - q)
    scores.set(u, v[v.length >> 1])
  }
  const all = [...scores.values()].sort((p, q) => p - q)
  const median = all.length ? all[all.length >> 1] : 0
  const limit = Math.max(c.factor * median, c.minPx * scale)
  const flagged = [...scores]
    .filter(([, px]) => px > limit)
    .map(([uuid, px]) => ({ uuid, px }))
    .sort((p, q) => q.px - p.px)
  return { scores, median, limit, flagged }
}

// Take a camera out of the model: its views leave every track, points left with fewer
// than two views go, and the camera is no longer registered. The caller compacts the
// store afterwards (refreshTracks). Returns the number of points removed.
export function deregisterCamera({ uuid, cameras, registeredUuids, tracks, ids }) {
  const img = ids.img(uuid)
  const touched = []
  tracks.forEachPoint((p) => {
    if (tracks.viewKp(p, img) >= 0) touched.push(p)
  })
  let removed = 0
  for (const p of touched) {
    tracks.removeView(p, img)
    if (tracks.viewCount(p) < 2) {
      tracks.removePoint(p)
      removed++
    }
  }
  cameras.delete(uuid)
  registeredUuids?.delete(uuid)
  return removed
}
