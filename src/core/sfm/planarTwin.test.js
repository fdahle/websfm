import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, expect, it } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { recoverPose, triangulateDlt, makeP34flat, solvePnp } from './reconstruction.js'
import { ransacEssential } from './essential.js'
import { twinByAttitude, twinByPositions, flattestTwin, planeNormal } from './planarTwin.js'

beforeAll(async () => {
  const bytes = await readFile(
    fileURLToPath(new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)),
  )
  await initRecon({ module_or_path: bytes })
})

const K = { fx: 2400, fy: 2400, cx: 1200, cy: 800 }
const mulv = (R, v) => R.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
// Flat ground (Z = 0), a camera 50 m up looking north, pitched `pitch`° below the horizon,
// flying FORWARD 8 m between photos: the case the depth rule gets wrong below ~45°.
function camRot(pitchDeg) {
  const p = (pitchDeg * Math.PI) / 180
  const x = [1, 0, 0],
    z = [0, Math.cos(p), -Math.sin(p)]
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
  return [x, y, z]
}
async function twinsAt(pitchDeg) {
  let seed = 4711
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32)
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd())
  const R = camRot(pitchDeg)
  const C = [
    [0, 0, 50],
    [0, 8, 50],
    [0, 16, 50],
  ]
  const proj = (c, X) => {
    const xc = mulv(R, [X[0] - c[0], X[1] - c[1], X[2] - c[2]])
    if (!(xc[2] > 0)) return null
    const u = K.fx * (xc[0] / xc[2]) + K.cx,
      v = K.fy * (xc[1] / xc[2]) + K.cy
    return u >= 0 && u <= 2400 && v >= 0 && v <= 1600 ? { x: u + 0.3 * gauss(), y: v + 0.3 * gauss() } : null
  }
  const px = [[], [], []]
  for (let guard = 0; px[0].length < 400 && guard < 200000; guard++) {
    const X = [(rnd() - 0.5) * 400, rnd() * 600, 0]
    const obs = C.map((c) => proj(c, X))
    if (obs.some((o) => !o)) continue
    obs.forEach((o, k) => px[k].push(o))
  }
  const norm2 = (p) => ({ x: (p.x - K.cx) / K.fx, y: (p.y - K.cy) / K.fy })
  const r = ransacEssential(
    px[0].map((p) => [norm2(p).x, norm2(p).y]),
    px[1].map((p) => [norm2(p).x, norm2(p).y]),
    { thresh: 1.5 / K.fx },
  )
  const tTrue = mulv(R, [C[0][0] - C[1][0], C[0][1] - C[1][1], C[0][2] - C[1][2]])
  const twins = []
  for (const alt of r.alternatives) {
    const pose = await recoverPose(px[0], px[1], alt.E, K, K)
    if (!pose) continue
    const I = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]
    const tri = await triangulateDlt(
      px[0].map(norm2),
      px[1].map(norm2),
      makeP34flat(I, [0, 0, 0]),
      makeP34flat(pose.R, pose.t),
    )
    const points = [],
      third = []
    for (const q of tri) {
      if (!(q.z > 0)) continue
      third.push({ pointIndex: points.length, ...px[2][q.srcIdx] })
      points.push({ x: q.x, y: q.y, z: q.z })
    }
    const zs = points.map((p) => p.z),
      m = zs.reduce((a, b) => a + b, 0) / zs.length
    const depthCv = Math.sqrt(zs.reduce((a, b) => a + (b - m) ** 2, 0) / zs.length) / m
    const cos =
      (pose.t[0] * tTrue[0] + pose.t[1] * tTrue[1] + pose.t[2] * tTrue[2]) /
      Math.hypot(...pose.t) /
      Math.hypot(...tTrue)
    twins.push({
      points,
      cB: { R: pose.R, t: pose.t },
      depthCv,
      eInliers: alt.count,
      third,
      tErrDeg: (Math.acos(Math.min(1, cos)) * 180) / Math.PI,
    })
  }
  // The world's up in camera A's frame: R·[0, 0, 1].
  return { twins: twins.filter((t) => t.eInliers >= 0.95 * twins[0].eInliers), up: [R[0][2], R[1][2], R[2][2]], C }
}

it('the depth rule picks the twin at 30° pitch, forward flight (the defect)', async () => {
  const { twins } = await twinsAt(30)
  expect(twins.length).toBeGreaterThan(1)
  expect(flattestTwin(twins).tErrDeg).toBeGreaterThan(45)
})

it('the photo’s attitude picks the true motion', async () => {
  for (const pitch of [80, 45, 30, 20]) {
    const { twins, up } = await twinsAt(pitch)
    if (twins.length < 2) continue
    const pick = twinByAttitude(twins, { upA: up })?.pick
    expect(pick?.tErrDeg, `pitch ${pitch}`).toBeLessThan(2.5)
  }
})

it('a third photo’s camera position picks the true motion', async () => {
  const { twins, C } = await twinsAt(30)
  const pick = (
    await twinByPositions(twins, {
      posA: C[0],
      posB: C[1],
      solve: solvePnp,
      thirdsFor: (tw) => [{ position: C[2], K, obs: tw.third }],
    })
  )?.pick
  expect(pick?.tErrDeg).toBeLessThan(2)
})

it('fits a plane normal through noisy points', () => {
  const pts = Array.from({ length: 50 }, (_, i) => ({ x: i % 7, y: Math.floor(i / 7), z: 0.001 * Math.sin(i) }))
  const n = planeNormal(pts)
  expect(Math.abs(n[2])).toBeGreaterThan(0.999)
})
