// Stage A over the worker pool (stores/reconstruction/dense.js). On the CPU path each
// depth map is one single-threaded WASM PatchMatch, so a run spreads its images over
// the pool's workers, each with its share of the memory budget. On the GPU one worker
// feeds the device, which is the bottleneck there.

/**
 * How many workers to split `n` depth maps over: at most `poolSize`, at least
 * `minPerWorker` maps each (a worker re-decodes the source photos its neighbours'
 * chunks also use), and no more than `budget` holds when each worker peaks at
 * `perWorkerBytes`.
 */
export function depthWorkerCount({ n, poolSize, budget, perWorkerBytes, minPerWorker = 4 }) {
  const byWork = Math.floor(n / minPerWorker)
  const byMemory = perWorkerBytes > 0 ? Math.floor(budget / perWorkerBytes) : poolSize
  return Math.max(1, Math.min(poolSize, byWork, byMemory))
}

/**
 * `n` indices in `parts` contiguous chunks of near-equal size. Contiguous, because
 * neighbouring captures share source views, so each worker decodes fewer photos.
 */
export function contiguousChunks(n, parts) {
  return Array.from({ length: parts }, (_, w) => {
    const a = Math.floor((w * n) / parts),
      b = Math.floor(((w + 1) * n) / parts)
    return Array.from({ length: b - a }, (_, k) => a + k)
  })
}

const median = (vals) => {
  if (!vals.length) return null
  const s = [...vals].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.round(0.5 * (s.length - 1)))]
}

/**
 * One Stage A summary from the workers' results (`{ summary, perImage }` each), as a
 * single worker would have reported it: counts summed, medians over every image,
 * the wall time of the whole run, and the peak memory of all workers together.
 */
export function mergeDepthSummaries(parts, { totalMs, nImages }) {
  const per = parts.flatMap((p) => p.perImage ?? [])
  const sums = (key) => parts.reduce((s, p) => s + (p.summary?.[key] ?? 0), 0)
  const fallbacks = sums('gpuFallbacks')
  const startedOnGpu = parts.some((p) => p.summary?.backend?.startsWith('gpu'))
  return {
    ...parts[0].summary,
    nMaps: sums('nMaps'),
    nImages,
    backend: startedOnGpu ? (fallbacks ? 'gpu→wasm' : 'gpu') : 'wasm',
    gpuFallbacks: fallbacks,
    workers: parts.length,
    medianMsPerImage: median(per.map((p) => p.ms)),
    totalMs,
    medianCoveragePct: median(per.map((p) => p.coveragePct)),
    medianCostMedian: median(per.map((p) => p.costMedian)),
    projectedPeakBytes: sums('projectedPeakBytes'),
    budgetBytes: sums('budgetBytes'),
  }
}
