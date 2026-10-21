import { describe, it, expect } from 'vitest'
import { fuseDepthMaps } from './mvs.js'

// Maps of varied depth (odd and even valid counts, holes), so the median's rank matters.
function maps(n = 5) {
  return Array.from({ length: n }, (_, j) => {
    const w = 24 + j,
      h = 20,
      px = w * h
    return {
      uuid: String(j),
      name: `img${j}`,
      width: w,
      height: h,
      K: { fx: 30 + j, fy: 30 + j, cx: w / 2, cy: h / 2 },
      R: [
        [1, 0, 0],
        [0, -1, 0],
        [0, 0, -1],
      ],
      t: [-j / 4, 0, 10],
      depth: Float32Array.from({ length: px }, (_, i) => (i % 7 === j ? 0 : 9 + ((i * 37 + j * 11) % 101) / 50)),
      cost: Float32Array.from({ length: px }, (_, i) => (i % 13) / 30),
      rgb: new Uint8Array(px * 3),
    }
  })
}

// The merge cell as it was computed before quickselect: sort every valid depth.
function sortedMergeCell(ms) {
  const gsds = []
  for (const m of ms) {
    const ds = [...m.depth].filter((d) => d > 0).sort((a, b) => a - b)
    if (ds.length) gsds.push(ds[ds.length >> 1] / m.K.fx)
  }
  gsds.sort((a, b) => a - b)
  return gsds[gsds.length >> 1]
}

describe('fusion plan', () => {
  it('picks the auto merge cell of the sorted median', () => {
    const ms = maps()
    const plan = fuseDepthMaps(ms, { planOnly: true })
    expect(plan.mergeCell).toBe(sortedMergeCell(ms))
  })

  it('reports progress per map read, ending near the whole plan', () => {
    const ms = maps(),
      calls = []
    fuseDepthMaps(ms, { planOnly: true }, () => {}, { onPlanProgress: (...a) => calls.push(a) })
    // Resident maps: cost count, cost samples, bounds, cell estimate.
    expect(calls).toHaveLength(4 * ms.length)
    expect(calls[0]).toEqual([1, ms.length, 'Planning fusion (1/4): cost statistics', 1 / (4 * ms.length)])
    expect(calls.at(-1)[0]).toBe(ms.length)
    expect(calls.at(-1)[2]).toMatch(/^Planning fusion \(4\/4\)/)
    const f = calls.map((c) => c[3])
    expect(f.every((x, i) => i === 0 || x > f[i - 1])).toBe(true)
    expect(f.at(-1)).toBeLessThan(1)
  })
})
