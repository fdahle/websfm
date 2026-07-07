import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initMatching from '../../wasm/matching/matching.js'
import { verifyMatches, inlierSpread } from './verify.js'

// Load the matching wasm bytes ourselves (Node can't fetch() the .wasm URL the
// glue defaults to); the module-level singleton then makes the core module's own
// init() resolve immediately. Mirrors reconstruction.test.js.
beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/matching/matching_bg.wasm', import.meta.url)
  await initMatching({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

describe('verifyMatches (F + H-vs-F degeneracy)', () => {
  // Deterministic two-view projection: camera A at identity, camera B rotated
  // about Y + translated along X. `planar` pins depth (a homography fits the whole
  // pair); otherwise depth varies (no single homography does).
  function scene(planar) {
    let s = 0x2545f491
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
    const f = 1000, c = 500, a = 0.12
    const R = [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]]
    const t = [0.6, 0, 0]
    const kpsA = [], kpsB = [], matches = []
    for (let i = 0; i < 60; i++) {
      const z = planar ? 6 : 3 + rnd() * 7
      const X = [(rnd() - 0.5) * 4, (rnd() - 0.5) * 4, z]
      kpsA.push({ x: f * X[0] / X[2] + c, y: f * X[1] / X[2] + c })
      const xc = [
        R[0][0] * X[0] + R[0][2] * X[2] + t[0],
        X[1] + t[1],
        R[2][0] * X[0] + R[2][2] * X[2] + t[2],
      ]
      kpsB.push({ x: f * xc[0] / xc[2] + c, y: f * xc[1] / xc[2] + c })
      matches.push({ ia: i, ib: i })
    }
    return { kpsA, kpsB, matches }
  }

  it('reports a homography inlier count alongside the fundamental inliers', async () => {
    const { kpsA, kpsB, matches } = scene(false)
    const res = await verifyMatches(kpsA, kpsB, matches, { ransacThreshPx: 2.0, maxIters: 2000 })
    expect(res).toBeTruthy()
    expect(typeof res.hInlierCount).toBe('number')
    // General motion: F fits nearly every point, H fits far fewer (degeneracy ratio low).
    expect(res.inlierCount).toBeGreaterThan(40)
    expect(res.hInlierCount / res.inlierCount).toBeLessThan(0.8)
  })

  it('flags a planar scene as degenerate (H ≈ F)', async () => {
    const { kpsA, kpsB, matches } = scene(true)
    const res = await verifyMatches(kpsA, kpsB, matches, { ransacThreshPx: 2.0, maxIters: 2000 })
    expect(res).toBeTruthy()
    expect(res.hInlierCount / res.inlierCount).toBeGreaterThan(0.9)
  })
})

describe('inlierSpread (positional degeneracy)', () => {
  const all = (n) => new Float32Array(n).fill(1) // every putative an inlier

  it('reports full spread for well-distributed correspondences', () => {
    const kpsA = [], kpsB = [], matches = []
    for (let i = 0; i < 20; i++) {
      kpsA.push({ x: 100 + i * 30, y: 50 + i * 20 })
      kpsB.push({ x: 120 + i * 30, y: 60 + i * 20 })
      matches.push({ ia: i, ib: i })
    }
    const s = inlierSpread(kpsA, kpsB, matches, all(20))
    expect(s.count).toBe(20)
    expect(s.uniqueA).toBe(20)
    expect(s.uniqueB).toBe(20)
    expect(s.extentA).toBeGreaterThan(100)
    expect(s.extentB).toBeGreaterThan(100)
  })

  it('detects many-to-one convergence (image B collapses to one spot)', () => {
    // 20 distinct points in A all match keypoints stacked at ~one location in B —
    // the duplicate-scale-SIFT escape hatch. Unique-B ≪ count is the fingerprint.
    const kpsA = [], kpsB = [], matches = []
    for (let i = 0; i < 20; i++) {
      kpsA.push({ x: 100 + i * 30, y: 50 + i * 20 })
      kpsB.push({ x: 400 + (i % 2) * 0.3, y: 300 + (i % 2) * 0.3 }) // all within ~1px
      matches.push({ ia: i, ib: i })
    }
    const s = inlierSpread(kpsA, kpsB, matches, all(20))
    expect(s.count).toBe(20)
    expect(s.uniqueA).toBe(20)
    expect(s.uniqueB).toBeLessThanOrEqual(2)
    expect(Math.min(s.extentA, s.extentB)).toBeLessThan(2)
  })

  it('detects epipole collapse (all inliers in a pinhead region in both images)', () => {
    const kpsA = [], kpsB = [], matches = []
    for (let i = 0; i < 20; i++) {
      kpsA.push({ x: 200 + Math.random() * 3, y: 200 + Math.random() * 3 })
      kpsB.push({ x: 500 + Math.random() * 3, y: 500 + Math.random() * 3 })
      matches.push({ ia: i, ib: i })
    }
    const s = inlierSpread(kpsA, kpsB, matches, all(20))
    expect(Math.min(s.extentA, s.extentB)).toBeLessThan(8)
  })

  it('ignores non-inlier putatives', () => {
    const kpsA = [{ x: 0, y: 0 }, { x: 500, y: 500 }]
    const kpsB = [{ x: 10, y: 10 }, { x: 510, y: 510 }]
    const matches = [{ ia: 0, ib: 0 }, { ia: 1, ib: 1 }]
    const s = inlierSpread(kpsA, kpsB, matches, new Float32Array([1, 0]))
    expect(s.count).toBe(1)
    expect(s.uniqueA).toBe(1)
    expect(s.extentA).toBe(0)
  })
})
