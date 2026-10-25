import { describe, it, expect } from 'vitest'
import { fuseDepthMaps } from './mvs.js'
import { fusionPrepassSteps, mergeCellEstimates, runWithMaps } from './fusionPlan.js'

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
    // Resident maps: valid counts, cost samples with the bounds (one read), cell estimate.
    expect(calls).toHaveLength(3 * ms.length)
    expect(calls[0]).toEqual([1, ms.length, 'Planning fusion (1/3): counting valid pixels', 1 / (3 * ms.length)])
    expect(calls.at(-1)[0]).toBe(ms.length)
    expect(calls.at(-1)[2]).toMatch(/^Planning fusion \(3\/3\)/)
    const f = calls.map((c) => c[3])
    expect(f.every((x, i) => i === 0 || x > f[i - 1])).toBe(true)
    expect(f.at(-1)).toBeLessThan(1)
  })
})

// The cell estimate split over workers: each share's hash sample (at its own level) merged
// must be the single pass's — here with a cap low enough that the sample is thinned
// several levels, the case where the order cells arrive in could have mattered.
describe('mergeCellEstimates', () => {
  it('merges any split of the maps into the single pass, thinned levels included', () => {
    const ms = maps(9)
    const params = {
      cell: 0.004,
      step: 1,
      maxCost: 0.4,
      region: null,
      sampleCap: 40,
      tile: { axis: 0 },
      withCorners: true,
    }
    const opts = { sampleCap: params.sampleCap, tile: params.tile, withCorners: true }
    const part = (refs) => runWithMaps(fusionPrepassSteps(ms, refs, 'estimate', params), ms)
    const all = ms.map((_, i) => i)
    const one = mergeCellEstimates([part(all)], ms.length, opts)
    expect(one.level).toBeGreaterThan(2)
    for (const cuts of [[4], [1, 2], [3, 6, 8], [1, 2, 3, 4, 5, 6, 7, 8]]) {
      const bounds = [0, ...cuts, ms.length]
      const parts = bounds.slice(0, -1).map((a, k) => part(all.slice(a, bounds[k + 1])))
      expect(mergeCellEstimates(parts, ms.length, opts)).toEqual(one)
    }
  })
})
