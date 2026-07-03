import { describe, it, expect } from 'vitest'
import { fitSimilarity, applySimilarity, frameFromSimilarity } from './georef.js'

const close = (a, b, eps = 1e-4) => expect(Math.abs(a - b)).toBeLessThan(eps)

// Rotation about Z by θ (row-major).
function rotZ(theta) {
  const c = Math.cos(theta), s = Math.sin(theta)
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]]
}
const apply = (R, p) => [
  R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2],
  R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2],
  R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2],
]

describe('fitSimilarity', () => {
  it('recovers a known scale + rotation + translation exactly', () => {
    const s = 2.5, R = rotZ(0.7), t = [100, -50, 8]
    const src = [
      [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [2, -1, 0.5], [-1, 3, 2],
    ]
    const pairs = src.map((p) => ({ src: p, dst: applySimilarity({ scale: s, R, t }, p) }))
    const fit = fitSimilarity(pairs)
    expect(fit).not.toBeNull()
    close(fit.scale, s)
    close(fit.rms, 0, 1e-6)
    for (const { src: p, dst } of pairs) {
      const q = applySimilarity(fit, p)
      close(q[0], dst[0]); close(q[1], dst[1]); close(q[2], dst[2])
    }
  })

  it('reports a non-zero RMS on noisy data but stays close', () => {
    const s = 1.2, R = rotZ(-0.3), t = [5, 5, 0]
    const src = []
    for (let i = 0; i < 20; i++) src.push([Math.cos(i), Math.sin(i * 1.7), 0.1 * i])
    const pairs = src.map((p, i) => {
      const clean = applySimilarity({ scale: s, R, t }, p)
      const noise = [((i % 3) - 1) * 0.02, ((i % 2) - 0.5) * 0.02, 0]
      return { src: p, dst: [clean[0] + noise[0], clean[1] + noise[1], clean[2] + noise[2]] }
    })
    const fit = fitSimilarity(pairs)
    expect(fit.rms).toBeLessThan(0.05)
    close(fit.scale, s, 0.02)
  })

  it('returns null with fewer than 3 correspondences', () => {
    expect(fitSimilarity([{ src: [0, 0, 0], dst: [1, 1, 1] }])).toBeNull()
  })
})

describe('frameFromSimilarity', () => {
  it('fromSfm/toSfm invert each other and fromSfm matches applySimilarity', () => {
    const sim = { scale: 3, R: rotZ(0.4), t: [10, 20, 30] }
    const frame = frameFromSimilarity(sim, 'EPSG:3031')
    expect(frame.crs).toBe('EPSG:3031')
    const p = [1.5, -2.5, 4]
    const crs = frame.fromSfm(p)
    const expected = applySimilarity(sim, p)
    close(crs[0], expected[0]); close(crs[1], expected[1]); close(crs[2], expected[2])
    const back = frame.toSfm(crs)
    close(back[0], p[0]); close(back[1], p[1]); close(back[2], p[2])
  })
})
