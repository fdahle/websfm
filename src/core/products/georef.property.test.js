import { beforeAll, describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fitSimilarity } from './georef.js'
import { fitSimilarity2d } from '../sfm/referenceLook.js'
import { quatToRotation } from '../io/colmapModel.js'
import { ensureProjection, transform } from '../crs.js'

// Properties of georeferencing that follow from the maths, over random inputs: a
// similarity fitted to exactly transformed points is that similarity; the fit moves
// with the data (fitting T∘S gives T∘S); the order of the points does not matter; and
// CRS transforms invert exactly. Coordinates reach UTM sizes (10⁶ m), where a fit that
// does not centre its points first loses its digits.

const num = (min, max) => fc.double({ min, max, noNaN: true, noDefaultInfinity: true })
const rotation = fc
  .tuple(num(-1, 1), num(-1, 1), num(-1, 1), num(-1, 1))
  .filter((q) => Math.hypot(...q) > 1e-3)
  .map(quatToRotation)
const similarity = fc.record({
  s: num(0.01, 1000),
  R: rotation,
  t: fc.tuple(num(-2e6, 2e6), num(-2e6, 2e6), num(-500, 5000)),
})
// 4–30 points spread through a box, so the configuration is never close to collinear.
const cloud = fc
  .array(fc.tuple(num(-50, 50), num(-50, 50), num(-20, 20)), { minLength: 4, maxLength: 30 })
  .filter((ps) => spread(ps) > 5)
function spread(ps) {
  // The smallest singular direction's extent, roughly: the cloud's thinnest width.
  const c = [0, 1, 2].map((i) => ps.reduce((a, p) => a + p[i], 0) / ps.length)
  const C = [0, 1, 2].map((i) => [0, 1, 2].map((j) => ps.reduce((a, p) => a + (p[i] - c[i]) * (p[j] - c[j]), 0)))
  const tr = C[0][0] + C[1][1] + C[2][2]
  const det =
    C[0][0] * (C[1][1] * C[2][2] - C[1][2] * C[2][1]) -
    C[0][1] * (C[1][0] * C[2][2] - C[1][2] * C[2][0]) +
    C[0][2] * (C[1][0] * C[2][1] - C[1][1] * C[2][0])
  return det / (tr * tr) // ~ the smallest eigenvalue, scale-free
}
const apply = ({ s, R, t }, p) => [0, 1, 2].map((i) => s * (R[i][0] * p[0] + R[i][1] * p[1] + R[i][2] * p[2]) + t[i])
const compose = (A, B) => ({
  // A∘B: x ↦ A(B(x))
  s: A.s * B.s,
  R: [0, 1, 2].map((i) => [0, 1, 2].map((j) => A.R[i][0] * B.R[0][j] + A.R[i][1] * B.R[1][j] + A.R[i][2] * B.R[2][j])),
  t: apply(A, B.t),
})
function expectSame(fit, S, size) {
  expect(Math.abs(fit.scale - S.s) / S.s).toBeLessThan(1e-8)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(Math.abs(fit.R[i][j] - S.R[i][j])).toBeLessThan(1e-8)
  for (let i = 0; i < 3; i++) expect(Math.abs(fit.t[i] - S.t[i])).toBeLessThan(1e-8 * Math.max(size, 1))
}
const sizeOf = (S) => Math.max(...S.t.map(Math.abs), S.s * 100)

describe('fitSimilarity (3D)', () => {
  it('recovers the similarity that transformed the points', () => {
    fc.assert(
      fc.property(similarity, cloud, (S, ps) => {
        const fit = fitSimilarity(ps.map((p) => ({ src: p, dst: apply(S, p) })))
        expectSame(fit, S, sizeOf(S))
        expect(fit.rms).toBeLessThan(1e-7 * sizeOf(S))
      }),
      { numRuns: 300 },
    )
  })

  it('moves with the data: fitting T∘S gives T∘S', () => {
    fc.assert(
      fc.property(similarity, similarity, cloud, (S, Tr, ps) => {
        const TS = compose(Tr, S)
        fc.pre(TS.s > 1e-3 && TS.s < 1e5)
        expectSame(fitSimilarity(ps.map((p) => ({ src: p, dst: apply(TS, p) }))), TS, sizeOf(TS))
      }),
    )
  })

  it('does not depend on the order of the points', () => {
    fc.assert(
      fc.property(similarity, cloud, fc.integer({ min: 1, max: 1000 }), (S, ps, seed) => {
        const pairs = ps.map((p) => ({
          src: p,
          dst: apply(S, p).map((v, i) => v + 0.01 * Math.sin(seed * (i + 1) + p[0])),
        }))
        const shuffled = [...pairs].sort((a, b) => Math.sin(seed * a.src[0]) - Math.sin(seed * b.src[0]))
        const a = fitSimilarity(pairs),
          b = fitSimilarity(shuffled)
        expect(Math.abs(a.scale - b.scale) / a.scale).toBeLessThan(1e-9)
        for (let i = 0; i < 3; i++) expect(Math.abs(a.t[i] - b.t[i])).toBeLessThan(1e-6 * sizeOf(S))
      }),
    )
  })

  it('refuses collinear points, which leave the rotation about their line open', () => {
    fc.assert(
      fc.property(similarity, fc.array(num(-50, 50), { minLength: 3, maxLength: 20 }), (S, ts) => {
        const ps = ts.map((u) => [u, 2 * u + 1, -u])
        expect(fitSimilarity(ps.map((p) => ({ src: p, dst: apply(S, p) })))).toBeNull()
      }),
    )
  })
})

describe('fitSimilarity2d', () => {
  it('recovers the 2D similarity that transformed the points', () => {
    const pts = fc.array(fc.tuple(num(-1000, 1000), num(-1000, 1000)), { minLength: 3, maxLength: 30 }).filter((ps) => {
      const cx = ps.reduce((a, p) => a + p[0], 0) / ps.length
      const cy = ps.reduce((a, p) => a + p[1], 0) / ps.length
      return ps.some((p) => Math.hypot(p[0] - cx, p[1] - cy) > 100)
    })
    fc.assert(
      fc.property(pts, num(0.01, 100), num(-Math.PI, Math.PI), num(-1e5, 1e5), num(-1e5, 1e5), (ps, s, th, tx, ty) => {
        const a = s * Math.cos(th),
          b = s * Math.sin(th)
        const pairs = ps.map((p) => ({ p, q: [a * p[0] - b * p[1] + tx, b * p[0] + a * p[1] + ty] }))
        // Its documented guard: both point sets must spread at least 3 units (RMS about
        // their centroid), or the fit says nothing and it returns null.
        const rmsSpread = (k) => {
          const c = [0, 1].map((i) => pairs.reduce((t, pq) => t + pq[k][i], 0) / pairs.length)
          return Math.sqrt(
            pairs.reduce((t, pq) => t + (pq[k][0] - c[0]) ** 2 + (pq[k][1] - c[1]) ** 2, 0) / pairs.length,
          )
        }
        const thin = Math.min(rmsSpread('p'), rmsSpread('q'))
        fc.pre(Math.abs(thin - 3) > 0.01) // right at the threshold, rounding decides
        if (thin < 3) {
          expect(fitSimilarity2d(pairs)).toBeNull()
          return
        }
        const fit = fitSimilarity2d(pairs)
        expect(Math.abs(fit.scale - s) / s).toBeLessThan(1e-8)
        expect(Math.abs(fit.a - a)).toBeLessThan(1e-8 * s)
        expect(Math.abs(fit.b - b)).toBeLessThan(1e-8 * s)
        expect(Math.abs(fit.tx - tx)).toBeLessThan(1e-6 * (1 + Math.abs(tx)))
        expect(Math.abs(fit.ty - ty)).toBeLessThan(1e-6 * (1 + Math.abs(ty)))
      }),
    )
  })
})

describe('CRS transforms invert exactly', () => {
  beforeAll(async () => {
    for (const c of ['EPSG:4326', 'EPSG:3031', 'EPSG:32632', 'EPSG:3857']) await ensureProjection(c)
  })
  const CASES = [
    // [projected CRS, longitude range, latitude range] within its area of use.
    ['EPSG:3031', [-180, 180], [-89.9, -60]],
    ['EPSG:32632', [6, 12], [0, 84]],
    ['EPSG:3857', [-180, 180], [-85, 85]],
  ]
  for (const [crs, [lon0, lon1], [lat0, lat1]] of CASES) {
    it(`EPSG:4326 → ${crs} → EPSG:4326`, () => {
      fc.assert(
        fc.property(num(lon0, lon1), num(lat0, lat1), num(-500, 5000), (lon, lat, h) => {
          const p = transform([lon, lat, h], 'EPSG:4326', crs)
          const back = transform(p, crs, 'EPSG:4326')
          // 1e-9° is 0.1 mm; longitude is undefined at the pole itself.
          expect(Math.abs(back[1] - lat)).toBeLessThan(1e-9)
          const dLon = ((((back[0] - lon + 180) % 360) + 360) % 360) - 180
          expect(Math.abs(dLon) * Math.cos((lat * Math.PI) / 180)).toBeLessThan(1e-9)
          expect(back[2]).toBe(h)
        }),
      )
    })
  }
})
