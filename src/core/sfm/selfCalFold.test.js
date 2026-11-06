import { describe, it, expect } from 'vitest'
import { createSelfCalFold } from './selfCalFold.js'
import { distortPixel, undistortPixel } from './distortion.js'
import { gcpObservationMover } from './ingest.js'
import { keypointSetFrom } from './keypointSet.js'

const K0 = { fx: 1000, fy: 1000, cx: 640, cy: 480 }
const LENS = { k1: -0.1, k2: 0.02, k3: 0, p1: 0.0015, p2: -0.0007 }

// One image of one pinhole-calibrated sensor whose recorded pixels went through LENS
// about `Ktrue`, with a GCP mark. `pass(K, lens)` commits a self-calibrating solve that
// found K and the whole lens `lens` (bundleAdjust fullLens).
function setup(Ktrue) {
  const ideal = []
  for (let u = 40; u < 1240; u += 60) for (let v = 40; v < 920; v += 60) ideal.push({ x: u, y: v })
  const recorded = keypointSetFrom(ideal.map((p) => distortPixel(p.x, p.y, Ktrue, LENS)))
  const img = { uuid: 'a', sensorId: 's', width: 1280, height: 960, kp: recorded }
  const m = distortPixel(200, 150, Ktrue, LENS)
  const mark = { uuid: 'a', px: m.x, py: m.y }
  const recordedMark = [mark.px, mark.py]
  const Kmap = new Map([['a', { ...K0 }]])
  const logs = []
  const state = createSelfCalFold({
    imgs: [img],
    cameras: new Map(),
    Kmap,
    moveGcpObs: gcpObservationMover([{ observations: [mark] }]),
    sensorIntByUuid: new Map([['a', 0]]),
    fiducialTransforms: new Map(),
    log: (msg) => logs.push(msg),
  })
  const pass = (K, lens) =>
    state.fold({
      label: 'test',
      refineMode: 'f,cxcy,k1,k2,p',
      solvedGroups: new Map([['sensor:0', 0]]),
      refined: [{ ...K, ...lens }],
      kList: [{ ...Kmap.get('a') }],
      camIdxOf: new Map([['a', 0]]),
    })
  return { img, recorded, mark, recordedMark, state, pass, logs, Kmap }
}

describe('selfCalFold: the view is the record through the current lens', () => {
  it('re-derives keypoints and marks from the record after each solve, without compounding', () => {
    const K1 = { ...K0, cx: 652, cy: 474 }
    const { img, recorded, mark, recordedMark, state, pass, logs, Kmap } = setup(K1)
    // A first solve with a rough lens about the centre, then the final one.
    pass(K0, { k1: -0.08, k2: 0, k3: 0, p1: 0, p2: 0 })
    pass(K1, LENS)
    expect(logs.some((l) => /re-derived 1 image/.test(l))).toBe(true)
    // The view is the record undistorted ONCE by the final lens about the final K,
    // whatever the solves before it did.
    for (const j of [0, 77, recorded.n - 1]) {
      const u = undistortPixel(recorded.xy[2 * j], recorded.xy[2 * j + 1], K1, LENS)
      expect(img.kp.xy[2 * j]).toBeCloseTo(u.x, 6)
      expect(img.kp.xy[2 * j + 1]).toBeCloseTo(u.y, 6)
    }
    const m = undistortPixel(...recordedMark, K1, LENS)
    expect(mark.px).toBeCloseTo(m.x, 6)
    expect(mark.py).toBeCloseTo(m.y, 6)
    // Kmap stays pinhole: the lens lives in the lens state.
    expect(Kmap.get('a')).toMatchObject({ ...K1, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 })
    // The summary row is the WHOLE solved lens, which replaces the sensor's.
    const [row] = state.distortionSummary()
    expect(row).toMatchObject({ sensorId: 's', full: true, ...LENS })
    // The BA seed for the next solve is that lens.
    expect(state.baLensOf('a')).toEqual({ k1: LENS.k1, k2: LENS.k2, k3: LENS.k3, p1: LENS.p1, p2: LENS.p2 })
  })

  it('keeps the record as the view while the lens stays pinhole', () => {
    const { img, recorded, state, pass } = setup(K0)
    pass({ ...K0, fx: 1010 }, { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 })
    expect(img.kp).toBe(recorded) // only K changed: a lens-free view is the record
    expect(state.distortionSummary()).toEqual([])
  })
})
