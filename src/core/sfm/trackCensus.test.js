import { describe, expect, it } from 'vitest'
import { createTrackCensus } from './trackCensus.js'

const packed = (pairs) => new Uint32Array(pairs.flat())

describe('createTrackCensus', () => {
  it('counts matched keypoints and the tracks they join into', () => {
    // Three images of 5 keypoints. Track 1: 0:0–1:0–2:0 (a chain over two pairs and a
    // closing match, still one track). Track 2: 0:1–1:3. Unmatched keypoints count for nothing.
    const c = createTrackCensus([5, 5, 5])
    c.add(
      0,
      1,
      packed([
        [0, 0],
        [1, 3],
      ]),
    )
    c.add(1, 2, packed([[0, 0]]))
    c.add(0, 2, packed([[0, 0]]))
    expect(c.finish()).toEqual({ observations: 5, tracks: 2 })
  })

  it('joins tracks that meet through a later pair', () => {
    const c = createTrackCensus([3, 3, 3, 3])
    c.add(0, 1, packed([[0, 0]]))
    c.add(2, 3, packed([[0, 0]]))
    expect(c.finish()).toEqual({ observations: 4, tracks: 2 })
    c.add(1, 2, packed([[0, 0]]))
    expect(c.finish()).toEqual({ observations: 4, tracks: 1 })
  })

  it('keeps images apart by their offsets', () => {
    // Keypoint 2 of image 0 and keypoint 2 of image 1 are different keypoints.
    const c = createTrackCensus([3, 3, 3])
    c.add(0, 2, packed([[2, 1]]))
    c.add(1, 2, packed([[2, 2]]))
    expect(c.finish()).toEqual({ observations: 4, tracks: 2 })
  })

  it('ignores indices beyond an image’s keypoints', () => {
    const c = createTrackCensus([2, 2])
    c.add(
      0,
      1,
      packed([
        [0, 5],
        [7, 1],
        [1, 1],
      ]),
    )
    expect(c.finish()).toEqual({ observations: 2, tracks: 1 })
  })

  it('agrees with a brute-force component count on random matches', () => {
    let seed = 7
    const rnd = (n) => (seed = (seed * 1103515245 + 12345) >>> 0) % n
    const counts = [40, 25, 60, 33, 50]
    const c = createTrackCensus(counts)
    const offsets = counts.map((_, i) => counts.slice(0, i).reduce((s, v) => s + v, 0))
    const edges = []
    for (let p = 0; p < 30; p++) {
      const a = rnd(5),
        b = rnd(5)
      if (a === b) continue
      const m = []
      for (let k = 0; k < 10; k++) m.push([rnd(counts[a]), rnd(counts[b])])
      c.add(a, b, packed(m))
      for (const [ka, kb] of m) edges.push([offsets[a] + ka, offsets[b] + kb])
    }
    // Reference: label propagation over the touched keypoints.
    const adj = new Map()
    for (const [u, v] of edges) {
      if (!adj.has(u)) adj.set(u, [])
      if (!adj.has(v)) adj.set(v, [])
      adj.get(u).push(v)
      adj.get(v).push(u)
    }
    const seen = new Set()
    let components = 0
    for (const s of adj.keys()) {
      if (seen.has(s)) continue
      components++
      const stack = [s]
      seen.add(s)
      while (stack.length) for (const n of adj.get(stack.pop())) if (!seen.has(n)) (seen.add(n), stack.push(n))
    }
    expect(c.finish()).toEqual({ observations: adj.size, tracks: components })
  })
})
