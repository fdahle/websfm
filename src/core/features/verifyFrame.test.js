import { describe, it, expect } from 'vitest'
import { makeVerifyMapper, mapVerifyPoints, expandInlierMask } from './verifyFrame.js'
import { distortPixel, FISHEYE_MAX_RAY_DEG } from '../sfm/distortion.js'

const K = { fx: 320, fy: 320, cx: 500, cy: 400 }
const lens = { fisheye: true, k1: 0.04, k2: 0, k3: 0, k4: 0 }

describe('verifyFrame', () => {
  it('maps only fisheye images', () => {
    expect(makeVerifyMapper(K, null)).toBeNull()
    expect(makeVerifyMapper(K, { k1: -0.1, k2: 0, k3: 0, p1: 0, p2: 0 })).toBeNull()
    const map = makeVerifyMapper(K, lens)
    const raw = distortPixel(700, 250, K, lens)
    const p = map(raw.x, raw.y)
    expect(p.x).toBeCloseTo(700, 6)
    expect(p.y).toBeCloseTo(250, 6)
  })

  it('leaves out putatives past the ray limit and spreads the mask back', () => {
    const map = makeVerifyMapper(K, lens)
    const far = (FISHEYE_MAX_RAY_DEG + 5) * Math.PI / 180
    const ptsA = Float32Array.of(500, 400, 500 + K.fx * far * 1.1, 400, 520, 410)
    const ptsB = Float32Array.of(510, 400, 600, 400, 530, 410)
    const { ptsA: a, ptsB: b, keep } = mapVerifyPoints(ptsA, ptsB, map, null)
    expect([...keep]).toEqual([0, 2])
    expect(a).toHaveLength(4)
    expect(b[2]).toBe(530)
    expect([...expandInlierMask(Float32Array.of(1, 1), keep, 3)]).toEqual([1, 0, 1])
  })

  it('passes points through untouched with no mapper', () => {
    const ptsA = Float32Array.of(1, 2), ptsB = Float32Array.of(3, 4)
    const out = mapVerifyPoints(ptsA, ptsB, null, null)
    expect(out.ptsA).toBe(ptsA)
    expect(out.keep).toBeNull()
    const mask = Float32Array.of(1)
    expect(expandInlierMask(mask, null, 1)).toBe(mask)
  })
})
