import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, expect, it } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { bundleAdjust } from './reconstruction.js'
import { buildCameraPriorConstraints, surveyToSfmPrecision } from './surveyConstraints.js'
import { applySimilarity } from '../products/georef.js'
import { cameraCenter } from './geometry.js'

beforeAll(async () => {
  const bytes = await readFile(
    fileURLToPath(new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)),
  )
  await initRecon({ module_or_path: bytes })
})

const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]))
const vec = (A, v) => A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
const T = (A) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[j][i]))
const RX90 = [
  [1, 0, 0],
  [0, 0, -1],
  [0, 1, 0],
]
const I = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

// A 3×3 nadir block over rolling ground in survey metres (Up = z), solved with RTK-like
// priors σ = (1 cm, 1 cm, 1 m): one camera's prior sits 0.5 m too high. `Q` turns the
// survey frame into the SfM frame the model happens to be in (I, or a seed that made
// SfM y the survey's Up). The solved centres, mapped back to the survey, must not depend
// on Q: the loose Up σ has to stay on Up.
async function solveIn(Q) {
  const nadir = [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ]
  const K = { fx: 1000, fy: 1000, cx: 500, cy: 500 }
  const cams = new Map(),
    priors = []
  const centres = []
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const C = [30 * i, 30 * j, 100 + 2 * ((i + j) % 2)]
      centres.push(C)
      const R = mul(nadir, T(Q)) // world(SfM) → camera
      const Cs = vec(Q, C)
      cams.set(`c${i}${j}`, { R, t: vec(R, Cs).map((v) => -v), K })
      priors.push({
        uuid: `c${i}${j}`,
        x: C[0],
        y: C[1],
        z: C[2] + (i === 1 && j === 1 ? 0.5 : 0),
        accuracyX: 0.01,
        accuracyY: 0.01,
        accuracyZ: 1,
      })
    }
  const ground = []
  for (let a = -2; a <= 8; a++)
    for (let b = -2; b <= 8; b++) ground.push([8 * a, 8 * b, 3 * Math.sin(a * 0.7) * Math.cos(b * 0.5)])
  const pos = new Float64Array(ground.flatMap((g) => vec(Q, g)))
  const uuidList = [...cams.keys()]
  const obs = []
  uuidList.forEach((u, ci) => {
    const { R, t } = cams.get(u)
    ground.forEach((g, pi) => {
      const p = vec(R, vec(Q, g)).map((v, k) => v + t[k])
      const x = (K.fx * p[0]) / p[2] + K.cx,
        y = (K.fy * p[1]) / p[2] + K.cy
      if (p[2] > 0 && x >= 0 && x <= 1000 && y >= 0 && y <= 1000) obs.push({ camIdx: ci, ptIdx: pi, x, y })
    })
  })
  const set = buildCameraPriorConstraints({ cameras: cams, cameraPriors: priors, uuidList })
  const out = await bundleAdjust(
    uuidList.map((u) => cams.get(u)),
    uuidList.map(() => K),
    pos,
    obs,
    { maxIters: 50, refineIntrinsics: 'none', flatPoints: true, cameraPriors: set.priors },
  )
  return { out, fit: set.fit, centres }
}

it('rotates survey-axis prior σ into the SfM frame (P = s²·Rᵀ·diag(1/σ²)·R)', () => {
  const W = surveyToSfmPrecision([1, 4, 9], RX90)
  // SfM axes = Rx90ᵀ-turned survey axes: SfM z is the survey's −y, SfM y the survey's z.
  expect(W.map((r) => r.map((v) => Math.round(v * 1e9) / 1e9))).toEqual([
    [1, 0, 0],
    [0, 9, 0],
    [0, 0, 4],
  ])
})

it('solves the same block the same way whichever frame the seed left it in', async () => {
  const a = await solveIn(I),
    b = await solveIn(RX90)
  const inSurvey = ({ out, fit }) => out.cameras.map((c) => applySimilarity(fit, cameraCenter(c)))
  const ca = inSurvey(a),
    cb = inSurvey(b)
  for (let k = 0; k < ca.length; k++)
    for (let d = 0; d < 3; d++) expect(Math.abs(ca[k][d] - cb[k][d])).toBeLessThan(1e-4 * 60)
  // The displaced camera keeps its place horizontally (its 0.5 m is in the loose Up).
  const mid = cb[4]
  expect(Math.hypot(mid[0] - a.centres[4][0], mid[1] - a.centres[4][1])).toBeLessThan(0.02)
})
