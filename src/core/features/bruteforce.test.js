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
})
