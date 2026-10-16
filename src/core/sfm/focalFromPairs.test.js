import { describe, it, expect } from 'vitest'
import { essentialRatio, estimateFocalsFromPairs } from './focalFromPairs.js'

// Two-view scenes with a known focal; F = Kb⁻ᵀ [t]× R Ka⁻¹.
const f = 820, W = 1200, H = 900, pp = { cx: (W - 1) / 2, cy: (H - 1) / 2 }
const rot = (ax, ay) => {
  const [ca, sa, cb, sb] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay)]
  const Rx = [[1, 0, 0], [0, ca, -sa], [0, sa, ca]], Ry = [[cb, 0, sb], [0, 1, 0], [-sb, 0, cb]]
  return Rx.map((r) => [0, 1, 2].map((j) => r[0] * Ry[0][j] + r[1] * Ry[1][j] + r[2] * Ry[2][j]))
}
const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]))
const Kinv = [[1 / f, 0, -pp.cx / f], [0, 1 / f, -pp.cy / f], [0, 0, 1]]
const KinvT = [[Kinv[0][0], Kinv[1][0], Kinv[2][0]], [Kinv[0][1], Kinv[1][1], Kinv[2][1]], [Kinv[0][2], Kinv[1][2], Kinv[2][2]]]
const Fof = (R, t) => mul(mul(KinvT, mul([[0, -t[2], t[1]], [t[2], 0, -t[0]], [-t[1], t[0], 0]], R)), Kinv)

describe('focalFromPairs', () => {
  it('σ2/σ1 of Kᵀ F K peaks at the true focal', () => {
    const F = Fof(rot(0.05, 0.2), [1, 0.1, 0.2])
    const at = (g) => essentialRatio(F, g, g, pp, pp)
    expect(at(f)).toBeGreaterThan(0.999)
    expect(at(f)).toBeGreaterThan(at(1.3 * f))
    expect(at(f)).toBeGreaterThan(at(0.75 * f))
  })

  it('replaces the default guess of every image without a focal', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'g']
    const imgs = ids.map((uuid) => ({ uuid }))
    const Kmap = new Map(ids.map((u) => [u, { fx: W, fy: W, cx: pp.cx, cy: pp.cy, source: 'default FOV (no focal length in metadata)' }]))
    const pairs = []
    let k = 0
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      k++
      pairs.push({ idA: ids[i], idB: ids[j], inlierCount: 100 + k, F: Fof(rot(0.03 * k, 0.15 + 0.02 * k), [1, 0.05 * k, 0.1]) })
    }
    const out = estimateFocalsFromPairs({ imgs, Kmap, pairs, isGuess: () => true, groupOf: () => 's', dims: () => ({ width: W, height: H }) })
    expect(out).toHaveLength(1)
    for (const u of ids) {
      expect(Math.abs(Kmap.get(u).fx - f) / f).toBeLessThan(0.015)
      expect(Kmap.get(u).source).toMatch(/^default FOV.*refined from/)
    }
  })

  it('keeps the guess when the pairs do not agree or are too few', () => {
    const Kmap = new Map([['a', { fx: W, fy: W, ...pp, source: 'default FOV' }], ['b', { fx: W, fy: W, ...pp, source: 'default FOV' }]])
    const pairs = [{ idA: 'a', idB: 'b', inlierCount: 50, F: Fof(rot(0.1, 0.2), [1, 0, 0]) }]
    const out = estimateFocalsFromPairs({ imgs: [{ uuid: 'a' }, { uuid: 'b' }], Kmap, pairs, isGuess: () => true, groupOf: () => 's', dims: () => ({ width: W, height: H }) })
    expect(out).toHaveLength(0)
    expect(Kmap.get('a').fx).toBe(W)
  })
})
