import { describe, it, expect } from 'vitest'
import { makeCanonicalToScan, makeScanToPinhole, makePinholeToMark, markToCentrePx, centreToMarkPx, makeFrameModelResolver, gcpsInPinholeFrame, guideToScan } from './displayFrame.js'
import { fitFiducialAffine, canonicalFrame } from './fiducials.js'

const K = { fx: 3000, fy: 3000, cx: 2000, cy: 1500 }
const dist = { k1: -0.08, k2: 0.01, k3: 0, p1: 0.0005, p2: -0.0003 }
const selfCal = { k1: 0.02, k2: -0.003, k3: 0 }

// A film affine + canonical frame (scan px → mm → canonical px).
const MARKS = [[-106, -106], [106, -106], [106, 106], [-106, 106]].map(([x, y], i) => ({ id: `F${i}`, xMm: x, yMm: y }))
const pitch = 0.0227
const fit = fitFiducialAffine(MARKS.map((m) => ({ px: 4800 + m.xMm / pitch, py: 4800 + m.yMm / pitch, xMm: m.xMm, yMm: m.yMm })))
const frame = canonicalFrame({ marks: MARKS, focalMm: 153, ppxMm: 0, ppyMm: 0 }, fit.pitchMm)
const fiducial = { A: fit.A, frame }

describe('makeScanToPinhole', () => {
  it('is the exact inverse of makePinholeToMark for every chain', () => {
    for (const model of [{}, { dist }, { selfCal }, { dist, selfCal }, { fiducial }, { dist, selfCal, fiducial }]) {
      const toMark = makePinholeToMark({ K, ...model }), toPin = makeScanToPinhole({ K, ...model })
      for (const [u, v] of [[100, 120], [2000, 1500], [3900, 2900], [1234.5, 77.25]]) {
        const s = toMark(u, v), back = toPin(s.x, s.y)
        expect(back.x).toBeCloseTo(u, 6)
        expect(back.y).toBeCloseTo(v, 6)
      }
    }
  })
  it('with nothing to correct is exactly the half-pixel convention shift', () => {
    // A click on the centre of pixel (10, 20) is stored as (10.5, 20.5); keypoints and
    // K put that centre at (10, 20).
    expect(makeScanToPinhole({ K })(10.5, 20.5)).toEqual({ x: 10, y: 20 })
    expect(makePinholeToMark({ K })(10, 20)).toEqual({ x: 10.5, y: 20.5 })
    expect(markToCentrePx(centreToMarkPx(7.25))).toBe(7.25)
  })
})

describe('makeFrameModelResolver', () => {
  it('joins sensor bag, normalised self-cal bag and film transform per image', () => {
    const resolve = makeFrameModelResolver({
      summary: { selfCalDistortion: [{ sensorId: 's1', k1: 0.01, k2: 0, k3: 0 }, { sensorId: 's2', k1: 0, k2: 0, k3: 0 }],
        fiducialTransforms: [{ uuid: 'u3', A: fit.A, frame }] },
      sensors: [{ id: 's1', k1: -0.1, distortionModel: 'radial' }, { id: 's2' }, { id: 's3', kind: 'film' }],
    })
    const a = resolve({ uuid: 'u1', sensorId: 's1' })
    expect(a.dist.k1).toBe(-0.1)
    expect(a.selfCal).toEqual({ k1: 0.01, k2: 0, k3: 0 })
    expect(resolve({ uuid: 'u2', sensorId: 's2' }).selfCal).toBeNull() // all-zero bag ⇒ none
    expect(resolve({ uuid: 'u3', sensorId: 's3' }).fiducial.frame).toBe(frame)
    expect(resolve({ uuid: 'u4', sensorId: 's3' }).filmMissing).toBe(true)
  })
})

describe('GCP marks and guides cross the frame boundary', () => {
  const imagesById = new Map([[1, { id: 1, uuid: 'a' }], [2, { id: 2, uuid: 'b' }]])
  const sparseCameras = new Map([['a', { K }]])
  const frameModel = (im) => (im.uuid === 'a' ? { dist } : {})

  it('maps marks on registered images only and never mutates the input', () => {
    const raw = makePinholeToMark({ K, dist })(3500, 2600) // the click a user would make
    const gcps = [{ id: 'g', observations: [{ imageId: 1, px: raw.x, py: raw.y }, { imageId: 2, px: 5, py: 6 }] }]
    const [out] = gcpsInPinholeFrame(gcps, { imagesById, sparseCameras, frameModel })
    expect(out.observations[0].px).toBeCloseTo(3500, 6)
    expect(out.observations[0].py).toBeCloseTo(2600, 6)
    expect(out.observations[1]).toBe(gcps[0].observations[1])
    expect(gcps[0].observations[0].px).toBe(raw.x)
  })

  it('maps a point guide exactly and an epipolar line through mapped points', () => {
    const toScan = makeCanonicalToScan({ K, fiducial })
    const pt = guideToScan({ kind: 'point', u: 10, v: 20 }, toScan, K)
    expect(pt.u).toBeCloseTo(toScan(10, 20).x, 9)
    // Line y = 1500 in the pinhole frame; a film affine maps lines to lines.
    const line = guideToScan({ kind: 'line', line: [0, 1, -1500] }, toScan, K).line
    for (const x of [0, 1000, 3000]) {
      const s = toScan(x, 1500)
      expect(Math.abs(line[0] * s.x + line[1] * s.y + line[2])).toBeLessThan(1e-6)
    }
  })
})
