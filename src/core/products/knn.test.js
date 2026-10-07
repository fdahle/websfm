import { describe, it, expect } from 'vitest'
import { buildKnnIndex, knnQuery, nearestNeighbors } from './knn.js'

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function cloudOf(n, gen, Type = Float64Array) {
  const pos = new Type(n * 3)
  for (let i = 0; i < n; i++) pos.set(gen(i), i * 3)
  return { count: n, pos }
}

function bruteKnn(cloud, q, k, exclude = -1, maxD2 = Infinity) {
  const d = []
  for (let j = 0; j < cloud.count; j++) {
    if (j === exclude) continue
    const dx = cloud.pos[j * 3] - q[0], dy = cloud.pos[j * 3 + 1] - q[1], dz = cloud.pos[j * 3 + 2] - q[2]
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 < maxD2) d.push(d2)
  }
  return d.sort((a, b) => a - b).slice(0, k)
}

function query(index, q, k, exclude = -1, maxD2 = Infinity) {
  const idx = new Int32Array(k), d2 = new Float64Array(k)
  const n = knnQuery(index, q[0], q[1], q[2], k, idx, d2, exclude, maxD2)
  return { n, idx: [...idx.subarray(0, n)], d2: [...d2.subarray(0, n)] }
}

describe('knn', () => {
  it('matches brute force on a random 3D cloud, including far queries', () => {
    const r = rng(7)
    const cloud = cloudOf(5000, () => [r() * 10, r() * 10, r() * 10])
    const index = buildKnnIndex(cloud)
    for (let t = 0; t < 200; t++) {
      const far = t % 10 === 0
      const q = far ? [100 + r() * 50, -40, 7] : [r() * 10, r() * 10, r() * 10]
      const got = query(index, q, 8)
      expect(got.d2).toEqual(bruteKnn(cloud, q, 8))
    }
  })

  it('handles a flat aerial-like cloud with survey coordinates in Float32', () => {
    const r = rng(3)
    const cloud = cloudOf(4000, () => [2.5e6 + r() * 200, -1.2e6 + r() * 200, 50 + r() * 0.5], Float32Array)
    const index = buildKnnIndex(cloud)
    for (let t = 0; t < 100; t++) {
      const j = Math.floor(r() * cloud.count)
      const q = [cloud.pos[j * 3], cloud.pos[j * 3 + 1], cloud.pos[j * 3 + 2]]
      const got = query(index, q, 6, j)
      expect(got.d2).toEqual(bruteKnn(cloud, q, 6, j))
      expect(got.idx).not.toContain(j)
    }
  })

  it('copes with many duplicate points', () => {
    const cloud = cloudOf(3000, (i) => [i % 5, 0, 0])
    const index = buildKnnIndex(cloud)
    const got = query(index, [2.2, 0, 0], 10)
    expect(got.n).toBe(10)
    expect(got.d2.every((d) => Math.abs(d - 0.04) < 1e-12)).toBe(true)
  })

  it('returns fewer than k when the cloud is small, and honours maxD2', () => {
    const cloud = cloudOf(3, (i) => [i, 0, 0])
    const index = buildKnnIndex(cloud)
    expect(query(index, [0, 0, 0], 8).n).toBe(3)
    expect(query(index, [0, 0, 0], 8, -1, 1.5).d2).toEqual([0, 1])
  })

  it('nearestNeighbors returns distances and −1/NaN beyond maxDist', () => {
    const ref = cloudOf(100, (i) => [i, 0, 0])
    const index = buildKnnIndex(ref)
    const q = cloudOf(3, (i) => [[10.4, 0, 0], [50, 3, 4], [500, 0, 0]][i])
    const { index: nn, dist } = nearestNeighbors(index, q, { maxDist: 100 })
    expect([...nn]).toEqual([10, 50, -1])
    expect(dist[0]).toBeCloseTo(0.4, 12)
    expect(dist[1]).toBeCloseTo(5, 12)
    expect(dist[2]).toBeNaN()
  })

  it('is empty-safe', () => {
    const index = buildKnnIndex({ count: 0, pos: new Float64Array(0) })
    expect(query(index, [0, 0, 0], 4).n).toBe(0)
    expect(nearestNeighbors(index, cloudOf(2, () => [0, 0, 0])).index[0]).toBe(-1)
  })
})
