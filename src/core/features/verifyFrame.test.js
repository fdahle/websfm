import { describe, it, expect } from 'vitest'
import { makeVerifyMapper, mapVerifyPoints, expandInlierMask } from './verifyFrame.js'
import { distortPixel, FISHEYE_MAX_RAY_DEG } from '../sfm/distortion.js'

const K = { fx: 320, fy: 320, cx: 500, cy: 400 }
const lens = { fisheye: true, k1: 0.04, k2: 0, k3: 0, k4: 0 }

describe('verifyFrame', () => {
  it('maps images with a known lens, fisheye or Brown', () => {
    expect(makeVerifyMapper(K, null)).toBeNull()
    const brown = { k1: -0.1, k2: 0, k3: 0, p1: 0, p2: 0 }
    const b = distortPixel(700, 250, K, brown)
    const q = makeVerifyMapper(K, brown)(b.x, b.y)
    expect(q.x).toBeCloseTo(700, 6)
    expect(q.y).toBeCloseTo(250, 6)
    const map = makeVerifyMapper(K, lens)
    const raw = distortPixel(700, 250, K, lens)
    const p = map(raw.x, raw.y)
    expect(p.x).toBeCloseTo(700, 6)
    expect(p.y).toBeCloseTo(250, 6)
  })

  it('leaves out putatives past the ray limit and spreads the mask back', () => {
    const map = makeVerifyMapper(K, lens)
    const far = ((FISHEYE_MAX_RAY_DEG + 5) * Math.PI) / 180
    const ptsA = Float32Array.of(500, 400, 500 + K.fx * far * 1.1, 400, 520, 410)
    const ptsB = Float32Array.of(510, 400, 600, 400, 530, 410)
    const { ptsA: a, ptsB: b, keep } = mapVerifyPoints(ptsA, ptsB, map, null)
    expect([...keep]).toEqual([0, 2])
    expect(a).toHaveLength(4)
    expect(b[2]).toBe(530)
    expect([...expandInlierMask(Float32Array.of(1, 1), keep, 3)]).toEqual([1, 0, 1])
  })

  it('passes points through untouched with no mapper', () => {
    const ptsA = Float32Array.of(1, 2),
      ptsB = Float32Array.of(3, 4)
    const out = mapVerifyPoints(ptsA, ptsB, null, null)
    expect(out.ptsA).toBe(ptsA)
    expect(out.keep).toBeNull()
    const mask = Float32Array.of(1)
    expect(expandInlierMask(mask, null, 1)).toBe(mask)
  })
})

describe('a known Brown lens is verified in its pinhole frame', () => {
  // Nadir pair, 80 % forward overlap, 5 % relief, 0.3 px noise, no outliers, through an
  // assumed 94° lens (k1 −0.13, k2 0.11): the share of true matches F-RANSAC keeps per
  // radial band (fraction of the half-diagonal).
  async function keptByBand(mapped) {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const initMatching = (await import('../../wasm/matching/matching.js')).default
    await initMatching({
      module_or_path: await readFile(fileURLToPath(new URL('../../wasm/matching/matching_bg.wasm', import.meta.url))),
    })
    const { verifyPointPairs } = await import('./verify.js')
    let seed = 4242
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32)
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd())
    const [f, w, h, H] = [2400, 4000, 3000, 100]
    const lens = { k1: -0.13, k2: 0.11, k3: 0, p1: 0, p2: 0 }
    const K = { fx: f, fy: f, cx: (w - 1) / 2, cy: (h - 1) / 2 }
    const footX = (w / f) * H,
      footY = (h / f) * H,
      B = [0.2 * footX, 0]
    const proj = (C, X) => {
      const xn = (X[0] - C[0]) / (H - X[2]),
        yn = -(X[1] - C[1]) / (H - X[2])
      const r2 = xn * xn + yn * yn,
        s = 1 + lens.k1 * r2 + lens.k2 * r2 * r2
      return [f * xn * s + K.cx, f * yn * s + K.cy, Math.sqrt(r2)]
    }
    const pa = [],
      pb = [],
      rr = []
    const rmax = Math.hypot(w / 2, h / 2) / f
    while (rr.length < 1600) {
      const X = [B[0] / 2 + (rnd() - 0.5) * footX, (rnd() - 0.5) * footY, 0.05 * H * (rnd() - 0.5)]
      const a = proj([0, 0], X),
        b = proj(B, X)
      if (a[0] < 0 || a[0] > w - 1 || a[1] < 0 || a[1] > h - 1 || b[0] < 0 || b[0] > w - 1 || b[1] < 0 || b[1] > h - 1)
        continue
      pa.push(a[0] + 0.3 * gauss(), a[1] + 0.3 * gauss())
      pb.push(b[0] + 0.3 * gauss(), b[1] + 0.3 * gauss())
      rr.push(Math.max(a[2], b[2]) / rmax)
    }
    const map = mapped ? makeVerifyMapper(K, lens) : null
    const pts = mapVerifyPoints(Float32Array.from(pa), Float32Array.from(pb), map, map)
    const res = await verifyPointPairs(pts.ptsA, pts.ptsB, { ransacThreshPx: 2 })
    const mask = expandInlierMask(res.inlierMask, pts.keep, rr.length)
    return [
      [0, 0.5],
      [0.5, 0.75],
      [0.75, 1.01],
    ].map(([lo, hi]) => {
      let t = 0,
        k = 0
      rr.forEach((r, i) => {
        if (r >= lo && r < hi) {
          t++
          if (mask[i] > 0.5) k++
        }
      })
      return k / t
    })
  }
  it('keeps the outer ring a raw-keypoint fit loses', async () => {
    const raw = await keptByBand(false)
    expect(raw[2]).toBeLessThan(0.5)
    for (const share of await keptByBand(true)) expect(share).toBeGreaterThanOrEqual(0.98)
  })
  it('leaves a sensor without a lens as it was', () => {
    expect(makeVerifyMapper({ fx: 1, fy: 1, cx: 0, cy: 0 }, null)).toBeNull()
  })
})
