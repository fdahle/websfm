import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { bundleAdjust } from './reconstruction.js'
import { buildCameraPriorConstraints } from './surveyConstraints.js'
import { frameFromSimilarity } from '../products/georef.js'

// Camera heights and GCP heights in different vertical datums (review of 2026-11-22,
// finding A). A synthetic nadir block like the review's: 27 cameras at 60 m over 14 m of
// relief, 0.3 px noise, 12 GCPs at σ 2 cm, RTK positions at σ 2/2/3 cm whose heights
// sit N above the GCPs' datum, the focal refined. Held together, the solve settles the
// conflict through the focal (error ≈ N / flying height) and every residual stays small.
// With the heights tested (surveyConstraints.js priorHeights), they are moved onto the
// GCPs' by the offset measured, and the GCPs set the heights.
describe('camera heights in another vertical datum than the GCPs', () => {
  beforeAll(async () => {
    const url = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
    await initRecon({ module_or_path: await readFile(fileURLToPath(url)) })
  })

  const K = { fx: 1000, fy: 1000, cx: 500, cy: 375 }
  const ground = (x, y) => 5 + 4 * Math.sin(0.05 * x) + 3 * Math.cos(0.07 * y)
  const nadir = [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ]
  const truthCams = []
  for (let s = 0; s < 3; s++)
    for (let k = 0; k < 9; k++) {
      const C = [12 * k, 25 * s, 60]
      truthCams.push({ R: nadir, t: [-C[0], C[1], C[2]], K })
    }
  const truthPts = []
  for (let ix = 0; ix < 30; ix++)
    for (let iy = 0; iy < 22; iy++) {
      const x = -20 + 4.8 * ix,
        y = -20 + 4.3 * iy
      truthPts.push({ x, y, z: ground(x, y) })
    }
  let nseed = 7
  const noise = () => ((nseed = (nseed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1
  const observations = []
  truthCams.forEach((c, ci) =>
    truthPts.forEach((p, pi) => {
      const xc = c.R.map((r, i) => r[0] * p.x + r[1] * p.y + r[2] * p.z + c.t[i])
      if (!(xc[2] > 0)) return
      const u = (K.fx * xc[0]) / xc[2] + K.cx,
        v = (K.fy * xc[1]) / xc[2] + K.cy
      if (u >= 0 && u <= 1000 && v >= 0 && v <= 750)
        observations.push({ camIdx: ci, ptIdx: pi, x: u + 0.3 * noise(), y: v + 0.3 * noise() })
    }),
  )
  const viewed = new Set(observations.map((o) => o.ptIdx))
  // 12 GCPs spread over the block, on tie points seen in several photos.
  const gcpIdx = [0, 1, 2, 3].flatMap((i) => [0, 1, 2].map((j) => 3 + 7 * i + 22 * (4 + 9 * j) + 3 * j))
  expect(gcpIdx.every((i) => viewed.has(i))).toBe(true)
  const anchors = gcpIdx.map((ptIdx) => ({
    ptIdx,
    target: [truthPts[ptIdx].x, truthPts[ptIdx].y, truthPts[ptIdx].z],
    weights: [2500, 2500, 2500],
  }))
  const identity = {
    scale: 1,
    R: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    t: [0, 0, 0],
  }
  const control = {
    datums: ['unknown'],
    groundZ: gcpIdx.map((i) => truthPts[i].z).sort((a, b) => a - b)[6],
  }
  const cameras = new Map(truthCams.map((c, i) => [`c${i}`, c]))
  const uuidList = [...cameras.keys()]
  const centre = (c) => [0, 1, 2].map((i) => -(c.R[0][i] * c.t[0] + c.R[1][i] * c.t[1] + c.R[2][i] * c.t[2]))
  const priorsAt = (N) =>
    truthCams.map((c, i) => {
      const [x, y, z] = centre(c)
      return { uuid: `c${i}`, x, y, z: z + N, accuracyX: 0.02, accuracyY: 0.02, accuracyZ: 0.03 }
    })

  async function solve(N, heightTest) {
    const built = buildCameraPriorConstraints({
      cameras,
      cameraPriors: priorsAt(N),
      uuidList,
      reference: { fit: identity, frame: frameFromSimilarity(identity, 'local'), control },
      ...(heightTest ? { heightTest } : {}),
    })
    const res = await bundleAdjust(
      truthCams,
      truthCams.map(() => K),
      truthPts,
      observations,
      {
        maxIters: 80,
        cameraPriors: built.priors,
        gcpAnchors: anchors,
        refineIntrinsics: 'f',
        sensorOfCam: truthCams.map(() => 0),
      },
    )
    const dz = res.points3d.map((p, i) => p.z - truthPts[i].z)
    const mean = dz.reduce((s, v) => s + v, 0) / dz.length
    const sd = Math.sqrt(dz.reduce((s, v) => s + (v - mean) ** 2, 0) / dz.length)
    return { heights: built.heights, fx: res.intrinsics[0].fx, sd }
  }

  it('held together, a 5 m offset becomes a focal error with no warning in the residuals', async () => {
    const r = await solve(5, { sigmas: Infinity, heightFrac: 0 })
    expect(r.heights.held).toBe(true)
    expect(r.fx / 1000 - 1).toBeGreaterThan(0.04)
    expect(r.sd).toBeGreaterThan(0.1)
  })

  it('tested, the 5 m offset is measured and the heights moved onto the GCPs: the focal stays', async () => {
    const r = await solve(5)
    expect(r.heights).toMatchObject({ rule: 'test', held: false })
    expect(r.heights.offset).toBeCloseTo(5, 1)
    // As good as one datum (fx 1000.4, SD 2.9 cm): fx 1000.0, SD 2.9 cm.
    expect(Math.abs(r.fx / 1000 - 1)).toBeLessThan(0.002)
    expect(r.sd).toBeLessThan(0.035)
  })

  it('heights that agree keep holding the block', async () => {
    const r = await solve(0.02)
    expect(r.heights).toMatchObject({ rule: 'test', held: true })
    expect(Math.abs(r.fx / 1000 - 1)).toBeLessThan(0.005)
  })
})
