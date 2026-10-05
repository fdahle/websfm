import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initMatching from '../../wasm/matching/matching.js'
import { matchDescriptors } from './bruteforce.js'

// Load the matching wasm bytes ourselves (Node can't fetch() the .wasm URL the
// glue defaults to); the module-level singleton then makes the core module's own
// init() resolve immediately. Mirrors reconstruction.test.js. This also exercises
// the SIMD (`f32x4`) descriptor-distance path that the wasm is built with.
beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/matching/matching_bg.wasm', import.meta.url)
  await initMatching({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

const DESC = 128

// A 128-d descriptor that is `val` at index `peak`, else 0 — well-separated rows,
// so the nearest neighbour is unambiguous and the ratio test passes comfortably.
function oneHot(peak, val = 100) {
  const d = new Float32Array(DESC)
  d[peak] = val
  return d
}

function pack(rows) {
  const out = new Float32Array(rows.length * DESC)
  rows.forEach((r, i) => out.set(r, i * DESC))
  return out
}

describe('matchDescriptors (SIMD wasm)', () => {
  it('matches each descriptor to its near-identical counterpart', async () => {
    // A[i] ≈ B[i] (tiny per-row offset); every other B row is far away.
    const A = pack([oneHot(0), oneHot(40), oneHot(127)])
    const B = pack([oneHot(0, 101), oneHot(40, 99), oneHot(127, 100)])

    const { matches } = await matchDescriptors(A, B, { ratioThreshold: 0.75 })
    const pairs = matches.map((m) => [m.ia, m.ib]).sort((a, b) => a[0] - b[0])
    expect(pairs).toEqual([[0, 0], [1, 1], [2, 2]])
  })

  it('cross-check keeps only mutually-nearest pairs', async () => {
    const A = pack([oneHot(0), oneHot(40), oneHot(127)])
    const B = pack([oneHot(0, 101), oneHot(40, 99), oneHot(127, 100)])

    const { matches } = await matchDescriptors(A, B, { ratioThreshold: 0.75, crossCheck: true })
    expect(matches.length).toBe(3)
    // Distances are small (near-identical rows), never the f32::MAX sentinel.
    for (const m of matches) expect(m.dist).toBeLessThan(5)
  })

  it('rejects ambiguous matches via the ratio test', async () => {
    // Two B rows equidistant from the A row → second-best ≈ best → ratio fails.
    const A = pack([oneHot(0, 100)])
    const B = pack([oneHot(0, 50), oneHot(0, 150)]) // both 50 away in the peak dim
    const { matches } = await matchDescriptors(A, B, { ratioThreshold: 0.75 })
    expect(matches.length).toBe(0)
  })

  it('cross-check is symmetric in the pairs it keeps', async () => {
    const A = pack([oneHot(0), oneHot(40), oneHot(127)])
    const B = pack([oneHot(0, 101), oneHot(40, 99), oneHot(127, 100)])

    const fwd = await matchDescriptors(A, B, { crossCheck: true })
    const rev = await matchDescriptors(B, A, { crossCheck: true })
    // Same mutual pairs, with the two indices swapped between directions.
    const fwdPairs = fwd.matches.map((m) => `${m.ia}-${m.ib}`).sort()
    const revPairs = rev.matches.map((m) => `${m.ib}-${m.ia}`).sort()
    expect(fwdPairs).toEqual(revPairs)
  })

  // The crate reads B→A off the same dot matrix as A→B (column-wise top-2) instead
  // of a second scan. `cargo test` pins that against the old two-pass code but only
  // runs the scalar fallback; this runs the shipped simd128 build against a naive
  // diff-square two-pass reference. Continuous random rows ⇒ no exact ties, so the
  // index sets must agree exactly.
  it('single-matrix cross-check equals a naive two-pass mutual-NN reference', async () => {
    let seed = 0x5eed
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1
    const rows = (n, dim) => Float32Array.from({ length: n * dim }, rnd)
    const naive = (a, b, dim, ratio) => {
      const nn2 = (q, qi, db) => {
        let best = -1, d1 = Infinity, d2 = Infinity
        for (let j = 0; j < db.length / dim; j++) {
          let d = 0
          for (let k = 0; k < dim; k++) { const t = q[qi * dim + k] - db[j * dim + k]; d += t * t }
          if (d < d1) { d2 = d1; d1 = d; best = j } else if (d < d2) d2 = d
        }
        return d1 < ratio * ratio * d2 ? best : -1
      }
      const out = []
      for (let i = 0; i < a.length / dim; i++) {
        const j = nn2(a, i, b)
        if (j >= 0 && nn2(b, j, a) === i) out.push(`${i}-${j}`)
      }
      return out.sort()
    }
    for (const [dim, nA, nB] of [[128, 61, 47], [256, 33, 40], [130, 9, 14]]) {
      // Near-duplicates of A rows planted in B so the mutual set is non-trivial.
      const A = rows(nA, dim)
      const B = rows(nB, dim)
      for (let j = 0; j < Math.min(nA, nB); j += 2) {
        for (let k = 0; k < dim; k++) B[j * dim + k] = A[((j * 7) % nA) * dim + k] + 0.05 * rnd()
      }
      const { matches } = await matchDescriptors(A, B, { ratioThreshold: 0.8, crossCheck: true, dim })
      const got = matches.map((m) => `${m.ia}-${m.ib}`).sort()
      const want = naive(A, B, dim, 0.8)
      expect(want.length).toBeGreaterThan(3)
      expect(got).toEqual(want)
    }
  })

  it('reports count consistent with the matches array length', async () => {
    const A = pack([oneHot(0), oneHot(40)])
    const B = pack([oneHot(0, 100), oneHot(40, 100)])
    const { matches, count } = await matchDescriptors(A, B)
    expect(count).toBe(matches.length)
  })
})
