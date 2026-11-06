import { describe, it, expect } from 'vitest'
import {
  makeSampleMap,
  makeCanonicalToScan,
  makeScanToPinhole,
  makePinholeToMark,
  markToCentrePx,
  centreToMarkPx,
  makeFrameModelResolver,
  gcpsInPinholeFrame,
  guideToScan,
  calibrationSnapshot,
} from './displayFrame.js'
import { fitFiducialAffine, canonicalFrame } from './fiducials.js'

const K = { fx: 3000, fy: 3000, cx: 2000, cy: 1500 }
const dist = { k1: -0.08, k2: 0.01, k3: 0, p1: 0.0005, p2: -0.0003 }
const selfCal = { k1: 0.02, k2: -0.003, k3: 0 }

// A film affine + canonical frame (scan px → mm → canonical px).
const MARKS = [
  [-106, -106],
  [106, -106],
  [106, 106],
  [-106, 106],
].map(([x, y], i) => ({ id: `F${i}`, xMm: x, yMm: y }))
const pitch = 0.0227
const fit = fitFiducialAffine(
  MARKS.map((m) => ({ px: 4800 + m.xMm / pitch, py: 4800 + m.yMm / pitch, xMm: m.xMm, yMm: m.yMm })),
)
const frame = canonicalFrame({ marks: MARKS, focalMm: 153, ppxMm: 0, ppyMm: 0 }, fit.pitchMm)
const fiducial = { A: fit.A, frame }

describe('makeScanToPinhole', () => {
  it('is the exact inverse of makePinholeToMark for every chain', () => {
    for (const model of [{}, { dist }, { selfCal }, { dist, selfCal }, { fiducial }, { dist, selfCal, fiducial }]) {
      const toMark = makePinholeToMark({ K, ...model }),
        toPin = makeScanToPinhole({ K, ...model })
      for (const [u, v] of [
        [100, 120],
        [2000, 1500],
        [3900, 2900],
        [1234.5, 77.25],
      ]) {
        const s = toMark(u, v),
          back = toPin(s.x, s.y)
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
      summary: {
        selfCalDistortion: [
          { sensorId: 's1', k1: 0.01, k2: 0, k3: 0 },
          { sensorId: 's2', k1: 0, k2: 0, k3: 0 },
        ],
        fiducialTransforms: [{ uuid: 'u3', A: fit.A, frame }],
      },
      sensors: [{ id: 's1', k1: -0.1, distortionModel: 'radial' }, { id: 's2' }, { id: 's3', kind: 'film' }],
    })
    const a = resolve({ uuid: 'u1', sensorId: 's1' })
    expect(a.dist.k1).toBe(-0.1)
    expect(a.selfCal).toEqual({ k1: 0.01, k2: 0, k3: 0 })
    expect(resolve({ uuid: 'u2', sensorId: 's2' }).selfCal).toBeNull() // all-zero bag ⇒ none
    expect(resolve({ uuid: 'u3', sensorId: 's3' }).fiducial.frame).toBe(frame)
    expect(resolve({ uuid: 'u4', sensorId: 's3' }).filmMissing).toBe(true)
  })
  it("gives a sensorless image its own self-cal row, and no other image's", () => {
    const resolve = makeFrameModelResolver({
      summary: { selfCalDistortion: [{ sensorId: null, imageUuid: 'u1', k1: -0.05, k2: 0, k3: 0 }] },
    })
    expect(resolve({ uuid: 'u1', sensorId: null }).selfCal).toEqual({ k1: -0.05, k2: 0, k3: 0 })
    expect(resolve({ uuid: 'u2', sensorId: null }).selfCal).toBeNull()
    expect(resolve({ uuid: 'u1', sensorId: 's1' }).selfCal).toBeNull()
  })
})

describe('GCP marks and guides cross the frame boundary', () => {
  const imagesById = new Map([
    [1, { id: 1, uuid: 'a' }],
    [2, { id: 2, uuid: 'b' }],
  ])
  const sparseCameras = new Map([['a', { K }]])
  const frameModel = (im) => (im.uuid === 'a' ? { dist } : {})

  it('maps marks on registered images only and never mutates the input', () => {
    const raw = makePinholeToMark({ K, dist })(3500, 2600) // the click a user would make
    const gcps = [
      {
        id: 'g',
        observations: [
          { imageId: 1, px: raw.x, py: raw.y },
          { imageId: 2, px: 5, py: 6 },
        ],
      },
    ]
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

describe('makeSampleMap per-axis scales', () => {
  it('maps an output grid onto a source grid with its own x and y factors', () => {
    const K = { fx: 1000, fy: 1000, cx: 500, cy: 250 }
    // Output at a uniform 0.5, source resized 1001×500 → 501×250 (0.5005 × 0.5).
    const map = makeSampleMap({ K, outScale: 0.5, srcScale: [501 / 1001, 0.5] })
    const p = map(100, 60)
    const nx = (100 + 0.5) / 0.5 - 0.5,
      ny = (60 + 0.5) / 0.5 - 0.5
    expect(p.x).toBeCloseTo((nx + 0.5) * (501 / 1001) - 0.5, 12)
    expect(p.y).toBeCloseTo((ny + 0.5) * 0.5 - 0.5, 12)
    // Same factors in and out, no distortion: the identity.
    const id = makeSampleMap({ K, outScale: [0.4, 0.5], srcScale: [0.4, 0.5] })
    expect(id(37.25, 12.5).x).toBeCloseTo(37.25, 12)
    expect(id(37.25, 12.5).y).toBeCloseTo(12.5, 12)
  })
})

describe('makeFrameModelResolver (fisheye)', () => {
  it('a self-calibrated fisheye row replaces the sensor lens instead of composing', () => {
    const sensors = [{ id: 's', distortionModel: 'fisheye2', k1: 0.01, k2: 0.002 }]
    const summary = {
      selfCalDistortion: [{ sensorId: 's', fisheye: true, k1: 0.04, k2: -0.003, k3: 0, k4: 0, fitRmsPx: 0 }],
    }
    const fm = makeFrameModelResolver({ summary, sensors })({ uuid: 'u', sensorId: 's' })
    expect(fm.dist).toEqual({ fisheye: true, k1: 0.04, k2: -0.003, k3: 0, k4: 0 })
    expect(fm.selfCal).toBeNull()
    // Without a run row, the sensor's own lens.
    expect(makeFrameModelResolver({ summary: {}, sensors })({ uuid: 'u', sensorId: 's' }).dist).toEqual({
      fisheye: true,
      k1: 0.01,
      k2: 0.002,
      k3: 0,
      k4: 0,
    })
  })
})

describe('makeFrameModelResolver (a whole solved lens)', () => {
  it('a full row replaces the sensor lens, decentring terms included', () => {
    const sensors = [{ id: 's', distortionModel: 'brown', k1: -0.2, k2: 0.05, p1: 0.001 }]
    const lens = { k1: -0.11, k2: 0.02, k3: 0.001, p1: 0.0021, p2: -0.0008 }
    const summary = { selfCalDistortion: [{ sensorId: 's', full: true, ...lens, fitRmsPx: 0 }] }
    const fm = makeFrameModelResolver({ summary, sensors })({ uuid: 'u', sensorId: 's' })
    expect(fm.dist).toEqual(lens)
    expect(fm.selfCal).toBeNull()
    // A full row of a lens that solved to nothing is no lens, not the sensor's.
    const zero = { sensorId: 's', full: true, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 }
    expect(
      makeFrameModelResolver({ summary: { selfCalDistortion: [zero] }, sensors })({ sensorId: 's' }).dist,
    ).toBeNull()
  })

  it('a row without `full` (a run before the lens state) still composes on the sensor lens', () => {
    const sensors = [{ id: 's', distortionModel: 'brown', k1: -0.2 }]
    const summary = { selfCalDistortion: [{ sensorId: 's', k1: 0.01, k2: 0, k3: 0, fitRmsPx: 0.01 }] }
    const fm = makeFrameModelResolver({ summary, sensors })({ uuid: 'u', sensorId: 's' })
    expect(fm.dist).toMatchObject({ k1: -0.2 })
    expect(fm.selfCal).toEqual({ k1: 0.01, k2: 0, k3: 0 })
  })
})

describe('calibrationSnapshot: a cloud keeps the frame model it was solved in', () => {
  const sensors = [
    { id: 'a', distortionModel: 'brown', k1: -0.2, k2: 0.05 },
    { id: 'b', distortionModel: 'brown', k1: 0.01 },
    { id: 'c', distortionModel: 'fisheye2', k1: 0.02, k2: -0.004 },
    { id: 'd', distortionModel: 'brown' },
  ]
  const fid = { uuid: 'f1', A: [1, 0, 0, 0, 1, 0], transform: null, frame: { width: 100, height: 100 } }
  const summary = {
    selfCalDistortion: [
      { sensorId: 'a', k1: 0.01, k2: 0, k3: 0, fitRmsPx: 0.01 }, // an old correction on the sensor's lens
      { sensorId: 'b', full: true, k1: -0.03, k2: 0.004, k3: 0, p1: 0.0012, p2: -0.0004 },
      { sensorId: 'c', fisheye: true, full: true, k1: 0.03, k2: -0.005, k3: 0, k4: 0 },
      { sensorId: null, imageUuid: 'loose', full: true, k1: -0.07, k2: 0, k3: 0, p1: 0, p2: 0 },
    ],
    fiducialTransforms: [fid],
  }
  const images = [
    { uuid: 'a1', sensorId: 'a' },
    { uuid: 'a2', sensorId: 'a' },
    { uuid: 'b1', sensorId: 'b' },
    { uuid: 'c1', sensorId: 'c' },
    { uuid: 'loose', sensorId: null },
    { uuid: 'f1', sensorId: 'd' },
  ]

  it('resolves every image of the cloud exactly as the run summary did', () => {
    const fromSummary = makeFrameModelResolver({ summary, sensors })
    const calibration = calibrationSnapshot({ resolve: fromSummary, images })
    expect(calibration.groups).toHaveLength(5) // a, b, c, d and the sensorless image
    const fromCloud = makeFrameModelResolver({ calibration, sensors })
    for (const im of images) expect(fromCloud(im)).toEqual(fromSummary(im))
    // Plain data: it survives a save (JSON) unchanged.
    const reloaded = makeFrameModelResolver({ calibration: JSON.parse(JSON.stringify(calibration)), sensors })
    for (const im of images) expect(reloaded(im)).toEqual(fromSummary(im))
  })

  it('is not changed by a later edit of the sensor table', () => {
    const calibration = calibrationSnapshot({ resolve: makeFrameModelResolver({ summary, sensors }), images })
    const edited = sensors.map((s) => (s.id === 'a' ? { ...s, k1: 0.5 } : s))
    expect(makeFrameModelResolver({ calibration, sensors: edited })({ uuid: 'a1', sensorId: 'a' }).dist).toMatchObject({
      k1: -0.2,
    })
  })

  it("gives an image the snapshot has no group for its sensor's lens", () => {
    const calibration = calibrationSnapshot({ resolve: makeFrameModelResolver({ summary, sensors }), images: [] })
    const fm = makeFrameModelResolver({ calibration, sensors })({ uuid: 'new', sensorId: 'b' })
    expect(fm.dist).toMatchObject({ k1: 0.01 })
    expect(fm.selfCal).toBeNull()
  })
})
