// Choosing between the planar twins of a seed pair (pure).
//
// Over a plane the calibrated two-view problem has two solutions that explain the
// matches equally well (initPair.js `twins`): the true motion, and a twin that moves
// along the plane's normal and tilts the plane. Two views cannot tell them apart, so the
// choice takes outside evidence, strongest first:
//   1. attitude: a photo's omega/phi/kappa (or gimbal angles) give the ground's up
//      direction in that camera's frame; the twin whose plane normal agrees wins;
//   2. camera positions of a third photo near the seed: each twin's three-view model,
//      the third camera placed by PnP against the twin's points, has the centres' shape
//      the positions have only for the true motion;
//   3. an aerial project: the twin with the more uniform depth (right when the photos
//      look down; a camera moving towards where it looks, pitched less than about 45°,
//      makes the twin the flatter one);
//   4. none: the depth rule stays, and the ambiguity is reported as open, so the run can
//      try the other twin as a seed (sfm.js).

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const norm = (a) => Math.hypot(a[0], a[1], a[2])
const centreOf = ({ R, t }) => [0, 1, 2].map((i) => -(R[0][i] * t[0] + R[1][i] * t[1] + R[2][i] * t[2]))

/** The unit normal of the best-fit plane through points {x, y, z} (their least spread). */
export function planeNormal(points) {
  const n = points.length
  if (n < 3) return null
  const c = [0, 0, 0]
  for (const p of points) {
    c[0] += p.x / n
    c[1] += p.y / n
    c[2] += p.z / n
  }
  const C = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (const p of points) {
    const d = [p.x - c[0], p.y - c[1], p.z - c[2]]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]
  }
  // Smallest eigenvector by inverse iteration on C + εI (a few steps suffice for 3×3).
  const eps = 1e-12 * (C[0][0] + C[1][1] + C[2][2] || 1)
  const A = C.map((r, i) => r.map((v, j) => v + (i === j ? eps : 0)))
  const inv = invert3(A)
  if (!inv) return null
  let v = [1, 1, 1]
  for (let it = 0; it < 30; it++) {
    const w = inv.map((r) => dot(r, v))
    const l = norm(w)
    if (!(l > 0)) return null
    v = w.map((x) => x / l)
  }
  return v
}

function invert3(m) {
  const [a, b, c] = m[0],
    [d, e, f] = m[1],
    [g, h, i] = m[2]
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (!(Math.abs(det) > 0)) return null
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ]
}

/**
 * Evidence 1. `upA` / `upB`: the ground's up direction in camera A's / B's frame (from
 * its attitude), either may be null. Each twin's points are in A's frame (A at the
 * origin, identity); B's frame is twin.cB. → { pick, agreeDeg: [per twin] } when one
 * twin's plane is within 20° of up and every other solution (a candidate whose plane
 * differs from it by more than 5°; near-copies of one solution are not rivals) is at
 * least 10° further, else null.
 */
export function twinByAttitude(twins, { upA = null, upB = null }) {
  if (!upA && !upB) return null
  const normals = twins.map((tw) => planeNormal(tw.points))
  const angles = twins.map((tw, k) => {
    const n = normals[k]
    if (!n) return 90
    const ups = []
    if (upA) ups.push(upA)
    // B's up carried into A's frame (the frame the points are in).
    if (upB) ups.push(invRot(tw.cB.R, upB))
    const angs = ups.map((u) => (Math.acos(Math.min(1, Math.abs(dot(n, u)) / norm(u))) * 180) / Math.PI)
    return Math.min(...angs)
  })
  const order = angles.map((a, k) => [a, k]).sort((p, q) => p[0] - q[0])
  const [best] = order
  if (best[0] > 20) return null
  const nb = normals[best[1]]
  const sameSolution = (k) =>
    nb && normals[k] && (Math.acos(Math.min(1, Math.abs(dot(nb, normals[k])))) * 180) / Math.PI <= 5
  const rival = order.slice(1).find(([a, k]) => !sameSolution(k) && a - best[0] < 10)
  if (rival) return null
  return { pick: twins[best[1]], agreeDeg: angles }
}

// B's up in A's frame: x_B = R_B·x_A, so a direction u_B is R_Bᵀ·u_B in A's frame.
const invRot = (R, u) => [0, 1, 2].map((i) => R[0][i] * u[0] + R[1][i] * u[1] + R[2][i] * u[2])

/**
 * Evidence 2. `thirdsFor(twin)`: [{ position, K, obs: [{ pointIndex, x, y }] }] photos
 * near the seed with a camera position and pixels of that twin's seed points (indices
 * into its `points`); `posA`, `posB` the seed photos' positions; `solve`
 * = solvePnp. Each twin places every third photo by PnP; its shape error is the misfit of
 * the centres' distance ratios (|AC|/|AB|, |BC|/|AB|) against the positions'. → { pick,
 * errors } when the best twin's error is under a third of the next one's, else null.
 */
export async function twinByPositions(twins, { thirdsFor, posA, posB, solve }) {
  const gAB = norm(sub(posB, posA))
  if (!(gAB > 0)) return null
  const errors = []
  for (const tw of twins) {
    const thirds = thirdsFor(tw)
    const cA = [0, 0, 0],
      cB = centreOf(tw.cB)
    const dAB = norm(cB)
    let err = 0,
      used = 0
    for (const th of thirds) {
      const xyz = th.obs.map((o) => tw.points[o.pointIndex])
      const px = th.obs.map((o) => ({ x: o.x, y: o.y }))
      if (xyz.some((p) => !p)) continue
      const pose = await solve(xyz, px, th.K, { ransacThreshPx: 4, maxIters: 300 })
      if (!pose) continue
      const cC = centreOf(pose)
      const model = [norm(sub(cC, cA)) / dAB, norm(sub(cC, cB)) / dAB]
      const truth = [norm(sub(th.position, posA)) / gAB, norm(sub(th.position, posB)) / gAB]
      err += (model[0] - truth[0]) ** 2 + (model[1] - truth[1]) ** 2
      used++
    }
    errors.push(used ? err / used : Infinity)
  }
  const order = errors.map((e, k) => [e, k]).sort((p, q) => p[0] - q[0])
  const [best, next] = order
  if (!Number.isFinite(best[0]) || (next && !(best[0] < next[0] / 3))) return null
  return { pick: twins[best[1]], errors }
}

/** Evidence 3 (and the fallback of 4): the twin whose points lie at the most uniform depth. */
export const flattestTwin = (twins) => twins.reduce((a, b) => (b.depthCv < a.depthCv ? b : a))
