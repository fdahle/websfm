import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { focalHeightCheck, focalHeightNote } from './focalHeight.js'
import { aerialBlock } from './syntheticScene.testutil.js'
import { reconstruct } from './sfm.js'
import { cameraCenter } from './geometry.js'

beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

// Known truth: the synthetic block's true cameras and terrain (world = survey frame,
// Z up), flown at 60 m over ground near 0 m, each camera within ±1.5 m of that height.
const sensorId = 'sensor-1'
const inputOf = (sc, extra = {}) => ({
  cameras: sc.truth.cams.map((c) => ({ uuid: c.uuid, R: c.R, t: c.t, sensorId })),
  points: sc.truth.world.flat(),
  cameraPriors: sc.cameraPriors,
  focalSensors: [sensorId],
  control: false,
  ...extra,
})

const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]))
const mv = (M, v) => M.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])
const T = (M) => [0, 1, 2].map((i) => [M[0][i], M[1][i], M[2][i]])

describe('focalHeightCheck on known truth', () => {
  const rtk = aerialBlock({ seed: 5, rows: 4, cols: 6, nPoints: 800, priors: true })

  it('warns on an RTK block flown at one height, and says what the focal is worth in height', () => {
    const r = focalHeightCheck(inputOf(rtk))
    expect(r.weak).toBe(true)
    expect(r.reason).toBe('weak')
    expect(r.sensorIds).toEqual([sensorId])
    // Ground near 0 m, cameras at 60 m: 0.01 % of focal is 6 mm of height.
    expect(r.flyingHeightM).toBeGreaterThan(57)
    expect(r.flyingHeightM).toBeLessThan(63)
    expect(r.heightPer0_01PctM).toBeCloseTo(r.flyingHeightM * 1e-4, 12)
    // NMAD of a ±1.5 m (σ) height scatter over 60 m: about 2.5 %.
    expect(r.ratio).toBeGreaterThan(0.01)
    expect(r.ratio).toBeLessThan(0.05)
    expect(r.obliqueShare).toBe(0)
    expect(focalHeightNote(r)).toMatch(/0\.6 cm/)
  })

  it('reads the same in any SfM frame (the positions give up and scale)', () => {
    // The model in an arbitrary frame: X' = s·Q·X + d, cameras and points alike.
    const Q = [
      [0, -1, 0],
      [0.6, 0, -0.8],
      [0.8, 0, 0.6],
    ]
    const s = 0.013,
      d = [4, -2, 7]
    const to = (X) => mv(Q, X).map((v, i) => s * v + d[i])
    const base = inputOf(rtk)
    const cameras = base.cameras.map((c) => {
      const R = mul(c.R, T(Q))
      const C = to(cameraCenter(c))
      return { ...c, R, t: mv(R, C).map((v) => -v) }
    })
    const points = rtk.truth.world.flatMap(to)
    const a = focalHeightCheck(base)
    const b = focalHeightCheck({ ...base, cameras, points })
    expect(b.weak).toBe(true)
    expect(b.ratio).toBeCloseTo(a.ratio, 3)
    expect(b.flyingHeightM).toBeCloseTo(a.flyingHeightM, 1)
  })

  it('is quiet when the strips are flown at two heights 20 % apart', () => {
    const twoHeights = aerialBlock({ seed: 5, rows: 4, cols: 6, nPoints: 800, priors: true, altitudeStep: 12 })
    const r = focalHeightCheck(inputOf(twoHeights))
    expect(r.weak).toBe(false)
    expect(r.reason).toBe('spread')
    // Half the photos 12 m higher: NMAD ≈ 1.48 × 6 m ≈ 9 m over ≈ 66 m.
    expect(r.ratio).toBeGreaterThan(0.1)
  })

  it('is quiet when GCPs or a DEM control the solve', () => {
    expect(focalHeightCheck(inputOf(rtk, { control: true }))).toMatchObject({ weak: false, reason: 'control' })
  })

  it('is quiet with consumer GPS (positions of metres hold nothing)', () => {
    const loose = rtk.cameraPriors.map((p) => ({ ...p, accuracyX: 5, accuracyY: 5, accuracyZ: 10 }))
    const r = focalHeightCheck(inputOf(rtk, { cameraPriors: loose }))
    expect(r).toMatchObject({ weak: false, reason: 'positions' })
    // The geometry alone is just as weak: only the positions' grade decides it.
    expect(r.ratio).toBeLessThan(0.05)
  })

  it('is quiet when no solve held by the positions refined the focal', () => {
    expect(focalHeightCheck(inputOf(rtk, { focalSensors: [] }))).toMatchObject({ weak: false, reason: 'focal' })
  })

  it('is quiet on oblique photos', () => {
    // Every camera tilted 30° about its own x axis.
    const c = Math.cos(Math.PI / 6),
      s = Math.sin(Math.PI / 6)
    const tilt = [
      [1, 0, 0],
      [0, c, -s],
      [0, s, c],
    ]
    const base = inputOf(rtk)
    const cameras = base.cameras.map((cam) => {
      const R = mul(tilt, cam.R)
      return { ...cam, R, t: mv(R, cameraCenter(cam)).map((v) => -v) }
    })
    const r = focalHeightCheck({ ...base, cameras })
    expect(r).toMatchObject({ weak: false, reason: 'oblique' })
    expect(r.medianTiltDeg).toBeGreaterThan(25)
  })

  it('needs positions on the placed cameras', () => {
    const r = focalHeightCheck(inputOf(rtk, { cameraPriors: [] }))
    expect(r.weak).toBe(false)
    expect(r.ratio).toBeNull()
    expect(focalHeightNote(r)).toBe('')
  })
})

// End to end: Sparse Model on the synthetic block records the check in its summary.
describe('the check after Sparse Model', () => {
  const run = (sc) =>
    reconstruct(
      {
        images: sc.images,
        pairs: sc.pairs,
        gcps: sc.gcps,
        cameraPriors: sc.cameraPriors,
        settings: { secondaryModels: false },
      },
      { onLog: () => {} },
    )

  it('warns on an RTK block at one height and not with GCPs as control', async () => {
    const rtk = aerialBlock({ seed: 11, rows: 4, cols: 6, nPoints: 1500, priors: true })
    const out = await run(rtk)
    expect(out.status).toBe('done')
    expect(out.summary.focalHeight).toMatchObject({ weak: true, sensorIds: [sensorId] })
    expect(out.summary.focalHeight.flyingHeightM).toBeGreaterThan(55)
    expect(out.summary.focalHeight.flyingHeightM).toBeLessThan(65)

    const gcp = aerialBlock({ seed: 11, rows: 4, cols: 6, nPoints: 1500, priors: true, gcps: 5 })
    const held = await run(gcp)
    expect(held.status).toBe('done')
    expect(held.summary.focalHeight).toMatchObject({ weak: false, reason: 'control' })
  }, 240_000)
})
