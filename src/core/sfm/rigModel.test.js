import { describe, it, expect, beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { reconstruct } from './sfm.js'
import { aerialBlock } from './syntheticScene.testutil.js'
import { createRigModel } from './rigModel.js'
import { rigRotation } from '../sensors/rig.js'
import { cameraCenter } from './geometry.js'
import { fitSimilarity, applySimilarity } from '../products/georef.js'

beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]))
const T = (A) => [0, 1, 2].map((i) => [A[0][i], A[1][i], A[2][i]])
// The angle of a rotation matrix, degrees: from its skew part and trace (atan2), which
// stays exact for the small angles of lens offsets where acos of the trace does not.
const angleDeg = (R) =>
  (Math.atan2(Math.hypot(R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]), R[0][0] + R[1][1] + R[2][2] - 1) *
    180) /
  Math.PI

const bandPhoto = (uuid, capture, index, name, rigRelatives = [0, 0, 0]) => ({
  uuid,
  name: `${uuid}.tif`,
  meta: { make: 'MicaSense', model: 'X', band: { name, index, captureId: capture, rigRef: 1, rigRelatives } },
})

describe('createRigModel', () => {
  const images = [
    bandPhoto('a1', 'A', 1, 'Green'),
    bandPhoto('a0', 'A', 0, 'Blue', [0, 0, 1]),
    bandPhoto('b1', 'B', 1, 'Green'),
    bandPhoto('b0', 'B', 0, 'Blue', [0, 0, 1]),
    { uuid: 'rgb', name: 'rgb.jpg', meta: { make: 'DJI' } },
  ]
  it('gives each photo its capture and its band offset, none to the reference band', () => {
    const rig = createRigModel(images)
    const { captureOf, offsets } = rig.attach(['a1', 'a0', 'b0', 'rgb'])
    expect(Array.from(captureOf)).toEqual([0, 0, 1, -1])
    expect(offsets[0]).toBeNull()
    expect(offsets[3]).toBeNull()
    expect(angleDeg(offsets[1].R)).toBeCloseTo(1, 10)
    expect(rig.bandUuids().sort()).toEqual(['a0', 'b0'])
    expect(createRigModel([images[4]])).toBeNull()
  })
  it('takes solved offsets from the cameras, and places band photos that did not register', () => {
    const rig = createRigModel(images)
    const Ro = rigRotation([0, 0, 1.2]) // what the "solve" found: 1.2° instead of the recorded 1°
    const R1 = rigRotation([3, -2, 40])
    const cameras = new Map([
      ['a1', { R: R1, t: [1, 2, 3], K: { fx: 1 } }],
      ['a0', { R: mul(T(Ro), R1), t: [0, 0, 0], K: { fx: 1 } }],
      ['b1', { R: rigRotation([0, 1, 10]), t: [4, 5, 6], K: { fx: 1 } }],
    ])
    // a0's t: R_o·t_ref (no lever arm).
    cameras.get('a0').t = T(Ro).map((row) => row[0] * 1 + row[1] * 2 + row[2] * 3)
    rig.update(cameras)
    const [blue] = rig.summary()
    expect(blue.captures).toBe(1)
    expect(blue.offsetDeg).toBeCloseTo(1.2, 8)
    expect(blue.movedDeg).toBeCloseTo(0.2, 8)
    expect(rig.complete(cameras, () => ({ fx: 2 }))).toEqual(['b0'])
    const b0 = cameras.get('b0')
    expect(angleDeg(mul(b0.R, T(cameras.get('b1').R)))).toBeCloseTo(1.2, 8)
    expect(b0.K).toEqual({ fx: 2 })
  })
})

describe('Sparse Model with a camera rig', () => {
  // Three bands besides green: blue and red matched with their capture's green photo,
  // recorded 0.15° and 0.2° off what they truly are; thermal matched with nothing.
  const rigSpec = [
    { name: 'Blue', index: 0, trueDeg: [0.3, -0.2, 0.5], recordedDeg: [0.4, -0.3, 0.6], leverM: 0.05 },
    { name: 'Red', index: 2, trueDeg: [-0.4, 0.1, -0.3], recordedDeg: [-0.5, 0.25, -0.4], leverM: -0.04 },
    { name: 'LWIR', index: 5, trueDeg: [0.2, 0.3, 0.1], recordedDeg: [0.2, 0.3, 0.1], pairs: false },
  ]
  const scene = aerialBlock({ seed: 41, rows: 3, cols: 5, nPoints: 2000, calibrated: true, rig: rigSpec })
  const settings = { secondaryModels: false }

  it('solves one pose per capture, refines the lens offsets and places the thermal band', async () => {
    const out = await reconstruct({ images: scene.images, pairs: scene.pairs, settings })
    expect(out.status).toBe('done')
    const cams = new Map(out.cameras.map(({ uuid, ...c }) => [uuid, c]))
    const refs = scene.truth.cams.filter((c) => c.band == null)
    // Every photo has a pose, the thermal ones from their capture.
    expect(scene.images.every((im) => cams.has(im.uuid))).toBe(true)
    expect(out.summary.rig.placed).toBe(refs.length)
    // Each band's solved offset matches the true one, in every capture alike, up to the
    // lever arm, which a nadir block absorbs into the rotation at its flying height (60 m).
    for (const [bi, band] of rigSpec.entries()) {
      const truth = T(rigRotation(band.trueDeg))
      const absorbed = (Math.atan(Math.abs(band.leverM ?? 0) / 60) * 180) / Math.PI
      for (const ref of refs) {
        const solved = mul(cams.get(`${ref.uuid}b${bi}`).R, T(cams.get(ref.uuid).R))
        const err = angleDeg(mul(solved, T(truth)))
        expect(err, `${band.name} in ${ref.uuid}`).toBeLessThan(band.pairs === false ? 0.001 : absorbed + 0.01)
        expect(err, `${band.name} in ${ref.uuid}`).toBeGreaterThan(absorbed - 0.01)
      }
    }
    expect(out.summary.postBaMedianPx).toBeLessThan(0.5)
    // The thermal band was never solved: it keeps exactly what the camera records.
    expect(out.summary.rig.bands.find((b) => b.band === 'LWIR').captures).toBe(0)
    // Camera centres: the thermal band where the truth puts it.
    const byUuid = new Map(scene.truth.cams.map((c) => [c.uuid, c.C]))
    const sim = fitSimilarity(refs.map((c) => ({ src: cameraCenter(cams.get(c.uuid)), dst: c.C })))
    for (const ref of refs) {
      const u = `${ref.uuid}b2`
      const p = applySimilarity(sim, cameraCenter(cams.get(u)))
      expect(Math.hypot(...p.map((v, i) => v - byUuid.get(u)[i]))).toBeLessThan(0.05)
    }
  }, 600_000)

  it('leaves every band photo its own pose with the rig off', async () => {
    const out = await reconstruct({
      images: scene.images,
      pairs: scene.pairs,
      settings: { ...settings, cameraRig: 'off' },
    })
    expect(out.status).toBe('done')
    const cams = new Map(out.cameras.map(({ uuid, ...c }) => [uuid, c]))
    expect(out.summary.rig).toBeUndefined()
    // The thermal band matches nothing, so nothing places it.
    expect(scene.images.filter((im) => im.uuid.endsWith('b2')).some((im) => cams.has(im.uuid))).toBe(false)
  }, 600_000)
})
