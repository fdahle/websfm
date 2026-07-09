import { describe, it, expect } from 'vitest'
import {
  estimateHomographyRansac,
  planGuidedTiles,
  kptIndicesInRect,
  dedupeGuidedMatches,
  marginFromResiduals,
  applyHomography,
} from './guidedTiles.js'

// Map a point through a flat-9 H — used to synthesize correspondences.
const warp = (H, x, y) => applyHomography(H, x, y)

describe('estimateHomographyRansac', () => {
  it('recovers a synthetic homography from clean points (compare reprojection, not H)', () => {
    // A mild projective transform.
    const H = [1.02, 0.03, 12, -0.02, 0.98, -7, 1e-4, 5e-5, 1]
    const ptsA = []
    const ptsB = []
    for (let x = 0; x <= 900; x += 90) {
      for (let y = 0; y <= 900; y += 90) {
        ptsA.push([x, y])
        ptsB.push(warp(H, x, y))
      }
    }
    const res = estimateHomographyRansac(ptsA, ptsB, { threshPx: 1, iters: 300 })
    expect(res).not.toBeNull()
    expect(res.inlierCount).toBe(ptsA.length)
    // Reprojection agreement (H is scale-ambiguous, so don't compare entries).
    for (let i = 0; i < ptsA.length; i++) {
      const [px, py] = applyHomography(res.H, ptsA[i][0], ptsA[i][1])
      expect(Math.hypot(px - ptsB[i][0], py - ptsB[i][1])).toBeLessThan(0.5)
    }
    expect(res.p95ErrPx).toBeLessThan(0.5)
  })

  it('rejects outliers via RANSAC', () => {
    const H = [1, 0, 20, 0, 1, -15, 0, 0, 1] // pure translation
    const ptsA = []
    const ptsB = []
    for (let i = 0; i < 60; i++) {
      const x = (i * 37) % 800
      const y = (i * 53) % 600
      ptsA.push([x, y])
      ptsB.push(warp(H, x, y))
    }
    // 12 gross outliers
    for (let i = 0; i < 12; i++) {
      ptsA.push([(i * 17) % 800, (i * 29) % 600])
      ptsB.push([(i * 91) % 800, (i * 71) % 600])
    }
    const res = estimateHomographyRansac(ptsA, ptsB, { threshPx: 2, iters: 500 })
    expect(res).not.toBeNull()
    expect(res.inlierCount).toBeGreaterThanOrEqual(58) // the 60 inliers (allow a couple lost)
    expect(res.inlierCount).toBeLessThan(72)           // outliers excluded
  })

  it('returns null for < 4 points', () => {
    expect(estimateHomographyRansac([[0, 0], [1, 1], [2, 2]], [[0, 0], [1, 1], [2, 2]])).toBeNull()
  })
})

describe('planGuidedTiles', () => {
  it('maps tiles through an identity H onto the same region', () => {
    const H = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    const tiles = planGuidedTiles({ wA: 2000, hA: 2000, wB: 2000, hB: 2000, H, tileSize: 1024, marginPx: 0, overlap: 0 })
    expect(tiles.length).toBeGreaterThan(1)
    for (const { tileA, regionB } of tiles) {
      // identity + zero margin → regionB ≈ tileA (integer clamp only)
      expect(regionB.x).toBe(tileA.x)
      expect(regionB.y).toBe(tileA.y)
      expect(regionB.w).toBe(tileA.w)
      expect(regionB.h).toBe(tileA.h)
    }
  })

  it('applies a translation H and margin, clamped to B bounds', () => {
    const H = [1, 0, 100, 0, 1, 50, 0, 0, 1]
    const tiles = planGuidedTiles({ wA: 1000, hA: 1000, wB: 1000, hB: 1000, H, tileSize: 1024, marginPx: 10, overlap: 0 })
    expect(tiles.length).toBe(1)
    const { regionB } = tiles[0]
    // tileA covers 0..1000; +translation 100/50 then +margin 10, clamped to 1000.
    expect(regionB.x).toBe(90)   // 100 - 10
    expect(regionB.y).toBe(40)   // 50 - 10
    expect(regionB.w).toBe(1000 - 90)
    expect(regionB.h).toBe(1000 - 40)
  })

  it('drops tiles that map entirely outside B', () => {
    // Translate A far off B's right edge.
    const H = [1, 0, 5000, 0, 1, 0, 0, 0, 1]
    const tiles = planGuidedTiles({ wA: 1000, hA: 1000, wB: 1000, hB: 1000, H, tileSize: 512, marginPx: 8, overlap: 0 })
    expect(tiles.length).toBe(0)
  })
})

describe('kptIndicesInRect', () => {
  it('selects only keypoints inside the rect, preserving order', () => {
    const kps = [{ x: 5, y: 5 }, { x: 50, y: 50 }, { x: 5, y: 60 }, { x: 40, y: 40 }]
    const idx = kptIndicesInRect(kps, { x: 10, y: 10, w: 50, h: 50 })
    expect(idx).toEqual([1, 3]) // (50,50) and (40,40); order preserved
  })

  it('is half-open on the far edges', () => {
    const kps = [{ x: 0, y: 0 }, { x: 10, y: 10 }]
    const idx = kptIndicesInRect(kps, { x: 0, y: 0, w: 10, h: 10 })
    expect(idx).toEqual([0]) // (10,10) is on the far edge → excluded
  })
})

describe('dedupeGuidedMatches', () => {
  it('keeps the highest score per ia then per ib (one-to-one)', () => {
    const matches = [
      { ia: 1, ib: 5, score: 0.4 },
      { ia: 1, ib: 6, score: 0.9 }, // wins ia=1
      { ia: 2, ib: 6, score: 0.5 }, // loses ib=6 to the 0.9
      { ia: 3, ib: 7, score: 0.8 },
    ]
    const out = dedupeGuidedMatches(matches)
    // ia unique
    expect(new Set(out.map((m) => m.ia)).size).toBe(out.length)
    // ib unique
    expect(new Set(out.map((m) => m.ib)).size).toBe(out.length)
    expect(out).toContainEqual({ ia: 1, ib: 6, score: 0.9 })
    expect(out).toContainEqual({ ia: 3, ib: 7, score: 0.8 })
    expect(out.find((m) => m.ib === 6).ia).toBe(1) // ia=2/ib=6 dropped
  })
})

describe('marginFromResiduals', () => {
  it('never goes below the floor', () => {
    expect(marginFromResiduals(0)).toBe(32)
    expect(marginFromResiduals(1, { min: 32, k: 3 })).toBe(32)
  })
  it('scales with p95 above the floor', () => {
    expect(marginFromResiduals(20, { min: 32, k: 3 })).toBe(60)
  })
})
