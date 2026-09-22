// Sparse-SfM memory preflight. Unlike a thrown JS exception, renderer OOM is not
// catchable: the browser kills the whole tab. Estimate the additional peak before
// constructing the worker input and refuse when it would consume the safe heap
// headroom. Constants deliberately include JS object overhead, not just payload.

export const SPARSE_HEAP_FRACTION = 0.86

export function projectSparsePeakBreakdownBytes({ keypointCount = 0, matchCount = 0 } = {}) {
  const K = Math.max(0, keypointCount)
  const M = Math.max(0, matchCount)
  // Renderer: plain worker-input keypoints plus the disposable packed match buffer.
  // The latter is transferred (not cloned) when the worker starts.
  const rendererInput = K * 104 + M * 8
  // Worker: postMessage's keypoint clone + the pristine retry clone. Packed matches
  // likewise have the transferred input and the solver's pristine retry copy.
  const workerInputAndClone = K * 104 * 2 + M * 8 * 2
  // Track observations are bounded by accepted matches and, in practice, by the
  // number of keypoints participating across overlapping cameras.
  const expectedObservations = Math.min(M, Math.ceil(K * 0.85))
  // Mutable track maps + BA observation records/WASM numeric scratch.
  const solverAndBa = expectedObservations * 260 + K * 68
  // Allocator fragmentation and engine-specific object headers.
  const margin = 1.25
  return {
    rendererBytes: Math.ceil(rendererInput * margin),
    workerBytes: Math.ceil((workerInputAndClone + solverAndBa) * margin),
    // Historical combined estimate, useful for device-level reporting. Renderer and
    // worker do NOT share a V8 heap ceiling, so this must not be compared to either
    // isolate's jsHeapSizeLimit.
    totalBytes: Math.ceil((K * 104 * 3 + M * 8 * 2 + solverAndBa) * margin),
  }
}

export function projectSparsePeakBytes(counts = {}) {
  return projectSparsePeakBreakdownBytes(counts).totalBytes
}

export function sparseMemoryDecision({
  estimateBytes, usedHeapBytes = null, heapLimitBytes = null,
  fallbackBudgetBytes = null, releasedBytes = 0,
}) {
  const estimate = Math.max(0, estimateBytes || 0)
  if (Number.isFinite(heapLimitBytes) && heapLimitBytes > 0
      && Number.isFinite(usedHeapBytes) && usedHeapBytes >= 0) {
    const used = Math.max(0, usedHeapBytes - Math.max(0, releasedBytes || 0))
    const limit = heapLimitBytes * SPARSE_HEAP_FRACTION
    return { safe: used + estimate <= limit, estimateBytes: estimate, usedBytes: used,
      limitBytes: limit, source: 'heap' }
  }
  if (Number.isFinite(fallbackBudgetBytes) && fallbackBudgetBytes > 0) {
    const limit = fallbackBudgetBytes * 0.75
    return { safe: estimate <= limit, estimateBytes: estimate, usedBytes: null,
      limitBytes: limit, source: 'device' }
  }
  // Unknown platforms still get the estimate in the log; the live watchdog is
  // unavailable there, but refusing every sizeable job without a limit is worse.
  return { safe: true, estimateBytes: estimate, usedBytes: null, limitBytes: null, source: 'unknown' }
}
