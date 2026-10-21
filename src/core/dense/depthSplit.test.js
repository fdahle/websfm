import { it, expect } from 'vitest'
import { contiguousChunks, depthWorkerCount, mergeDepthSummaries } from './depthSplit.js'

it('uses the pool, but keeps a few maps per worker and stays in the memory budget', () => {
  const base = { poolSize: 8, budget: 6e9, perWorkerBytes: 50e6 }
  expect(depthWorkerCount({ ...base, n: 42 })).toBe(8)
  expect(depthWorkerCount({ ...base, n: 10 })).toBe(2)
  expect(depthWorkerCount({ ...base, n: 3 })).toBe(1)
  expect(depthWorkerCount({ ...base, n: 42, perWorkerBytes: 2e9 })).toBe(3)
  expect(depthWorkerCount({ ...base, n: 42, perWorkerBytes: 9e9 })).toBe(1)
})

it('splits indices into contiguous chunks that cover each index once', () => {
  const chunks = contiguousChunks(10, 3)
  expect(chunks).toEqual([
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8, 9],
  ])
  expect(contiguousChunks(2, 1)).toEqual([[0, 1]])
})

it("merges the workers' summaries as one run would report them", () => {
  const part = (nMaps, ms, extra = {}) => ({
    summary: {
      nMaps,
      backend: 'wasm',
      gpuFallbacks: 0,
      projectedPeakBytes: 100,
      budgetBytes: 1000,
      settings: { maxDim: 600 },
      ...extra,
    },
    perImage: ms.map((t) => ({ ms: t, coveragePct: 90, costMedian: 0.2 })),
  })
  const merged = mergeDepthSummaries([part(2, [10, 30]), part(1, [20])], { totalMs: 35, nImages: 3 })
  expect(merged).toMatchObject({
    nMaps: 3,
    nImages: 3,
    workers: 2,
    backend: 'wasm',
    totalMs: 35,
    medianMsPerImage: 20,
    projectedPeakBytes: 200,
    budgetBytes: 2000,
    settings: { maxDim: 600 },
  })
})
