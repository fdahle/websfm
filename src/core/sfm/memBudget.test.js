import { describe, expect, it } from 'vitest'
import {
  projectSparsePeakBytes, projectSparsePeakBreakdownBytes, sparseMemoryDecision,
} from './memBudget.js'

describe('sparse reconstruction memory guard', () => {
  it('grows with keypoints and accepted matches', () => {
    const small = projectSparsePeakBytes({ keypointCount: 10_000, matchCount: 20_000 })
    const large = projectSparsePeakBytes({ keypointCount: 100_000, matchCount: 500_000 })
    expect(large).toBeGreaterThan(small * 8)
  })

  it('counts shipped descriptors only when asked (guided track extension)', () => {
    const base = projectSparsePeakBreakdownBytes({ keypointCount: 1_000_000, matchCount: 2_000_000 })
    const guided = projectSparsePeakBreakdownBytes({ keypointCount: 1_000_000, matchCount: 2_000_000,
      descriptorBytesPerKeypoint: 128 })
    expect(guided.rendererBytes - base.rendererBytes).toBeCloseTo(128e6 * 1.25, -3)
    expect(guided.workerBytes - base.workerBytes).toBeCloseTo(2 * 128e6 * 1.25, -3)
  })

  it('budgets renderer and worker isolates independently', () => {
    const peak = projectSparsePeakBreakdownBytes({ keypointCount: 3_175_000, matchCount: 6_743_387 })
    expect(peak.rendererBytes).toBeLessThan(peak.totalBytes)
    expect(peak.workerBytes).toBeLessThan(peak.totalBytes)
    // The reported failing case: combined accounting rejects 1.40 + 2.35 > 3.52 GiB,
    // while each isolate remains safely below its own 3.52 GiB ceiling.
    const GiB = 1024 ** 3
    expect(sparseMemoryDecision({ estimateBytes: peak.totalBytes, usedHeapBytes: 1.4 * GiB,
      heapLimitBytes: (3.52 / 0.86) * GiB }).safe).toBe(false)
    expect(sparseMemoryDecision({ estimateBytes: peak.rendererBytes, usedHeapBytes: 1.4 * GiB,
      heapLimitBytes: (3.52 / 0.86) * GiB }).safe).toBe(true)
    expect(sparseMemoryDecision({ estimateBytes: peak.workerBytes, usedHeapBytes: 0,
      heapLimitBytes: (3.52 / 0.86) * GiB }).safe).toBe(true)
  })

  it('subtracts descriptors released just before the preflight', () => {
    const args = { estimateBytes: 600, usedHeapBytes: 700, heapLimitBytes: 1_500 }
    expect(sparseMemoryDecision(args).safe).toBe(false)
    expect(sparseMemoryDecision({ ...args, releasedBytes: 400 }).safe).toBe(true)
  })

  it('uses a conservative fraction of the fallback device budget', () => {
    expect(sparseMemoryDecision({ estimateBytes: 700, fallbackBudgetBytes: 1_000 }).safe).toBe(true)
    expect(sparseMemoryDecision({ estimateBytes: 800, fallbackBudgetBytes: 1_000 }).safe).toBe(false)
  })
})
