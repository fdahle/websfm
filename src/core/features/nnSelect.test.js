import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initMatching from '../../wasm/matching/matching.js'
import { matchDescriptors } from './bruteforce.js'
import {
  makeTop2, offerTop2, mergeTop2, selectMatches, top2Reference, compareMatchSets,
  descriptorNorms, S_SENTINEL,
} from './nnSelect.js'

beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/matching/matching_bg.wasm', import.meta.url)
  await initMatching({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

function lcg(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32)
}
const continuous = (rnd, n, dim) => Float32Array.from({ length: n * dim }, () => rnd() * 2 - 1)
// Small integers: every product and partial sum is exact in f32, so summation order
// cannot matter and any two correct implementations agree bit for bit — ties included.
const quantised = (rnd, n, dim, levels = 3) =>
  Float32Array.from({ length: n * dim }, () => Math.floor(rnd() * levels))

const triples = (ms) => ms.map((m) => [m.ia, m.ib, m.dist])
const pairs = (ms) => ms.map((m) => `${m.ia}-${m.ib}`)

describe('selectMatches over top-2 arrays reproduces the WASM matcher', () => {
  it('exactly, on quantised descriptors with frequent ties (indices AND distances)', async () => {
    const rnd = lcg(42)
    let survivingTies = 0
    for (const dim of [4, 8, 128]) {
      for (let rep = 0; rep < 12; rep++) {
        const A = quantised(rnd, 23, dim)
        const B = quantised(rnd, 29, dim)
        const ref = top2Reference(A, B, dim)
        for (const ratioThreshold of [0.8, 1.0, 1.5]) {
          for (const crossCheck of [false, true]) {
            const want = await matchDescriptors(A, B, { ratioThreshold, crossCheck, dim })
            const got = selectMatches({ ...ref, ratioThreshold, crossCheck })
            expect(triples(got.matches)).toEqual(triples(want.matches))
            if (ratioThreshold > 1) {
              for (let i = 0; i < ref.rows.s1.length; i++) if (ref.rows.s1[i] === ref.rows.s2[i]) survivingTies++
            }
          }
        }
      }
    }
    // The tie rule was actually exercised, not vacuously satisfied.
    expect(survivingTies).toBeGreaterThan(10)
  })

  it('on continuous descriptors (same pairs; distances within GEMM-identity rounding)', async () => {
    const rnd = lcg(7)
    for (const [dim, nA, nB] of [[128, 40, 37], [256, 20, 31]]) {
      const A = continuous(rnd, nA, dim)
      const B = continuous(rnd, nB, dim)
      for (let j = 0; j < Math.min(nA, nB); j += 3) {
        for (let k = 0; k < dim; k++) B[j * dim + k] = A[j * dim + k] + 0.05 * (rnd() - 0.5)
      }
      const ref = top2Reference(A, B, dim)
      for (const crossCheck of [false, true]) {
        const want = await matchDescriptors(A, B, { ratioThreshold: 0.8, crossCheck, dim })
        const got = selectMatches({ ...ref, ratioThreshold: 0.8, crossCheck })
        expect(pairs(got.matches)).toEqual(pairs(want.matches))
        expect(want.matches.length).toBeGreaterThan(3)
        got.matches.forEach((m, i) => expect(m.dist).toBeCloseTo(want.matches[i].dist, 3))
      }
    }
  })

  it('without columns, refuses a cross-check rather than silently skipping it', () => {
    const ref = top2Reference(new Float32Array(8), new Float32Array(8), 4, { cols: false })
    expect(() => selectMatches({ ...ref, ratioThreshold: 0.8, crossCheck: true })).toThrow()
  })
})

describe('mergeTop2 (the GPU reduction rule)', () => {
  // The shader reduces partial top-2s over column sub-tiles, B tiles and row-block
  // chunks in an order unrelated to the index order. Any merge order over any
  // disjoint split must equal the single ascending scan the crate does.
  it('any disjoint split merged in any order equals one ascending scan', () => {
    const rnd = lcg(99)
    for (let rep = 0; rep < 200; rep++) {
      const n = 1 + Math.floor(rnd() * 40)
      const vals = Float32Array.from({ length: n }, () => Math.floor(rnd() * 6) - 3) // many ties
      const full = makeTop2(1)
      for (let j = 0; j < n; j++) offerTop2(full, 0, vals[j], j)

      // Random partition into groups (not contiguous), each scanned ascending.
      const nGroups = 1 + Math.floor(rnd() * 5)
      const groups = Array.from({ length: nGroups }, () => [])
      for (let j = 0; j < n; j++) groups[Math.floor(rnd() * nGroups)].push(j)
      const partials = groups.map((g) => {
        const t = makeTop2(1)
        for (const j of g) offerTop2(t, 0, vals[j], j)
        return { best: t.best[0], s1: t.s1[0], s2: t.s2[0] }
      })
      // Shuffle the merge order.
      for (let i = partials.length - 1; i > 0; i--) {
        const k = Math.floor(rnd() * (i + 1));
        [partials[i], partials[k]] = [partials[k], partials[i]]
      }
      const merged = partials.reduce((acc, p) => mergeTop2(acc, p))
      // An empty group's sentinel best index is 0 and cannot win (its s1 is the sentinel)
      // unless every value is the sentinel, which these values never are.
      expect(merged).toEqual({ best: full.best[0], s1: full.s1[0], s2: full.s2[0] })
    }
  })

  it('keeps an exact duplicate of the best as the second', () => {
    const a = { best: 5, s1: 1, s2: S_SENTINEL }
    const b = { best: 2, s1: 1, s2: 4 }
    expect(mergeTop2(a, b)).toEqual({ best: 2, s1: 1, s2: 1 })
    expect(mergeTop2(b, a)).toEqual({ best: 2, s1: 1, s2: 1 })
  })
})

describe('descriptorNorms', () => {
  it('is the f32 squared norm per row', () => {
    const n = descriptorNorms(Float32Array.from([1, 2, 2, 0, 3, 4]), 3)
    expect([...n]).toEqual([9, 25])
  })
})

describe('compareMatchSets', () => {
  const m = (ia, ib) => ({ ia, ib })
  it('passes identical and empty sets', () => {
    expect(compareMatchSets([], []).pass).toBe(true)
    const s = [m(0, 1), m(2, 3)]
    expect(compareMatchSets(s, s)).toMatchObject({ common: 2, share: 1, pass: true })
  })
  it('tolerates a handful of borderline flips on a large set', () => {
    const cpu = Array.from({ length: 2000 }, (_, i) => m(i, i))
    const gpu = cpu.slice(0, 1997).concat([m(5000, 1), m(5001, 2)])
    const r = compareMatchSets(cpu, gpu)
    expect(r).toMatchObject({ nCpu: 2000, nGpu: 1999, common: 1997, onlyCpu: 3, onlyGpu: 2, pass: true })
  })
  it('fails on a systematic disagreement', () => {
    const cpu = Array.from({ length: 1000 }, (_, i) => m(i, i))
    const gpu = cpu.map((x) => m(x.ia, x.ib + 1)) // same count, wrong partners
    expect(compareMatchSets(cpu, gpu).pass).toBe(false)
    expect(compareMatchSets(cpu, cpu.slice(0, 900)).pass).toBe(false) // count off by 100
  })
})
