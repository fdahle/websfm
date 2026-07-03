// Memory ledger + dense-run pre-flight (Step 5). Safari exposes no memory APIs
// (performance.memory / navigator.deviceMemory / measureUserAgentSpecificMemory
// are Chrome-only) and its OOM tab-kill is not interceptable, so the only viable
// strategy is self-accounting: project the peak allocation of a dense run BEFORE
// starting and refuse (with actionable numbers) when it exceeds a user budget,
// and track live allocations so the projection can be audited against reality.
//
// Pure module — no DOM/OPFS/Vue, so it lives in core/ (and its tests run there).
// The worker owns a ledger instance and threads it through rasters / planes / GPU
// buffers; the pre-flight is a plain arithmetic projection from image count,
// working dims, source count, and backend.

// Default budget: ~2 GB. Conservative for a browser tab on unified-memory Macs
// (the GPU competes for the same RAM Safari polices).
export const DEFAULT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024

// Human-readable byte size (GiB/MiB) for logs and UI.
export function formatBytes(n) {
  if (!(n > 0)) return '0 B'
  const g = n / (1024 ** 3)
  if (g >= 1) return `${g.toFixed(2)} GB`
  const m = n / (1024 ** 2)
  if (m >= 1) return `${m.toFixed(0)} MB`
  return `${(n / 1024).toFixed(0)} KB`
}

// A tagged allocation ledger. track()/release() by tag; used() is the current
// live total; peak() the high-water mark. Re-tracking a live tag replaces its
// size (so a resized buffer is accounted correctly). Releasing an unknown tag is
// a no-op (idempotent cleanup on error paths).
export function createMemLedger() {
  const entries = new Map() // tag → bytes
  let used = 0
  let peak = 0
  return {
    track(tag, bytes) {
      const b = Math.max(0, bytes | 0 || bytes) // tolerate large (non-int32) sizes
      used += b - (entries.get(tag) || 0)
      entries.set(tag, b)
      if (used > peak) peak = used
      return used
    },
    release(tag) {
      if (entries.has(tag)) {
        used -= entries.get(tag)
        entries.delete(tag)
      }
      return used
    },
    used: () => used,
    peak: () => peak,
    size: () => entries.size,
  }
}

// Project the peak resident bytes of a Build-Depth-Maps run with the CURRENT
// (non-streaming) architecture, so the pre-flight over- rather than under-counts:
//   • store cache — depth (f32) + cost (f32) + rgb (u8) planes retained for ALL
//     images after Stage A (kept for densify + ortho): 11 B/px × nImages.
//   • worker raster cache — RGBA per image held for the whole batch: 4 B/px ×
//     nImages (Step 4's eviction + gray-only caching reduces this; pass
//     rasterBytesPerPx to reflect it).
//   • GPU transient (gpu backend only) — for the image in flight: state (16) +
//     readback (16) + JS-heap slice (16) + source textures (4 B/px × nSources).
// Working dims are the maxDim² upper bound (longest side = maxDim, other ≤ it).
// Returns a byte breakdown { store, raster, gpu, total }.
export function projectDensePeakBytes({
  nImages, maxDim, nSources = 6, backend = 'wasm', rasterBytesPerPx = 4,
}) {
  const npix = maxDim * maxDim
  const store = nImages * 11 * npix
  const raster = nImages * rasterBytesPerPx * npix
  const gpu = backend === 'gpu' ? (48 * npix + nSources * 4 * npix) : 0
  return { store, raster, gpu, total: store + raster + gpu }
}
