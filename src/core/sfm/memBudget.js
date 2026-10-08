// Sparse-SfM memory preflight. Unlike a thrown JS exception, renderer OOM is not
// catchable: the browser kills the whole tab, and a worker that runs out of heap dies
// silently. Estimate the peak before constructing the worker input and refuse — or,
// when guided track extension is what tips it over, run without it — rather than die.
//
// Two kinds of memory, because they hit different ceilings:
//   heap    — JS objects, Maps, arrays of numbers. Capped per isolate (renderer and
//             each worker separately) at ~4 GB by V8's pointer-compression cage
//             (`jsHeapSizeLimit`); a page cannot raise it.
//   buffers — ArrayBuffer / typed-array backing stores and wasm memory. They live
//             outside that cage (one Chrome worker held 7.2 GB of Float64Arrays with a
//             108 MB heap, 2026-10-08), so only the machine's memory bounds them.
// Since the compact-memory work (TODO ▸ MEM: keypoint sets, the track arena, packed
// matches) nearly all of the SfM data is buffers; the heap holds per-pair and
// per-image records, transient per-observation number arrays and guided extension's
// keypoint grids.
//
// The constants come from the headless bench's worker-heap sampler (scripts/bench/
// workerHeap.mjs), per keypoint / match / observation, ×`margin` for allocator slack
// and run-to-run variation. Measured values: HANDOVER ▸ B-mem.

export const SPARSE_HEAP_FRACTION = 0.86

// Fitted 2026-10-08 (HANDOVER ▸ B-mem) on South Building (128 images, 1.07 M keypoints,
// 0.92 M matches: worker heap 0.12 GB, heap + buffers 0.35 GB) and GeoScan PUTI (444,
// 1.43 M, 0.99 M: 0.16 / 0.50 GB), rounded up. The sampler's heap figure includes
// uncollected garbage, so these are generous; the model projects 0.22 / 0.26 GB of
// heap and 0.30 / 0.44 GB of worker buffers (×margin) against the 0.12 / 0.16 and
// 0.23 / 0.34 GB measured. Monster (4.5 M keypoints) projects 0.78 GB of heap.
export const SPARSE_MEMORY_MODEL = {
  margin: 1.25,
  // Renderer: the worker input, built as typed arrays and transferred.
  rendererBufPerKeypoint: 20, // Float64 xy + RGB + colour mask (core/sfm/keypointSet.js)
  rendererBufPerMatch: 8,     // packed Uint32 pair
  rendererHeapPerKeypoint: 2, // the per-image/per-pair input records, amortised
  // Worker heap (the ceiling that matters): per-pair records, the registration
  // correspondence cache, transient per-observation number arrays.
  workerHeapBase: 32 * 1024 ** 2,
  workerHeapPerObservation: 64,
  workerHeapPerKeypoint: 64,
  // Worker buffers: keypoint sets (input + a folded copy + a transient fold), packed
  // matches (input + the run's clone), the track arena and BA marshalling, and the
  // wasm solver's dense reduced camera system (n = 6·cameras: 8·n² bytes).
  workerBufPerKeypoint: 60,
  workerBufPerMatch: 16,
  workerBufPerObservation: 40,
  workerBufPerCameraSq: 288,
  // Guided track extension: its keypoint grids (heap) on top of the descriptors.
  guidedHeapPerKeypoint: 24,
}

/**
 * @param {{keypointCount?: number, matchCount?: number, imageCount?: number,
 *   descriptorBytesPerKeypoint?: number, guided?: boolean}} counts
 *   `descriptorBytesPerKeypoint` > 0 means guided extension runs (128: uint8 RootSIFT)
 *   unless `guided` says otherwise.
 */
export function projectSparsePeakBreakdownBytes({
  keypointCount = 0, matchCount = 0, imageCount = 0, descriptorBytesPerKeypoint = 0,
  guided = descriptorBytesPerKeypoint > 0,
} = {}, model = SPARSE_MEMORY_MODEL) {
  const C = Math.max(0, imageCount)
  const K = Math.max(0, keypointCount)
  const M = Math.max(0, matchCount)
  const D = guided ? K * Math.max(0, descriptorBytesPerKeypoint) : 0
  // Track observations are bounded by accepted matches and, in practice, by the
  // number of keypoints participating across overlapping cameras.
  const O = Math.min(M, Math.ceil(K * 0.85))
  const m = model
  const up = (v) => Math.ceil(v * m.margin)
  const rendererHeapBytes = up(K * m.rendererHeapPerKeypoint)
  // The descriptors are built one image at a time and transferred, so at most all of
  // them are resident in the renderer before the worker starts.
  const rendererBufferBytes = up(K * m.rendererBufPerKeypoint + M * m.rendererBufPerMatch + D)
  const guidedHeapBytes = guided ? up(K * m.guidedHeapPerKeypoint) : 0
  const workerHeapBytes = up(m.workerHeapBase + O * m.workerHeapPerObservation + K * m.workerHeapPerKeypoint)
    + guidedHeapBytes
  // Descriptors are held once: every sub-run shares them (sfm.js cloneSfmInput).
  const workerBufferBytes = up(K * m.workerBufPerKeypoint + M * m.workerBufPerMatch + O * m.workerBufPerObservation
    + C * C * m.workerBufPerCameraSq + D)
  return {
    rendererHeapBytes, rendererBufferBytes, workerHeapBytes, workerBufferBytes, guidedHeapBytes,
    guidedBufferBytes: up(D),
    // Per isolate, heap + buffers: what the device has to hold for each.
    rendererBytes: rendererHeapBytes + rendererBufferBytes,
    workerBytes: workerHeapBytes + workerBufferBytes,
    // Device-level reporting only. Renderer and worker do NOT share a V8 heap ceiling,
    // so this must never be compared to either isolate's jsHeapSizeLimit.
    totalBytes: rendererHeapBytes + rendererBufferBytes + workerHeapBytes + workerBufferBytes,
  }
}

export function projectSparsePeakBytes(counts = {}) {
  return projectSparsePeakBreakdownBytes(counts).totalBytes
}

/**
 * Is a projected peak safe for one isolate?
 * - With a live heap reading, the projected HEAP must fit under SPARSE_HEAP_FRACTION of
 *   that isolate's jsHeapSizeLimit; the projected BUFFERS (if given) must fit the
 *   device budget, which they share with everything else on the machine.
 * - Without one, heap + buffers must fit 75 % of the device budget.
 */
export function sparseMemoryDecision({
  estimateBytes, bufferBytes = 0, usedHeapBytes = null, heapLimitBytes = null,
  fallbackBudgetBytes = null, releasedBytes = 0,
}) {
  const estimate = Math.max(0, estimateBytes || 0)
  const buffers = Math.max(0, bufferBytes || 0)
  const deviceLimit = Number.isFinite(fallbackBudgetBytes) && fallbackBudgetBytes > 0 ? fallbackBudgetBytes * 0.75 : null
  if (Number.isFinite(heapLimitBytes) && heapLimitBytes > 0
      && Number.isFinite(usedHeapBytes) && usedHeapBytes >= 0) {
    const used = Math.max(0, usedHeapBytes - Math.max(0, releasedBytes || 0))
    const limit = heapLimitBytes * SPARSE_HEAP_FRACTION
    const heapSafe = used + estimate <= limit
    const buffersSafe = deviceLimit == null || buffers <= deviceLimit
    return { safe: heapSafe && buffersSafe, heapSafe, buffersSafe, estimateBytes: estimate, bufferBytes: buffers,
      usedBytes: used, limitBytes: limit, bufferLimitBytes: deviceLimit, source: 'heap' }
  }
  if (deviceLimit != null) {
    const safe = estimate + buffers <= deviceLimit
    return { safe, heapSafe: safe, buffersSafe: safe, estimateBytes: estimate, bufferBytes: buffers,
      usedBytes: null, limitBytes: deviceLimit, bufferLimitBytes: deviceLimit, source: 'device' }
  }
  // Unknown platforms still get the estimate in the log; the live watchdog is
  // unavailable there, but refusing every sizeable job without a limit is worse.
  return { safe: true, heapSafe: true, buffersSafe: true, estimateBytes: estimate, bufferBytes: buffers,
    usedBytes: null, limitBytes: null, bufferLimitBytes: null, source: 'unknown' }
}

/**
 * Decide how a sparse run goes ahead: as asked, without guided track extension (when
 * that alone makes it fit — a run that finishes with a warning beats one that dies in
 * the worker), or not at all.
 * @param {{ guided: boolean, project: (guided: boolean) => object,
 *   decide: (peak: object) => { renderer: {safe:boolean}, worker: {safe:boolean} } }} o
 * @returns {{ peak: object, decisions: object, guided: boolean, guidedDropped: boolean,
 *   withGuidedPeak: object | null, safe: boolean }}
 */
export function planSparseRun({ guided, project, decide }) {
  const ok = (d) => d.renderer.safe && d.worker.safe
  const peak = project(guided)
  const decisions = decide(peak)
  if (ok(decisions) || !guided) {
    return { peak, decisions, guided, guidedDropped: false, withGuidedPeak: null, safe: ok(decisions) }
  }
  const lean = project(false)
  const leanDecisions = decide(lean)
  if (ok(leanDecisions)) {
    return { peak: lean, decisions: leanDecisions, guided: false, guidedDropped: true, withGuidedPeak: peak, safe: true }
  }
  return { peak, decisions, guided, guidedDropped: false, withGuidedPeak: null, safe: false }
}
