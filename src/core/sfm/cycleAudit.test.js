import { describe, it, expect } from 'vitest'

import { auditPairs, fundamentalFromPoses, sampsonPx, relativePose } from './cycleAudit.js'

const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }
const rotY = (deg) => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]]
}
const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
const project = (cam, X) => {
  const p = cam.R.map((r, i) => r[0] * X[0] + r[1] * X[1] + r[2] * X[2] + cam.t[i])
  return { x: K.fx * p[0] / p[2] + K.cx, y: K.fy * p[1] / p[2] + K.cy }
}

// Two cameras looking at a cloud 5 units ahead; B is rotated 10° and shifted sideways.
const camA = { R: I, t: [0, 0, 0], K }
const camB = { R: rotY(10), t: [-1, 0.1, 0.2], K }
const pts = []
let s = 1
const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5
for (let i = 0; i < 60; i++) pts.push([2 * rnd(), 2 * rnd(), 5 + 2 * rnd()])
const kps = { a: pts.map((X) => project(camA, X)), b: pts.map((X) => project(camB, X)) }
const keypointOf = (id, i) => kps[id][i]
const cameras = new Map([['a', camA], ['b', camB]])
const trueMatches = pts.map((_, i) => [i, i])

describe('fundamentalFromPoses / sampsonPx', () => {
  it('true correspondences sit on the epipolar geometry; wrong ones do not', () => {
    const F = fundamentalFromPoses(camA, camB)
    for (let i = 0; i < pts.length; i++) expect(sampsonPx(F, kps.a[i], kps.b[i])).toBeLessThan(1e-6)
    const off = pts.map((_, i) => sampsonPx(F, kps.a[i], kps.b[(i + 7) % pts.length]))
    expect(off.filter((d) => d > 4).length).toBeGreaterThan(pts.length * 0.8)
  })
})

describe('auditPairs', () => {
  const Rtrue = relativePose(camA, camB).R

  it('bins a true pair with a correct rotation as goodRot', () => {
    const r = auditPairs({ pairs: [{ idA: 'a', idB: 'b', matches: trueMatches }], rotations: new Map([['a--b', Rtrue]]), cameras, keypointOf })
    expect(r.bins.goodRot).toBe(1)
    expect(r.rows[0].agreeFrac).toBe(1)
    expect(r.rows[0].rotErrDeg).toBeLessThan(1e-6)
  })

  it('bins a true pair with a wrong rotation estimate as badRot, and counts degenerate ones', () => {
    const Rwrong = rotY(-25)
    const r = auditPairs({ pairs: [{ idA: 'a', idB: 'b', matches: trueMatches, degenerate: true }], rotations: new Map([['a--b', Rwrong]]), cameras, keypointOf })
    expect(r.bins.badRot).toBe(1)
    expect(r.degenerate.badRot).toBe(1)
    expect(r.rows[0].rotErrDeg).toBeCloseTo(35, 3)
  })

  it('bins a pair whose matches violate the final geometry as false', () => {
    const shuffled = pts.map((_, i) => [i, (i + 7) % pts.length])
    const r = auditPairs({ pairs: [{ idA: 'a', idB: 'b', matches: shuffled }], rotations: new Map([['a--b', Rtrue]]), cameras, keypointOf })
    expect(r.bins.false).toBe(1)
  })

  it('skips pairs with an unregistered image', () => {
    const r = auditPairs({ pairs: [{ idA: 'a', idB: 'c', matches: trueMatches }], rotations: new Map(), cameras, keypointOf })
    expect(r.bins.unposed).toBe(1)
    expect(r.rows).toHaveLength(0)
  })
})
