import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { bundleAdjust } from './reconstruction.js'
import { demAnchors } from './demAnchors.js'
import { SparsePoints } from './sparsePoints.js'
import { cameraCenter } from './geometry.js'
import { fitSimilarity, frameFromSimilarity, applySimilarity } from '../products/georef.js'

// F13 on a synthetic block that bends: three nadir strips whose photos carry a radial
// distortion (k1 −0.03) the solve self-calibrates with the focal, held only by the
// drone's GPS (σ 2 m) and with half a pixel of noise: the classic doming of a block
// without ground control, k1 and the focal trading against the block's curvature. Then
// solved again with its points held to the true ground by demAnchors (σ 0.2 m).
// Measured: shape 0.45 → 0.08 m RMS, height against the ground 0.70 → 0.07 m RMS, in
// two rounds. (Without self-calibration the unmodelled k1 is a conflict no anchor
// resolves: 3.3 → 1.3 m.)
describe('bundle adjustment held to a reference DEM', () => {
  beforeAll(async () => {
    const url = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
    await initRecon({ module_or_path: await readFile(fileURLToPath(url)) })
  })

  const K = { fx: 1000, fy: 1000, cx: 500, cy: 375 }
  const ground = (x, y) => 2 * Math.sin(0.05 * x) + 1.5 * Math.cos(0.07 * y)
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
  const K1 = -0.03
  let nseed = 7
  const noise = () => ((nseed = (nseed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1
  const observations = []
  truthCams.forEach((c, ci) =>
    truthPts.forEach((p, pi) => {
      const xc = c.R.map((r, i) => r[0] * p.x + r[1] * p.y + r[2] * p.z + c.t[i])
      if (!(xc[2] > 0)) return
      const xn = xc[0] / xc[2],
        yn = xc[1] / xc[2]
      const d = 1 + K1 * (xn * xn + yn * yn)
      const u = K.fx * xn * d + K.cx,
        v = K.fy * yn * d + K.cy
      if (u >= 0 && u <= 1000 && v >= 0 && v <= 750)
        observations.push({ camIdx: ci, ptIdx: pi, x: u + 0.5 * noise(), y: v + 0.5 * noise() })
    }),
  )

  // The points' shape error after a similarity onto the truth (m RMS), and the height
  // error of the points against the ground once georeferenced from the cameras.
  function shapeError(points) {
    const fit = fitSimilarity(
      points.map((p, i) => ({ src: [p.x, p.y, p.z], dst: [truthPts[i].x, truthPts[i].y, truthPts[i].z] })),
    )
    let s = 0
    points.forEach((p, i) => {
      const q = applySimilarity(fit, [p.x, p.y, p.z])
      s += (q[0] - truthPts[i].x) ** 2 + (q[1] - truthPts[i].y) ** 2 + (q[2] - truthPts[i].z) ** 2
    })
    return Math.sqrt(s / points.length)
  }
  const georef = (cams) =>
    fitSimilarity(cams.map((c, i) => ({ src: cameraCenter(c), dst: cameraCenter(truthCams[i]) })))
  function heightError(points, sim) {
    let s = 0
    for (const p of points) {
      const q = applySimilarity(sim, [p.x, p.y, p.z])
      s += (q[2] - ground(q[0], q[1])) ** 2
    }
    return Math.sqrt(s / points.length)
  }
  const sparse = (points) =>
    new SparsePoints({
      pos: Float64Array.from(points.flatMap((p) => [p.x, p.y, p.z])),
      viewUuids: ['a'],
      vcount: Uint32Array.from(points.map((_, i) => observations.filter((o) => o.ptIdx === i).length)),
      vcam: new Uint32Array(observations.length),
      vkp: new Uint32Array(observations.length),
    })

  // The drone's GPS: each camera centre within about a metre, σ 2 m.
  let seed = 11
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1
  const gps = truthCams.map((c, camIdx) => ({
    camIdx,
    target: cameraCenter(c).map((v) => v + rand()),
    weights: [1 / 4, 1 / 4, 1 / 4],
  }))

  const MODE = 'f,k1'
  it('takes the bend out of a block held only by its GPS', async () => {
    const plain = await bundleAdjust(
      truthCams,
      truthCams.map(() => K),
      truthPts,
      observations,
      {
        maxIters: 80,
        cameraPriors: gps,
        refineIntrinsics: MODE,
        sensorOfCam: truthCams.map(() => 0),
      },
    )
    const identity = {
      scale: 1,
      R: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      t: [0, 0, 0],
    }
    const bentShape = shapeError(plain.points3d)
    const bentHeight = heightError(plain.points3d, identity)
    expect(bentHeight).toBeGreaterThan(0.5)

    // The model frame is the GPS's, so the georeference is the identity here.
    const frame = frameFromSimilarity(identity, 'local')
    let cams = plain.cameras,
      pts = plain.points3d,
      kNow = plain.intrinsics
    for (let round = 0; round < 2; round++) {
      const { anchors } = demAnchors({ points: sparse(pts), frame, sample: ground, sigma: 0.2 })
      const res = await bundleAdjust(cams, kNow, pts, observations, {
        maxIters: 80,
        cameraPriors: gps,
        gcpAnchors: anchors,
        refineIntrinsics: MODE,
        sensorOfCam: truthCams.map(() => 0),
      })
      kNow = res.intrinsics
      cams = res.cameras
      pts = res.points3d
    }
    const heldShape = shapeError(pts)
    const heldHeight = heightError(pts, identity)
    expect(bentShape).toBeGreaterThan(0.3)
    expect(heldHeight).toBeLessThan(0.15 * bentHeight)
    expect(heldShape).toBeLessThan(0.25 * bentShape)
  })
})
