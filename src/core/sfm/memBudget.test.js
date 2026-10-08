import { describe, expect, it } from 'vitest'
import {
  projectSparsePeakBytes, projectSparsePeakBreakdownBytes, sparseMemoryDecision, SPARSE_MEMORY_MODEL, planSparseRun,
} from './memBudget.js'

const GiB = 1024 ** 3

describe('sparse reconstruction memory guard', () => {
  it('grows with keypoints and accepted matches', () => {
    const small = projectSparsePeakBreakdownBytes({ keypointCount: 10_000, matchCount: 20_000 })
    const large = projectSparsePeakBreakdownBytes({ keypointCount: 100_000, matchCount: 500_000 })
    expect(large.workerBufferBytes).toBeGreaterThan(small.workerBufferBytes * 8)
    expect(projectSparsePeakBytes({ keypointCount: 100_000, matchCount: 500_000 })).toBe(large.totalBytes)
  })

  it('puts the descriptors in buffers and the guided grids in the heap, only when guided', () => {
    const base = projectSparsePeakBreakdownBytes({ keypointCount: 1_000_000, matchCount: 2_000_000 })
    const guided = projectSparsePeakBreakdownBytes({ keypointCount: 1_000_000, matchCount: 2_000_000,
      descriptorBytesPerKeypoint: 128 })
    const m = SPARSE_MEMORY_MODEL.margin
    // Held once in each isolate: the worker's working copy shares them (cloneSfmInput).
    expect(guided.workerBufferBytes - base.workerBufferBytes).toBeCloseTo(128e6 * m, -3)
    expect(guided.rendererBufferBytes - base.rendererBufferBytes).toBeCloseTo(128e6 * m, -3)
    expect(guided.workerHeapBytes - base.workerHeapBytes).toBe(guided.guidedHeapBytes)
    expect(guided.guidedHeapBytes).toBeGreaterThan(0)
    expect(projectSparsePeakBreakdownBytes({ keypointCount: 1e6, matchCount: 2e6, descriptorBytesPerKeypoint: 128, guided: false }))
      .toEqual(base)
  })

  it('keeps the Monster-sized worker heap far below the 4 GB ceiling', () => {
    // 4.5 M keypoints, 7.7 M matches: the run that died at the old 3.42 GB projection.
    const p = projectSparsePeakBreakdownBytes({ keypointCount: 4_500_000, matchCount: 7_700_000, descriptorBytesPerKeypoint: 128 })
    expect(p.workerHeapBytes).toBeLessThan(1 * GiB)
    expect(sparseMemoryDecision({ estimateBytes: p.workerHeapBytes, bufferBytes: p.workerBufferBytes,
      usedHeapBytes: 0, heapLimitBytes: 4 * GiB }).safe).toBe(true)
  })

  it('budgets renderer and worker isolates independently', () => {
    const peak = projectSparsePeakBreakdownBytes({ keypointCount: 3_175_000, matchCount: 6_743_387 })
    expect(peak.rendererBytes).toBeLessThan(peak.totalBytes)
    expect(peak.workerBytes).toBeLessThan(peak.totalBytes)
    // Each heap is judged against its own isolate's ceiling, never the combined total.
    expect(sparseMemoryDecision({ estimateBytes: 3.3 * GiB, usedHeapBytes: 0,
      heapLimitBytes: (3.52 / 0.86) * GiB }).safe).toBe(true)
    expect(sparseMemoryDecision({ estimateBytes: peak.rendererHeapBytes, usedHeapBytes: 1.4 * GiB,
      heapLimitBytes: (3.52 / 0.86) * GiB }).safe).toBe(true)
  })

  it('judges buffers against the device budget, not the heap ceiling', () => {
    const args = { estimateBytes: 100, usedHeapBytes: 0, heapLimitBytes: 1_000, fallbackBudgetBytes: 10_000 }
    expect(sparseMemoryDecision({ ...args, bufferBytes: 7_000 })).toMatchObject({ safe: true, heapSafe: true })
    // Far more buffer than heap ceiling is fine — up to 75 % of the device budget.
    expect(sparseMemoryDecision({ ...args, bufferBytes: 8_000 })).toMatchObject({ safe: false, heapSafe: true, buffersSafe: false })
  })

  it('subtracts descriptors released just before the preflight', () => {
    const args = { estimateBytes: 600, usedHeapBytes: 700, heapLimitBytes: 1_500 }
    expect(sparseMemoryDecision(args).safe).toBe(false)
    expect(sparseMemoryDecision({ ...args, releasedBytes: 400 }).safe).toBe(true)
  })

  it('uses a conservative fraction of the fallback device budget for heap + buffers', () => {
    expect(sparseMemoryDecision({ estimateBytes: 500, bufferBytes: 200, fallbackBudgetBytes: 1_000 }).safe).toBe(true)
    expect(sparseMemoryDecision({ estimateBytes: 500, bufferBytes: 300, fallbackBudgetBytes: 1_000 }).safe).toBe(false)
  })
})

describe('planSparseRun', () => {
  // A fake projection: guided adds 1 GB of heap; the ceiling is 2 GB.
  const project = (g) => ({ heap: (g ? 2.5 : 1.5) * GiB })
  const decide = (limit) => (p) => ({ renderer: { safe: true }, worker: { safe: p.heap <= limit * GiB } })

  it('runs as asked when it fits', () => {
    const r = planSparseRun({ guided: true, project, decide: decide(3) })
    expect(r).toMatchObject({ safe: true, guided: true, guidedDropped: false })
  })

  it('drops guided extension when that alone makes the run fit, keeping the projection it would have had', () => {
    const r = planSparseRun({ guided: true, project, decide: decide(2) })
    expect(r).toMatchObject({ safe: true, guided: false, guidedDropped: true })
    expect(r.withGuidedPeak.heap).toBe(2.5 * GiB)
    expect(r.peak.heap).toBe(1.5 * GiB)
  })

  it('refuses when even the lean run does not fit, reporting the run as asked', () => {
    const r = planSparseRun({ guided: true, project, decide: decide(1) })
    expect(r).toMatchObject({ safe: false, guided: true, guidedDropped: false })
    expect(r.peak.heap).toBe(2.5 * GiB)
  })

  it('never turns guided extension on', () => {
    expect(planSparseRun({ guided: false, project, decide: decide(1) })).toMatchObject({ safe: false, guided: false })
  })
})
