import { describe, expect, it } from 'vitest'
import { buildCameraPriorConstraints } from './surveyConstraints.js'
import { normalizeLeverArm } from './cameraPriors.js'

// A nadir block whose strips alternate heading, like GeoScan: R maps world → camera
// (camera looks down −Z world, so camera z = −world Z). The SfM frame is the survey
// frame at half scale, so the SfM→survey scale is 2 and every offset must be halved.
const SCALE = 2
const nadir = (yawDeg) => {
  const a = (yawDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return [[c, s, 0], [s, -c, 0], [0, 0, -1]]
}
const mulT = (R, v) => [0, 1, 2].map((i) => R[0][i] * v[0] + R[1][i] * v[1] + R[2][i] * v[2])
const ARM = [0.05, -0.41, -0.12] // metres, camera axes

function block() {
  const cams = new Map(), priors = []
  const centres = [[0, 0, 100], [40, 0, 101], [80, 0, 99], [80, 30, 100], [40, 30, 102], [0, 30, 100]]
  centres.forEach((Cs, i) => {
    const R = nadir(i < 3 ? 0 : 180)
    const Csfm = Cs.map((v) => v / SCALE)
    const t = [0, 1, 2].map((r) => -(R[r][0] * Csfm[0] + R[r][1] * Csfm[1] + R[r][2] * Csfm[2]))
    const uuid = `c${i}`
    cams.set(uuid, { R, t })
    const antenna = Cs.map((v, k) => v + mulT(R, ARM)[k])
    priors.push({ uuid, x: antenna[0], y: antenna[1], z: antenna[2],
      accuracyX: 0.02, accuracyY: 0.02, accuracyZ: 0.03, trueSfm: Csfm })
  })
  return { cams, priors }
}

describe('buildCameraPriorConstraints — GNSS lever arm', () => {
  it('targets the camera centre, not the antenna, when the prior carries the arm', () => {
    const { cams, priors } = block()
    const out = buildCameraPriorConstraints({
      cameras: cams, cameraPriors: priors.map((p) => ({ ...p, leverArm: ARM })), uuidList: [...cams.keys()],
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
