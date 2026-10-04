import { describe, it, expect } from 'vitest'
import { gridToLocal, localToGrid, buildMetricFrame, precisionToLocal } from './localFrame.js'
import { fitGeoreference, fitSimilarity, applySimilarity, frameFromSimilarity } from './georef.js'
import { geodeticToEcef } from './tiles3d.js'
import { ensureProjection, transform } from '../crs.js'

const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
const rms = (pairs, sim) => Math.sqrt(pairs.reduce((s, { src, dst }) => {
  const p = applySimilarity(sim, src)
  return s + (p[0] - dst[0]) ** 2 + (p[1] - dst[1]) ** 2 + (p[2] - dst[2]) ** 2
}, 0) / pairs.length)

// Error-free control on a real polar block: geodetic points → true Cartesian
// (ECEF, then an arbitrary similarity = the "SfM" frame) and → EPSG:3031 grid +
// ellipsoidal height (the surveyed coordinates). Any fit residual is model error.
async function polarBlock({ lat, extentM, reliefM, n = 40, seed = 3 }) {
  await ensureProjection('EPSG:3031')
  const r = rng(seed), dLat = extentM / 111000, dLon = extentM / (111000 * Math.cos(lat * Math.PI / 180))
  const c = 0.3, s = Math.sin(0.4), co = Math.cos(0.4)
  return Array.from({ length: n }, () => {
    const la = lat + (r() - 0.5) * dLat, lo = 40 + (r() - 0.5) * dLon, h = 200 + r() * reliefM
    const e = geodeticToEcef(lo, la, h)
    const src = [c * (co * e[0] - s * e[1]) + 5, c * (s * e[0] + co * e[1]) - 7, c * e[2] + 11]
    const [x, y] = transform([lo, la], 'EPSG:4326', 'EPSG:3031')
    return { src, dst: [x, y, h] }
  })
}
const toLonLat = (xy) => transform(xy, 'EPSG:3031', 'EPSG:4326')

describe('local metric frame', () => {
  it('grid ↔ local are exact inverses', () => {
    const f = { e0: 1e6, n0: -2e6, k: 0.98, R: 6.36e6 }
    for (const p of [[1e6, -2e6, 0], [1.004e6, -1.997e6, 812.5]]) {
      const back = localToGrid(gridToLocal(p, f), f)
      p.forEach((v, i) => expect(back[i]).toBeCloseTo(v, 6))
    }
  })

  it('measures the EPSG:3031 point scale factor', async () => {
    await ensureProjection('EPSG:3031')
    const [x, y] = transform([0, -80], 'EPSG:4326', 'EPSG:3031')
    expect(buildMetricFrame(toLonLat, x, y).k).toBeCloseTo(0.98021, 4)
    expect(buildMetricFrame(toLonLat, 0, 0).k).toBeCloseTo(0.97277, 4) // the pole
  })

  it('scales a precision matrix into the frame (σ_ground = σ_grid / k)', () => {
    const P = precisionToLocal([[1, 0, 0], [0, 4, 0], [0, 0, 9]], { k: 0.5 })
    expect(P).toEqual([[0.25, 0, 0], [0, 1, 0], [0, 0, 9]])
  })

  for (const site of [{ lat: -80, extentM: 6000, reliefM: 400 }, { lat: -85, extentM: 10000, reliefM: 1000 }]) {
    it(`fits error-free polar control to centimetres (${site.lat}°, ${site.extentM / 1000} km)`, async () => {
      const pairs = await polarBlock(site)
      const cx = pairs.reduce((s, p) => s + p.dst[0], 0) / pairs.length
      const cy = pairs.reduce((s, p) => s + p.dst[1], 0) / pairs.length
      const local = buildMetricFrame(toLonLat, cx, cy)
      const fit = fitGeoreference(pairs, local)
      expect(rms(pairs, fit)).toBeLessThan(0.01)
      // The grid fit this replaces leaves metres of pure model error.
      expect(rms(pairs, fitSimilarity(pairs))).toBeGreaterThan(1)
      // The product frame inverts it exactly.
      const frame = frameFromSimilarity(fit, 'EPSG:3031')
      const back = frame.toSfm(frame.fromSfm(pairs[0].src))
      back.forEach((v, i) => expect(v).toBeCloseTo(pairs[0].src[i], 6))
    })
  }
})
