import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { opkMatrix, opkFromMatrix } from './footprint.js'
import { quatToRotation, rotationToQuat } from './io/colmapModel.js'

// Properties every rotation conversion must have, whatever its inputs: a proper
// rotation (orthonormal, determinant +1), the defining composition, and exact round
// trips. fast-check draws the inputs and shrinks a failure to its smallest case.

const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]))
const T = (A) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[j][i]))
const det = (A) =>
  A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
  A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
  A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])
const maxDiff = (A, B) => Math.max(...A.flatMap((r, i) => r.map((v, j) => Math.abs(v - B[i][j]))))
const I = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
function expectRotation(R) {
  expect(maxDiff(mul(R, T(R)), I)).toBeLessThan(1e-12)
  expect(Math.abs(det(R) - 1)).toBeLessThan(1e-12)
}
const deg = (min, max) => fc.double({ min, max, noNaN: true, noDefaultInfinity: true })
// An angle difference folded into (−180°, 180°].
const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180

describe('omega / phi / kappa', () => {
  it('gives a proper rotation for any angles', () => {
    fc.assert(
      fc.property(deg(-720, 720), deg(-720, 720), deg(-720, 720), (o, p, k) => expectRotation(opkMatrix(o, p, k))),
    )
  })

  it('is Rx(ω)·Ry(φ)·Rz(κ)', () => {
    const r = (a) => (a * Math.PI) / 180
    const Rx = (a) => [
      [1, 0, 0],
      [0, Math.cos(r(a)), -Math.sin(r(a))],
      [0, Math.sin(r(a)), Math.cos(r(a))],
    ]
    const Ry = (a) => [
      [Math.cos(r(a)), 0, Math.sin(r(a))],
      [0, 1, 0],
      [-Math.sin(r(a)), 0, Math.cos(r(a))],
    ]
    const Rz = (a) => [
      [Math.cos(r(a)), -Math.sin(r(a)), 0],
      [Math.sin(r(a)), Math.cos(r(a)), 0],
      [0, 0, 1],
    ]
    fc.assert(
      fc.property(deg(-180, 180), deg(-180, 180), deg(-180, 180), (o, p, k) => {
        expect(maxDiff(opkMatrix(o, p, k), mul(mul(Rx(o), Ry(p)), Rz(k)))).toBeLessThan(1e-12)
      }),
    )
  })

  it('round-trips through the matrix away from φ = ±90°', () => {
    fc.assert(
      fc.property(deg(-180, 180), deg(-89, 89), deg(-180, 180), (o, p, k) => {
        const back = opkFromMatrix(opkMatrix(o, p, k))
        expect(Math.abs(wrap(back.omega - o))).toBeLessThan(1e-7)
        expect(Math.abs(back.phi - p)).toBeLessThan(1e-7)
        expect(Math.abs(wrap(back.kappa - k))).toBeLessThan(1e-7)
      }),
    )
  })

  it('reads back any rotation matrix it is given', () => {
    // Angles from a matrix, then the matrix from them: the same rotation, even where
    // the angles themselves are not the ones that built it (φ past ±90°).
    fc.assert(
      fc.property(deg(-180, 180), deg(-180, 180), deg(-180, 180), (o, p, k) => {
        const M = opkMatrix(o, p, k)
        const a = opkFromMatrix(M)
        fc.pre(a !== null)
        expect(maxDiff(opkMatrix(a.omega, a.phi, a.kappa), M)).toBeLessThan(1e-9)
      }),
    )
  })
})

describe('quaternions', () => {
  const quat = fc.tuple(deg(-1, 1), deg(-1, 1), deg(-1, 1), deg(-1, 1)).filter((q) => Math.hypot(...q) > 1e-3)

  it('give a proper rotation, whatever their length', () => {
    fc.assert(fc.property(quat, (q) => expectRotation(quatToRotation(q))))
  })

  it('q, −q and any multiple of q are the same rotation', () => {
    fc.assert(
      fc.property(quat, deg(0.01, 100), (q, s) => {
        const R = quatToRotation(q)
        expect(maxDiff(quatToRotation(q.map((v) => -v)), R)).toBeLessThan(1e-12)
        expect(maxDiff(quatToRotation(q.map((v) => s * v)), R)).toBeLessThan(1e-12)
      }),
    )
  })

  it('round-trip: matrix → quaternion → matrix', () => {
    fc.assert(
      fc.property(quat, (q) => {
        const R = quatToRotation(q)
        expect(maxDiff(quatToRotation(rotationToQuat(R)), R)).toBeLessThan(1e-12)
      }),
    )
  })

  it('come back unit length with qw ≥ 0 (COLMAP’s convention)', () => {
    fc.assert(
      fc.property(quat, (q) => {
        const back = rotationToQuat(quatToRotation(q))
        expect(Math.abs(Math.hypot(...back) - 1)).toBeLessThan(1e-12)
        expect(back[0]).toBeGreaterThanOrEqual(0)
      }),
    )
  })

  it('compose as rotations do: R(q1·q2) = R(q1)·R(q2)', () => {
    const hamilton = ([a1, b1, c1, d1], [a2, b2, c2, d2]) => [
      a1 * a2 - b1 * b2 - c1 * c2 - d1 * d2,
      a1 * b2 + b1 * a2 + c1 * d2 - d1 * c2,
      a1 * c2 - b1 * d2 + c1 * a2 + d1 * b2,
      a1 * d2 + b1 * c2 - c1 * b2 + d1 * a2,
    ]
    fc.assert(
      fc.property(quat, quat, (q1, q2) => {
        const n = (q) => q.map((v) => v / Math.hypot(...q))
        expect(
          maxDiff(quatToRotation(hamilton(n(q1), n(q2))), mul(quatToRotation(q1), quatToRotation(q2))),
        ).toBeLessThan(1e-12)
      }),
    )
  })
})
