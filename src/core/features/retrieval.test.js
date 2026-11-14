import { describe, it, expect } from 'vitest'
import {
  seededRandom,
  sampleRows,
  trainCodebook,
  vladEncode,
  topKSimilar,
  retrievalPairs,
  samplesPerImage,
} from './retrieval.js'

const unitRow = (v) => {
  const n = Math.hypot(...v)
  return v.map((x) => x / n)
}
const norm = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0))
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0)

// Gaussian-ish noise from the seeded generator (sum of uniforms).
function noise(rand, sigma) {
  return (rand() + rand() + rand() + rand() - 2) * sigma
}

describe('seededRandom', () => {
  it('repeats for a seed and stays in [0, 1)', () => {
    const a = seededRandom(7),
      b = seededRandom(7)
    for (let i = 0; i < 1000; i++) {
      const x = a()
      expect(x).toBe(b())
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })
})

describe('sampleRows', () => {
  it('takes whole rows spread over the buffer, and all of them when asked for more', () => {
    const dim = 3,
      rows = 100
    const desc = Float32Array.from({ length: rows * dim }, (_, i) => Math.floor(i / dim))
    const s = sampleRows(desc, dim, 10, seededRandom(1))
    expect(s.length).toBe(30)
    const picked = []
    for (let i = 0; i < 10; i++) {
      // Every value of a row is its row number: the copy is whole rows.
      expect(s[i * dim]).toBe(s[i * dim + 2])
      picked.push(s[i * dim])
    }
    // Spread: one from each tenth of the buffer.
    picked.forEach((r, i) => expect(Math.floor(r / 10)).toBe(i))
    expect(sampleRows(desc, dim, 500).length).toBe(rows * dim)
  })
})

describe('trainCodebook', () => {
  it('finds the centres of well-separated clusters', () => {
    const dim = 8,
      centres = [],
      rand = seededRandom(3)
    for (let c = 0; c < 4; c++) {
      const v = new Array(dim).fill(0)
      v[c * 2] = 10
      centres.push(v)
    }
    const m = 400
    const samples = new Float32Array(m * dim)
    for (let i = 0; i < m; i++) {
      const c = centres[i % 4]
      for (let d = 0; d < dim; d++) samples[i * dim + d] = c[d] + noise(rand, 0.3)
    }
    const { codebook, words } = trainCodebook(samples, dim, { words: 4, iterations: 20, seed: 5 })
    expect(words).toBe(4)
    // Each true centre has a word within the noise of it, and the words are all different.
    const used = new Set()
    for (const c of centres) {
      let best = -1,
        bestD = Infinity
      for (let w = 0; w < 4; w++) {
        const d = Math.hypot(...c.map((x, k) => x - codebook[w * dim + k]))
        if (d < bestD) {
          bestD = d
          best = w
        }
      }
      expect(bestD).toBeLessThan(0.2)
      used.add(best)
    }
    expect(used.size).toBe(4)
  })

  it('is deterministic for a seed', () => {
    const rand = seededRandom(9)
    const samples = Float32Array.from({ length: 300 * 4 }, () => rand())
    const a = trainCodebook(samples, 4, { words: 6, seed: 2 })
    const b = trainCodebook(samples, 4, { words: 6, seed: 2 })
    expect([...a.codebook]).toEqual([...b.codebook])
  })

  it('never asks for more words than samples', () => {
    const samples = new Float32Array([1, 0, 0, 1, 1, 1])
    const { words, codebook } = trainCodebook(samples, 2, { words: 64 })
    expect(words).toBe(3)
    expect(codebook.length).toBe(6)
  })
})

describe('vladEncode', () => {
  const dim = 2
  // Two words on the axes.
  const codebook = new Float32Array([1, 0, 0, 1])

  it('sums residuals per word, normalises each block, then signed sqrt and L2', () => {
    // Two descriptors near word 0, one near word 1.
    const desc = new Float32Array([1.0, 0.2, 1.0, 0.4, 0.3, 1.0])
    const v = vladEncode(desc, dim, codebook, 2)
    // Word 0 residuals: (0, 0.2) + (0, 0.4) = (0, 0.6) → unit (0, 1). Word 1: (0.3, 0) → (1, 0).
    // Signed sqrt keeps them; global L2 over two unit blocks divides by √2.
    const r = 1 / Math.SQRT2
    expect(v[0]).toBeCloseTo(0, 6)
    expect(v[1]).toBeCloseTo(r, 6)
    expect(v[2]).toBeCloseTo(r, 6)
    expect(v[3]).toBeCloseTo(0, 6)
  })

  it('is unit length, independent of descriptor order, and zero with no descriptors', () => {
    const rand = seededRandom(4)
    const rows = 50
    const desc = Float32Array.from({ length: rows * dim }, () => rand())
    const v = vladEncode(desc, dim, codebook, 2)
    expect(norm([...v])).toBeCloseTo(1, 6)
    const reversed = new Float32Array(rows * dim)
    for (let i = 0; i < rows; i++) reversed.set(desc.subarray(i * dim, i * dim + dim), (rows - 1 - i) * dim)
    const w = vladEncode(reversed, dim, codebook, 2)
    for (let j = 0; j < v.length; j++) expect(w[j]).toBeCloseTo(v[j], 6)
    expect([...vladEncode(new Float32Array(0), dim, codebook, 2)]).toEqual([0, 0, 0, 0])
  })

  it('damps a burst: one repeated pattern weighs no more than a single occurrence', () => {
    // Intra-normalisation: 100 copies of the same residual in word 0 give the same block
    // as one copy, so word 1's evidence is not drowned.
    const one = new Float32Array([1, 0.5, 0.5, 1])
    const burst = new Float32Array(2 * 101)
    for (let i = 0; i < 100; i++) burst.set([1, 0.5], i * 2)
    burst.set([0.5, 1], 200)
    const a = vladEncode(one, dim, codebook, 2)
    const b = vladEncode(burst, dim, codebook, 2)
    for (let j = 0; j < 4; j++) expect(b[j]).toBeCloseTo(a[j], 6)
  })
})

describe('topKSimilar', () => {
  it('agrees with a full sort, excludes the row itself, and breaks ties to the lower index', () => {
    const rand = seededRandom(11)
    const n = 30,
      len = 6,
      k = 5
    const vecs = new Float32Array(n * len)
    for (let i = 0; i < n; i++) {
      const v = unitRow(Array.from({ length: len }, () => rand() - 0.5))
      vecs.set(v, i * len)
    }
    const { index, score } = topKSimilar(vecs, len, k)
    for (let i = 0; i < n; i++) {
      const vi = [...vecs.subarray(i * len, i * len + len)]
      const all = []
      for (let j = 0; j < n; j++) if (j !== i) all.push([dot(vi, [...vecs.subarray(j * len, j * len + len)]), j])
      all.sort((a, b) => b[0] - a[0] || a[1] - b[1])
      for (let q = 0; q < k; q++) {
        expect(index[i * k + q]).toBe(all[q][1])
        expect(score[i * k + q]).toBeCloseTo(all[q][0], 5)
      }
    }
    // Ties: three identical vectors and a query equal to them.
    const same = new Float32Array([1, 0, 1, 0, 1, 0, 1, 0])
    const t = topKSimilar(same, 2, 2, 3, 4)
    expect([...t.index]).toEqual([0, 1])
  })

  it('pads with −1 when there are fewer other rows than k', () => {
    const t = topKSimilar(new Float32Array([1, 0, 0, 1]), 2, 3)
    expect([...t.index]).toEqual([1, -1, -1, 0, -1, -1])
  })
})

describe('retrievalPairs', () => {
  it('keeps a pair when either side chose it, once, in order', () => {
    // 0 → 1, 2;  1 → 0, 3;  2 → 3, -1;  3 → 2, 1
    const index = new Int32Array([1, 2, 0, 3, 3, -1, 2, 1])
    expect(retrievalPairs(index, 2)).toEqual([
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
    ])
  })
})

describe('samplesPerImage', () => {
  it('shares the budget but keeps a floor per image', () => {
    expect(samplesPerImage(10)).toBe(2000)
    expect(samplesPerImage(100_000)).toBe(20)
  })
})

// End to end on synthetic photos: three "places", each with its own pool of local
// features; each photo shows a random part of its place's pool (with noise) plus some
// generic texture common to all places. Every photo's nearest photos must be of its own
// place.
describe('retrieval finds photos of the same place', () => {
  it('pairs each photo with its place', () => {
    const rand = seededRandom(21)
    const dim = 16,
      places = 3,
      perPlace = 6,
      pool = 60,
      perPhoto = 150
    const randomUnit = () => unitRow(Array.from({ length: dim }, () => rand()))
    const pools = Array.from({ length: places }, () => Array.from({ length: pool }, randomUnit))
    const generic = Array.from({ length: 100 }, randomUnit)
    const photos = []
    for (let p = 0; p < places; p++) {
      for (let s = 0; s < perPhoto && photos.length < (p + 1) * perPlace; s++) {
        const d = new Float32Array(perPhoto * dim)
        for (let i = 0; i < perPhoto; i++) {
          const src = i % 3 === 0 ? generic[Math.floor(rand() * generic.length)] : pools[p][Math.floor(rand() * pool)]
          d.set(
            src.map((x) => Math.max(0, x + noise(rand, 0.02))),
            i * dim,
          )
        }
        photos.push({ place: p, desc: d })
      }
    }
    const per = 40
    const samples = new Float32Array(photos.length * per * dim)
    photos.forEach((ph, i) => samples.set(sampleRows(ph.desc, dim, per, rand), i * per * dim))
    const { codebook, words } = trainCodebook(samples, dim, { words: 16, seed: 1 })
    const len = words * dim
    const vecs = new Float32Array(photos.length * len)
    photos.forEach((ph, i) => vecs.set(vladEncode(ph.desc, dim, codebook, words), i * len))
    const k = perPlace - 1
    const { index } = topKSimilar(vecs, len, k)
    for (let i = 0; i < photos.length; i++) {
      for (let q = 0; q < k; q++) expect(photos[index[i * k + q]].place).toBe(photos[i].place)
    }
  })
})
