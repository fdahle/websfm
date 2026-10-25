import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initMatching from '../../wasm/matching/matching.js'
import { verifyMatches, verifyPointPairs, packMatchedPoints, inlierSpread } from './verify.js'
import { keypointsFromObjects as K } from './keypoints.js'

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
    const rnd = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
    const f = 1000,
      c = 500,
      a = 0.12
    const R = [
      [Math.cos(a), 0, Math.sin(a)],
      [0, 1, 0],
      [-Math.sin(a), 0, Math.cos(a)],
    ]
    const t = [0.6, 0, 0]
    const kpsA = [],
      kpsB = [],
      matches = []
    for (let i = 0; i < 60; i++) {
      const z = planar ? 6 : 3 + rnd() * 7
      const X = [(rnd() - 0.5) * 4, (rnd() - 0.5) * 4, z]
      kpsA.push({ x: (f * X[0]) / X[2] + c, y: (f * X[1]) / X[2] + c })
      const xc = [R[0][0] * X[0] + R[0][2] * X[2] + t[0], X[1] + t[1], R[2][0] * X[0] + R[2][2] * X[2] + t[2]]
      kpsB.push({ x: (f * xc[0]) / xc[2] + c, y: (f * xc[1]) / xc[2] + c })
      matches.push({ ia: i, ib: i })
    }
    return { kpsA, kpsB, matches }
  }

  it('reports a homography inlier count alongside the fundamental inliers', async () => {
    const { kpsA, kpsB, matches } = scene(false)
    const res = await verifyMatches(K(kpsA), K(kpsB), matches, { ransacThreshPx: 2.0, maxIters: 2000 })
    expect(res).toBeTruthy()
    expect(typeof res.hInlierCount).toBe('number')
    // General motion: F fits nearly every point, H fits far fewer (degeneracy ratio low).
    expect(res.inlierCount).toBeGreaterThan(40)
    expect(res.hInlierCount / res.inlierCount).toBeLessThan(0.8)
  })

  it('flags a planar scene as degenerate (H ≈ F)', async () => {
    const { kpsA, kpsB, matches } = scene(true)
    const res = await verifyMatches(K(kpsA), K(kpsB), matches, { ransacThreshPx: 2.0, maxIters: 2000 })
    expect(res).toBeTruthy()
    expect(res.hInlierCount / res.inlierCount).toBeGreaterThan(0.9)
  })

  it('skips the homography count when F inliers are below hSkipBelow', async () => {
    const { kpsA, kpsB, matches } = scene(true) // planar → strong H when computed
    const base = await verifyMatches(K(kpsA), K(kpsB), matches, { ransacThreshPx: 2.0, maxIters: 2000 })
    expect(base.hInlierCount).toBeGreaterThan(0)

    // Floor above this pair's F-inlier count ⇒ H skipped ⇒ reported 0, F untouched.
    const skipped = await verifyMatches(K(kpsA), K(kpsB), matches, {
      ransacThreshPx: 2.0,
      maxIters: 2000,
      hSkipBelow: base.inlierCount + 1,
    })
    expect(skipped.hInlierCount).toBe(0)
    expect(skipped.inlierCount).toBe(base.inlierCount)
  })

  // The store posts packed coordinates (verifyPoints op) instead of the two keypoint
  // object arrays; it must be the very same verification.
  it('packed point pairs verify identically to keypoints + match indices', async () => {
    const { kpsA, kpsB, matches } = scene(false)
    // Scramble the match order and indices so the packing really has to index.
    const perm = matches.map((m, i) => ({ ia: (i * 7) % 60, ib: (i * 7) % 60 }))
    const opts = { ransacThreshPx: 2.0, maxIters: 2000 }
    const viaKps = await verifyMatches(K(kpsA), K(kpsB), perm, opts)
    const { ptsA, ptsB } = packMatchedPoints(K(kpsA), K(kpsB), perm)
    expect(ptsA).toBeInstanceOf(Float32Array)
    expect([ptsA[2], ptsA[3]]).toEqual([Math.fround(kpsA[7].x), Math.fround(kpsA[7].y)])
    const viaPts = await verifyPointPairs(ptsA, ptsB, opts)
    expect(viaPts.F).toEqual(viaKps.F)
    expect([...viaPts.inlierMask]).toEqual([...viaKps.inlierMask])
    expect(viaPts.hInlierCount).toBe(viaKps.hInlierCount)
    expect(await verifyPointPairs(new Float32Array(14), new Float32Array(14), opts)).toBeNull()
  })

  // verifier: 'magsac' reaches the MAGSAC++ path (crates/matching/src/magsac.rs) for F
  // and H: same result shape, same H-vs-F labels, and its own (deterministic) model.
  it('verifies with MAGSAC++ when asked, with the same labels', async () => {
    const opts = { ransacThreshPx: 2.0, maxIters: 2000, verifier: 'magsac' }
    const general = scene(false)
    const m = await verifyMatches(K(general.kpsA), K(general.kpsB), general.matches, opts)
    expect(m.inlierCount).toBeGreaterThan(40)
    expect(m.hInlierCount / m.inlierCount).toBeLessThan(0.8)
    const again = await verifyMatches(K(general.kpsA), K(general.kpsB), general.matches, opts)
    expect(again.F).toEqual(m.F)
    const r = await verifyMatches(K(general.kpsA), K(general.kpsB), general.matches, { ...opts, verifier: 'ransac' })
    expect(r.F).not.toEqual(m.F)
    const planar = scene(true)
    const p = await verifyMatches(K(planar.kpsA), K(planar.kpsB), planar.matches, opts)
    expect(p.hInlierCount / p.inlierCount).toBeGreaterThan(0.9)
  })
})

describe('inlierSpread (positional degeneracy)', () => {
  it('counts the unique rounded positions the string keys counted', () => {
    let st = 4
    const r = () => (st = (Math.imul(st, 1103515245) + 12345) >>> 0) / 2 ** 32
    const pts = (n) =>
      Array.from({ length: n }, () => ({ x: Math.floor(r() * 30) - 10.4 + r(), y: Math.floor(r() * 20) - 0.6 }))
    const a = pts(300),
      b = pts(300)
    const matches = a.map((_, i) => ({ ia: i, ib: (i * 7) % 300 }))
    const mask = Float32Array.from(matches, (_, i) => (i % 3 ? 1 : 0))
    for (const roundPx of [1, 2.5, 0.25]) {
      const keys = (ps, side) =>
        new Set(
          matches
            .filter((_, i) => mask[i] > 0.5)
            .map((m) => ps[side === 'a' ? m.ia : m.ib])
            .map((p) => `${Math.round(p.x / roundPx)},${Math.round(p.y / roundPx)}`),
        ).size
      const s = inlierSpread(K(a), K(b), matches, mask, roundPx)
      expect([s.uniqueA, s.uniqueB]).toEqual([keys(a, 'a'), keys(b, 'b')])
    }
  })
  const all = (n) => new Float32Array(n).fill(1) // every putative an inlier

  it('reports full spread for well-distributed correspondences', () => {
    const kpsA = [],
      kpsB = [],
      matches = []
    for (let i = 0; i < 20; i++) {
      kpsA.push({ x: 100 + i * 30, y: 50 + i * 20 })
      kpsB.push({ x: 120 + i * 30, y: 60 + i * 20 })
      matches.push({ ia: i, ib: i })
    }
    const s = inlierSpread(K(kpsA), K(kpsB), matches, all(20))
    expect(s.count).toBe(20)
    expect(s.uniqueA).toBe(20)
    expect(s.uniqueB).toBe(20)
    expect(s.extentA).toBeGreaterThan(100)
    expect(s.extentB).toBeGreaterThan(100)
  })

  it('detects many-to-one convergence (image B collapses to one spot)', () => {
    // 20 distinct points in A all match keypoints stacked at ~one location in B —
    // the duplicate-scale-SIFT escape hatch. Unique-B ≪ count is the fingerprint.
    const kpsA = [],
      kpsB = [],
      matches = []
    for (let i = 0; i < 20; i++) {
      kpsA.push({ x: 100 + i * 30, y: 50 + i * 20 })
      kpsB.push({ x: 400 + (i % 2) * 0.3, y: 300 + (i % 2) * 0.3 }) // all within ~1px
      matches.push({ ia: i, ib: i })
    }
    const s = inlierSpread(K(kpsA), K(kpsB), matches, all(20))
    expect(s.count).toBe(20)
    expect(s.uniqueA).toBe(20)
    expect(s.uniqueB).toBeLessThanOrEqual(2)
    expect(Math.min(s.extentA, s.extentB)).toBeLessThan(2)
  })

  it('detects epipole collapse (all inliers in a pinhead region in both images)', () => {
    const kpsA = [],
      kpsB = [],
      matches = []
    for (let i = 0; i < 20; i++) {
      kpsA.push({ x: 200 + Math.random() * 3, y: 200 + Math.random() * 3 })
      kpsB.push({ x: 500 + Math.random() * 3, y: 500 + Math.random() * 3 })
      matches.push({ ia: i, ib: i })
    }
    const s = inlierSpread(K(kpsA), K(kpsB), matches, all(20))
    expect(Math.min(s.extentA, s.extentB)).toBeLessThan(8)
  })

  it('ignores non-inlier putatives', () => {
    const kpsA = [
      { x: 0, y: 0 },
      { x: 500, y: 500 },
    ]
    const kpsB = [
      { x: 10, y: 10 },
      { x: 510, y: 510 },
    ]
    const matches = [
      { ia: 0, ib: 0 },
      { ia: 1, ib: 1 },
    ]
    const s = inlierSpread(K(kpsA), K(kpsB), matches, new Float32Array([1, 0]))
    expect(s.count).toBe(1)
    expect(s.uniqueA).toBe(1)
    expect(s.extentA).toBe(0)
  })
})
