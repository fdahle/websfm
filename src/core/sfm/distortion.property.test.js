import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { distortNormalized, undistortNormalized, distortPixel, undistortPixel } from './distortion.js'

// Properties of the lens models that follow from their definition, over random lenses
// and points: the inverse undoes the forward model, a radial lens commutes with a
// rotation about the principal point, resizing the image scales the distorted pixel
// with it, and zero coefficients change nothing. The lenses stay where they map rays
// to points one to one (a strong barrel polynomial folds back past some radius).
// colmapCameras.test.js checks the same models against COLMAP's own projections.

const num = (min, max) => fc.double({ min, max, noNaN: true, noDefaultInfinity: true })
const brown = fc.record({
  k1: num(-0.3, 0.3),
  k2: num(-0.08, 0.08),
  k3: num(-0.02, 0.02),
  p1: num(-0.003, 0.003),
  p2: num(-0.003, 0.003),
})
const rational = fc.record({
  k1: num(-0.3, 0.3),
  k2: num(-0.08, 0.08),
  k3: num(-0.02, 0.02),
  k4: num(-0.05, 0.05),
  k5: num(-0.02, 0.02),
  k6: num(-0.01, 0.01),
  p1: num(-0.003, 0.003),
  p2: num(-0.003, 0.003),
})
const fisheye = fc
  .record({ k1: num(-0.05, 0.08), k2: num(-0.02, 0.02), k3: num(-0.005, 0.005), k4: num(-0.001, 0.001) })
  .map((k) => ({ fisheye: true, ...k }))
// A normalised image point within radius `r` (tan of the widest ray angle).
const point = (r) =>
  fc
    .tuple(num(0, 1), num(0, 2 * Math.PI))
    .map(([u, a]) => [r * Math.sqrt(u) * Math.cos(a), r * Math.sqrt(u) * Math.sin(a)])
const LENSES = [
  ['Brown', brown, point(0.5)],
  ['rational', rational, point(0.5)],
  ['fisheye', fisheye, point(Math.tan((70 * Math.PI) / 180))],
]

describe('lens model properties', () => {
  for (const [name, lens, pt] of LENSES) {
    it(`${name}: undistorting a distorted point gives it back`, () => {
      fc.assert(
        fc.property(lens, pt, (d, [x, y]) => {
          const [xd, yd] = distortNormalized(x, y, d)
          const [bx, by] = undistortNormalized(xd, yd, d)
          expect(Math.abs(bx - x)).toBeLessThan(1e-9 * Math.max(1, Math.hypot(x, y)))
          expect(Math.abs(by - y)).toBeLessThan(1e-9 * Math.max(1, Math.hypot(x, y)))
        }),
        { numRuns: 500 },
      )
    })

    it(`${name}: resizing the image resizes the distorted pixel with it`, () => {
      fc.assert(
        fc.property(lens, pt, num(0.1, 8), num(300, 3000), (d, [x, y], s, f) => {
          const K = { fx: f, fy: f * 1.01, cx: 0.5 * f, cy: 0.4 * f }
          const Ks = { fx: s * K.fx, fy: s * K.fy, cx: s * K.cx, cy: s * K.cy }
          const u = K.fx * x + K.cx,
            v = K.fy * y + K.cy
          const a = distortPixel(u, v, K, d),
            b = distortPixel(s * u, s * v, Ks, d)
          expect(Math.abs(b.x - s * a.x)).toBeLessThan(1e-7 * s * f)
          expect(Math.abs(b.y - s * a.y)).toBeLessThan(1e-7 * s * f)
          const back = undistortPixel(b.x, b.y, Ks, d)
          expect(Math.abs(back.x - s * u)).toBeLessThan(1e-6 * s * f)
          expect(Math.abs(back.y - s * v)).toBeLessThan(1e-6 * s * f)
        }),
      )
    })
  }

  it('a radial lens commutes with a rotation about the principal point', () => {
    const radial = fc.oneof(
      brown.map((d) => ({ ...d, p1: 0, p2: 0 })),
      rational.map((d) => ({ ...d, p1: 0, p2: 0 })),
      fisheye,
    )
    fc.assert(
      fc.property(radial, point(0.5), num(-Math.PI, Math.PI), (d, [x, y], a) => {
        const rot = ([px, py]) => [Math.cos(a) * px - Math.sin(a) * py, Math.sin(a) * px + Math.cos(a) * py]
        const one = rot(distortNormalized(x, y, d))
        const two = distortNormalized(...rot([x, y]), d)
        expect(Math.abs(one[0] - two[0])).toBeLessThan(1e-12)
        expect(Math.abs(one[1] - two[1])).toBeLessThan(1e-12)
      }),
    )
  })

  it('zero coefficients change nothing', () => {
    const zeros = [
      { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 },
      { k1: 0, k2: 0, k3: 0, k4: 0, k5: 0, k6: 0, p1: 0, p2: 0 },
    ]
    fc.assert(
      fc.property(fc.constantFrom(...zeros), point(1), (d, [x, y]) => {
        // The same point, value for value: −0 and +0 are one position (toEqual would
        // tell them apart, and fast-check does draw −0).
        const same = ([u, v]) =>
          expect([u === x || (u === 0 && x === 0), v === y || (v === 0 && y === 0)]).toEqual([true, true])
        same(distortNormalized(x, y, d))
        same(undistortNormalized(x, y, d))
      }),
    )
  })

  it('an equidistant fisheye (all k = 0) puts a ray at angle θ at radius θ', () => {
    fc.assert(
      fc.property(num(0, 1.4), num(-Math.PI, Math.PI), (theta, a) => {
        const r = Math.tan(theta)
        const [xd, yd] = distortNormalized(r * Math.cos(a), r * Math.sin(a), {
          fisheye: true,
          k1: 0,
          k2: 0,
          k3: 0,
          k4: 0,
        })
        expect(Math.abs(Math.hypot(xd, yd) - theta)).toBeLessThan(1e-12)
      }),
    )
  })
})
