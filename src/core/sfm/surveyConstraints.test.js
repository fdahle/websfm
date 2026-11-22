import { describe, expect, it } from 'vitest'
import { buildCameraPriorConstraints, priorHeightRule, priorHeightResidual } from './surveyConstraints.js'
import { normalizeLeverArm } from './cameraPriors.js'
import { frameFromSimilarity } from '../products/georef.js'

// A nadir block whose strips alternate heading, like GeoScan: R maps world → camera
// (camera looks down −Z world, so camera z = −world Z). The SfM frame is the survey
// frame at half scale, so the SfM→survey scale is 2 and every offset must be halved.
const SCALE = 2
const nadir = (yawDeg) => {
  const a = (yawDeg * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a)
  return [
    [c, s, 0],
    [s, -c, 0],
    [0, 0, -1],
  ]
}
const mulT = (R, v) => [0, 1, 2].map((i) => R[0][i] * v[0] + R[1][i] * v[1] + R[2][i] * v[2])
const ARM = [0.05, -0.41, -0.12] // metres, camera axes

function block() {
  const cams = new Map(),
    priors = []
  const centres = [
    [0, 0, 100],
    [40, 0, 101],
    [80, 0, 99],
    [80, 30, 100],
    [40, 30, 102],
    [0, 30, 100],
  ]
  centres.forEach((Cs, i) => {
    const R = nadir(i < 3 ? 0 : 180)
    const Csfm = Cs.map((v) => v / SCALE)
    const t = [0, 1, 2].map((r) => -(R[r][0] * Csfm[0] + R[r][1] * Csfm[1] + R[r][2] * Csfm[2]))
    const uuid = `c${i}`
    cams.set(uuid, { R, t })
    const antenna = Cs.map((v, k) => v + mulT(R, ARM)[k])
    priors.push({
      uuid,
      x: antenna[0],
      y: antenna[1],
      z: antenna[2],
      accuracyX: 0.02,
      accuracyY: 0.02,
      accuracyZ: 0.03,
      trueSfm: Csfm,
    })
  })
  return { cams, priors }
}

describe('buildCameraPriorConstraints — GNSS lever arm', () => {
  it('targets the camera centre, not the antenna, when the prior carries the arm', () => {
    const { cams, priors } = block()
    const out = buildCameraPriorConstraints({
      cameras: cams,
      cameraPriors: priors.map((p) => ({ ...p, leverArm: ARM })),
      uuidList: [...cams.keys()],
    })
    expect(out.fit.scale).toBeCloseTo(SCALE, 6)
    for (const c of out.priors) {
      const truth = priors[c.camIdx].trueSfm
      c.target.forEach((v, k) => expect(v).toBeCloseTo(truth[k], 6))
    }
  })

  it('without the arm, alternating strips leave every centre about |a|/s off', () => {
    const { cams, priors } = block()
    const out = buildCameraPriorConstraints({ cameras: cams, cameraPriors: priors, uuidList: [...cams.keys()] })
    const err = out.priors.map((c) => Math.hypot(...c.target.map((v, k) => v - priors[c.camIdx].trueSfm[k])))
    const armSfm = Math.hypot(...ARM) / SCALE
    // The heading alternates, so the similarity cannot absorb the offset; each centre
    // is pulled most of the way onto its antenna.
    for (const e of err) expect(e).toBeGreaterThan(0.5 * armSfm)
  })
})

describe('normalizeLeverArm', () => {
  it('keeps a finite 3-vector and treats absent / zero / malformed as no offset', () => {
    expect(normalizeLeverArm(['0.1', -0.4, 0])).toEqual([0.1, -0.4, 0])
    expect(normalizeLeverArm([0, 0, 0])).toBeNull()
    expect(normalizeLeverArm([1, 2])).toBeNull()
    expect(normalizeLeverArm([1, NaN, 2])).toBeNull()
    expect(normalizeLeverArm(null)).toBeNull()
  })
})

describe('camera heights against GCP heights', () => {
  it('holds one known datum, tests an unknown one, and drops heights known to differ', () => {
    expect(priorHeightRule(['geoid:EGM2008'], ['geoid:EGM2008'])).toBe('hold')
    expect(priorHeightRule(['local'], ['local'])).toBe('hold')
    expect(priorHeightRule(['orthometric'], ['unknown'])).toBe('test')
    expect(priorHeightRule([undefined], ['ellipsoidal'])).toBe('test')
    expect(priorHeightRule(['orthometric'], ['ellipsoidal'])).toBe('plan')
    // GCPs in two datums cannot both match the cameras.
    expect(priorHeightRule(['ellipsoidal', 'orthometric'], ['ellipsoidal'])).toBe('plan')
  })

  // The block of the lever-arm tests at survey scale, the GCPs' frame the survey frame.
  const sfmToSurvey = {
    scale: SCALE,
    R: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    t: [0, 0, 0],
  }
  const reference = (datums) => ({
    fit: sfmToSurvey,
    frame: frameFromSimilarity(sfmToSurvey, 'local'),
    control: { datums, groundZ: 0 },
  })
  const atCentres = (dz, datum) =>
    block().priors.map((p) => ({
      ...p,
      x: p.trueSfm[0] * SCALE,
      y: p.trueSfm[1] * SCALE,
      z: p.trueSfm[2] * SCALE + dz,
      verticalDatum: datum,
    }))

  it('an offset beyond noise and a plausible focal error moves the heights onto the GCPs, still held', () => {
    const { cams } = block()
    // 100 m above the GCPs: the limit is max(5 × 3 cm, 2 % of 100 m) = 2 m.
    const built = (dz, datum = 'unknown', datums = ['unknown']) =>
      buildCameraPriorConstraints({
        cameras: cams,
        cameraPriors: atCentres(dz, datum),
        uuidList: [...cams.keys()],
        reference: reference(datums),
      })
    const far = built(3)
    expect(far.heights).toMatchObject({ rule: 'test', held: false })
    expect(far.heights.offset).toBeCloseTo(3, 6)
    expect(far.heights.limit).toBeCloseTo(2, 1)
    // Moved back by the 3 m measured: each target is its camera's centre again, and the
    // heights keep their full weight (their differences still hold the block).
    const truth = block().priors
    for (const p of far.priors) {
      p.target.forEach((v, k) => expect(v).toBeCloseTo(truth[p.camIdx].trueSfm[k], 6))
      expect(p.weights[2]).toBeGreaterThan(0)
    }
    const near = built(1.5)
    expect(near.heights.held).toBe(true)
    // Held as they are: 1.5 m above, 0.75 in the half-scale SfM frame.
    expect(near.priors[0].target[2] - truth[0].trueSfm[2]).toBeCloseTo(0.75, 6)
    // Declared as one datum, even 3 m is held: the labels are trusted.
    expect(built(3, 'ellipsoidal', ['ellipsoidal']).heights.held).toBe(true)
    // Declared as different datums, even a small offset is moved.
    expect(built(0.1, 'ellipsoidal', ['orthometric']).heights).toMatchObject({ rule: 'plan', held: false })
  })

  it('without GCP control (a positions-only solve) nothing is tested', () => {
    const { cams } = block()
    const out = buildCameraPriorConstraints({
      cameras: cams,
      cameraPriors: atCentres(40, 'unknown'),
      uuidList: [...cams.keys()],
    })
    expect(out.heights).toBeUndefined()
    expect(out.priors[0].weights[2]).toBeGreaterThan(0)
  })

  it('measures the mean height of the positions against the solved antennas', () => {
    const { cams, priors } = block()
    const frame = frameFromSimilarity(sfmToSurvey, 'local')
    const withArm = priors.map((p) => ({ ...p, leverArm: ARM, z: p.z + 0.18 }))
    const r = priorHeightResidual({ cameras: cams, cameraPriors: withArm, uuidList: [...cams.keys()], frame })
    expect(r.n).toBe(6)
    expect(r.offset).toBeCloseTo(0.18, 6)
    expect(r.sigmaZ).toBeCloseTo(0.03, 9)
  })
})
