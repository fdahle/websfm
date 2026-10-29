import { describe, it, expect } from 'vitest'
import { createSelfCalFold } from './selfCalFold.js'
import { distortPixel, undistortPixel } from './distortion.js'
import { gcpObservationMover } from './ingest.js'
import { keypointSetFrom } from './keypointSet.js'

const K0 = { fx: 1000, fy: 1000, cx: 640, cy: 480 }
const LENS = { k1: -0.1, k2: 0, k3: 0 }

// One image of one sensor whose lens is LENS about `Ktrue`, with a GCP mark, and a fold
// object over it. `pass(K, bag)` commits a self-calibrating solve that moved the
// principal point to K's and estimated `bag` on the current keypoints.
function setup(Ktrue) {
  const ideal = []
  for (let u = 40; u < 1240; u += 60) for (let v = 40; v < 920; v += 60) ideal.push({ x: u, y: v })
  const img = {
    uuid: 'a',
    sensorId: 's',
    width: 1280,
    height: 960,
    kp: keypointSetFrom(ideal.map((p) => distortPixel(p.x, p.y, Ktrue, LENS))),
  }
  const pristine = img.kp
  const m = distortPixel(200, 150, Ktrue, LENS)
  const mark = { uuid: 'a', px: m.x, py: m.y }
  const pristineMark = [mark.px, mark.py]
  const Kmap = new Map([['a', { ...K0 }]])
  const logs = []
  const fold = createSelfCalFold({
    imgs: [img],
    cameras: new Map(),
    Kmap,
    moveGcpObs: gcpObservationMover([{ observations: [mark] }]),
    sensorIntByUuid: new Map([['a', 0]]),
    fiducialTransforms: new Map(),
    log: (m) => logs.push(m),
  })
  const pass = (K, bag) =>
    fold.fold({
      label: 'test',
      refineMode: 'f,cxcy,k1',
      solvedGroups: new Map([['sensor:0', 0]]),
      refined: [{ ...K, ...bag }],
      kList: [{ ...Kmap.get('a') }],
      camIdxOf: new Map([['a', 0]]),
    })
  return { img, pristine, mark, pristineMark, fold, pass, logs }
}

describe('selfCalFold re-fold (SC-FOLD)', () => {
  it('re-derives the keypoints and marks from pristine once the principal point moves', () => {
    const K1 = { ...K0, cx: 652, cy: 474 } // moved 13.4 px
    const { img, pristine, mark, pristineMark, fold, pass, logs } = setup(K1)
    pass(K0, LENS) // first fold, about the image centre
    pass(K1, { k1: 0.002, k2: 0, k3: 0 }) // the point moves; a small residual bag
    expect(logs.some((l) => /re-folded 1 image/.test(l))).toBe(true)
    const [rec] = fold.distortionSummary()
    expect(rec.fitRmsPx).toBeLessThan(1e-6) // dense reproduces the keypoints exactly
    expect(rec.centreMovedPx).toBeCloseTo(Math.hypot(12, 6), 6)
    // Keypoints and marks are the composed bag on pristine, about the current centre.
    for (const j of [0, 77, pristine.n - 1]) {
      const u = undistortPixel(pristine.xy[2 * j], pristine.xy[2 * j + 1], K1, rec)
      expect(img.kp.xy[2 * j]).toBeCloseTo(u.x, 6)
      expect(img.kp.xy[2 * j + 1]).toBeCloseTo(u.y, 6)
    }
    const m = undistortPixel(...pristineMark, K1, rec)
    expect(mark.px).toBeCloseTo(m.x, 6)
    expect(mark.py).toBeCloseTo(m.y, 6)
  })

  it('leaves the keypoints alone while the move stays under the threshold', () => {
    const K1 = { ...K0, cx: 640.1 }
    const { fold, pass, logs } = setup(K1)
    pass(K0, LENS)
    pass(K1, { k1: 0.002, k2: 0, k3: 0 })
    expect(logs.some((l) => /re-folded/.test(l))).toBe(false)
    expect(fold.distortionSummary()[0].fitRmsPx).toBeLessThan(0.02)
  })
})
