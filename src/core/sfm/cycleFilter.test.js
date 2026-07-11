import { describe, it, expect } from 'vitest'
import { rotationCycleFilter } from './cycleFilter.js'
import { matMul3, matT3 } from './rotations.js'

// Deterministic LCG for reproducible "random" rotations.
function lcg(seed = 42) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function rodrigues(axis, deg) {
  const th = (deg * Math.PI) / 180
  const n = Math.hypot(...axis)
  const [x, y, z] = axis.map((v) => v / n)
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ]
}

// Complete graph over global camera rotations: edge R (idA→idB) = R_b · R_aᵀ,
// which makes every triangle cycle exactly the identity.
const IDS = ['a', 'b', 'c', 'd', 'e', 'f']
function consistentEdges() {
  const globals = new Map(IDS.map((id, i) => [id, rodrigues([0.2, 1, 0.1 * i + 0.05], 12 * i)]))
  const edges = []
  for (let i = 0; i < IDS.length; i++) {
    for (let j = i + 1; j < IDS.length; j++) {
      const R = matMul3(globals.get(IDS[j]), matT3(globals.get(IDS[i])))
      edges.push({ idA: IDS[i], idB: IDS[j], R, inliers: 100 })
    }
  }
  return edges
}

describe('rotationCycleFilter sanity abort', () => {
  it('keeps a fully consistent graph, no abort', () => {
    const { drop, summary } = rotationCycleFilter(consistentEdges())
    expect(drop).toEqual([])
    expect(summary.aborted).toBeUndefined()
    expect(summary.medianTriErrDeg).toBeLessThan(1e-6)
  })

  it('drops exactly the corrupted edge in an otherwise consistent graph', () => {
    const edges = consistentEdges()
    const bad = edges.find((e) => e.idA === 'b' && e.idB === 'e')
    bad.R = matMul3(rodrigues([0, 0, 1], 40), bad.R)
    const { drop, summary } = rotationCycleFilter(edges)
    expect(summary.aborted).toBeUndefined()
    expect(drop).toHaveLength(1)
    expect(drop[0].idA).toBe('b')
    expect(drop[0].idB).toBe('e')
  })

  it('aborts (drops nothing) when the whole rotation graph is inconsistent', () => {
    // Every edge an unrelated random rotation — the wrong-intrinsics /
    // uncorrected-distortion signature: no edge agrees with any triangle, and
    // greedy dropping would execute true pairs wholesale.
    const rnd = lcg(9)
    const edges = []
    for (let i = 0; i < IDS.length; i++) {
      for (let j = i + 1; j < IDS.length; j++) {
        const R = rodrigues([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], 30 + rnd() * 140)
        edges.push({ idA: IDS[i], idB: IDS[j], R, inliers: 100 })
      }
    }
    const { drop, summary } = rotationCycleFilter(edges)
    expect(summary.aborted).toBe(true)
    expect(summary.medianTriErrDeg).toBeGreaterThan(summary.abortErrDeg)
    expect(drop).toEqual([])
  })

  it('abortErrDeg: Infinity restores the old always-filter behaviour', () => {
    const rnd = lcg(9)
    const edges = []
    for (let i = 0; i < IDS.length; i++) {
      for (let j = i + 1; j < IDS.length; j++) {
        const R = rodrigues([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], 30 + rnd() * 140)
        edges.push({ idA: IDS[i], idB: IDS[j], R, inliers: 100 })
      }
    }
    const { drop, summary } = rotationCycleFilter(edges, { abortErrDeg: Infinity })
    expect(summary.aborted).toBeUndefined()
    expect(drop.length).toBeGreaterThan(0)
  })
})
