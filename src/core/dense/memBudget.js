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

import { formatBytes } from '../formatBytes.js'
import { MAX_BUFFER_BYTES, TAB_BUFFER_POOL_BYTES } from '../bufferLimit.js'

// Default budget: ~2 GB. Conservative for a browser tab on unified-memory Macs
// (the GPU competes for the same RAM Safari polices).
export const DEFAULT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024

const GiB = 1024 ** 3

// What Chrome lets a tab hold, whatever the machine has (core/bufferLimit.js): one
// ArrayBuffer of at most 2 GiB − 2 MiB, and 16 GiB of them for the page and all its
// workers together. A 103 M-point fusion died at its very end on one 2.48 GB output
// array, and a 16 GB budget promised memory the tab can never have.
// The most a budget may claim: the pool less room for the rest of the tab (images,
// clouds, the viewer, other workers).
export const MAX_BUDGET_BYTES = TAB_BUFFER_POOL_BYTES - 4 * GiB
// The cloud keeps its positions in one Float32Array (12 B a point).
export const MAX_CLOUD_POINTS = Math.floor(MAX_BUFFER_BYTES / 12)

// A device-derived budget is clamped to this window: never trust a tab with more
// than 6 GB (the OS, the GPU and other tabs all compete for it), never gate below
// 1 GB (even a small machine can run a modest dense job, and the per-run pre-flight
// is the real guard).
const MIN_DEVICE_BUDGET_BYTES = 1 * GiB
const MAX_DEVICE_BUDGET_BYTES = 6 * GiB
// Fraction of total device memory a single tab may claim for a dense run.
const DEVICE_MEMORY_FRACTION = 0.5
// Fraction of the JS-heap ceiling to use when that is the only signal (weaker: it
// caps the JS heap, not the typed-array/wasm/GPU allocations a dense run dominates with).
const HEAP_LIMIT_FRACTION = 0.75

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

/**
 * Derive a dense-run memory budget from injected hardware readings. PURE: the
 * caller (main thread) reads `navigator.deviceMemory` (GB) and
 * `performance.memory.jsHeapSizeLimit` (bytes) — both Chrome-only — and passes the
 * numbers in; core never touches a global. When nothing is known (Safari/Firefox)
 * it returns the conservative {@link DEFAULT_BUDGET_BYTES}, so behaviour is
 * unchanged from before this existed.
 *
 * `deviceMemoryGB` is passed straight through for `core/recommend.js` (U2) to pick
 * a dense quality; it is null unless `navigator.deviceMemory` was the source.
 *
 * @param {{ deviceMemoryGB?: number|null, jsHeapLimitBytes?: number|null }} [readings]
 * @returns {{ budgetBytes: number, deviceMemoryGB: number|null, source: string, note: string }}
 */
export function deviceBudget({ deviceMemoryGB = null, jsHeapLimitBytes = null } = {}) {
  if (Number.isFinite(deviceMemoryGB) && deviceMemoryGB > 0) {
    const budgetBytes = clamp(deviceMemoryGB * GiB * DEVICE_MEMORY_FRACTION, MIN_DEVICE_BUDGET_BYTES, MAX_DEVICE_BUDGET_BYTES)
    return {
      budgetBytes,
      deviceMemoryGB,
      source: 'navigator.deviceMemory',
      // deviceMemory is browser-capped at 8 GB for fingerprinting resistance, so a
      // high-RAM machine reads 8 and lands at the clamp — that is expected, not a bug.
      note: `Device budget ${formatBytes(budgetBytes)} — ${DEVICE_MEMORY_FRACTION * 100}% of ${deviceMemoryGB} GB device memory (browser-capped at 8).`,
    }
  }
  if (Number.isFinite(jsHeapLimitBytes) && jsHeapLimitBytes > 0) {
    const budgetBytes = clamp(jsHeapLimitBytes * HEAP_LIMIT_FRACTION, MIN_DEVICE_BUDGET_BYTES, MAX_DEVICE_BUDGET_BYTES)
    return {
      budgetBytes,
      deviceMemoryGB: null,
      source: 'performance.memory',
      note: `Device budget ${formatBytes(budgetBytes)} — ${HEAP_LIMIT_FRACTION * 100}% of the ${formatBytes(jsHeapLimitBytes)} JS-heap limit (no deviceMemory available).`,
    }
  }
  return {
    budgetBytes: DEFAULT_BUDGET_BYTES,
    deviceMemoryGB: null,
    source: 'default',
    note: `Device budget ${formatBytes(DEFAULT_BUDGET_BYTES)} — no memory API available (Safari/Firefox); using the conservative default.`,
  }
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

// Project the peak resident bytes of a Build-Depth-Maps run, so the pre-flight over-
// rather than under-counts:
//   • store cache — depth (f32) + cost (f32) + rgb (u8) + normals (3×f32) planes:
//     23 B/px × `retainedMaps`. Without streaming every map is retained to the end
//     (retainedMaps = nImages); a streamed run hands each map off as it finishes, so
//     only the one in flight is resident (retainedMaps = 1).
//   • worker raster cache — RGBA per image held for the whole batch: 4 B/px ×
//     nImages (Step 4's eviction + gray-only caching reduces this; pass
//     rasterBytesPerPx to reflect it).
//   • GPU transient (gpu backend only) — for the image in flight: state (16) +
//     readback (16) + JS-heap slice (16) + source textures (4 B/px × nSources).
//   • cross-view filter masks — the in-memory filter (mvs.js filterDepthMapsGeometric)
//     holds an unpacked 1 B/px drop mask for every map it judges, all at once, beside
//     the retained maps: 1 B/px × `filterMaps`. The worker passes 0 when the filter is
//     off or runs as its own streamed pass over the saved maps; the default assumes it
//     runs over every retained map. Charged on top of the raster term (already the
//     batch-long upper bound), so the projection still over-counts.
// Working dims are the maxDim² upper bound (longest side = maxDim, other ≤ it).
// Returns a byte breakdown { store, raster, gpu, filter, total }.
export function projectDensePeakBytes({
  nImages, maxDim, nSources = 6, backend = 'wasm', rasterBytesPerPx = 4, retainedMaps = nImages,
  filterMaps = retainedMaps, pixels = null,
}) {
  // Per-image working pixels when the sizes are known (workingPixels); else the
  // maxDim² upper bound, which counts a 2 : 1 frame at twice its size (the KH-9
  // mapping camera's 7.1 GB at High was 3.6 GB of real pixels).
  const px = pixels?.length ? pixels : Array.from({ length: nImages }, () => maxDim * maxDim)
  const largest = px.reduce((m, v) => Math.max(m, v), 0)
  const sum = px.reduce((a, v) => a + v, 0)
  // `count` maps of the largest size, or all of them when every map is held.
  const some = (count) => (count >= px.length ? sum : count * largest)
  const store = 23 * some(retainedMaps) // depth 4 + cost 4 + rgb 3 + normals 12
  const raster = rasterBytesPerPx * sum
  const gpu = backend === 'gpu' ? (48 * largest + nSources * 4 * largest) : 0
  const filter = some(filterMaps)
  return { store, raster, gpu, filter, total: store + raster + gpu + filter }
}

// Working pixels of one image when its long side is brought to ≤ maxDim (the dense
// rasterize rule): width·height scaled, not maxDim². Unknown size ⇒ the square bound.
export function workingPixels(width, height, maxDim) {
  if (!(width > 0 && height > 0)) return maxDim * maxDim
  const s = Math.min(1, maxDim / Math.max(width, height))
  return Math.round(width * s) * Math.round(height * s)
}

// Fusion's voxel accumulator (core/dense/mvs.js createVoxelAccumulator), per merged
// cell: Float64×3 position sums (24) + Uint32×3 colour sums (12) + Float32×3 normal
// sums (12) + Uint32 count (4) + Float64 packed key (8) = 60 B, plus the
// open-addressing index — an Int32 table kept at load ≤ ½, so ≤ 16 B/cell. Fusion
// presizes the accumulator from the measured cell count, so there is no doubling
// slack to charge for.
// Finishing a slab writes the cloud's own layout while it releases the accumulator
// (voxelAccumulator finalizeCloud), so it peaks below this and needs no term of its own.
export const DENSIFY_CELL_BYTES = 76
// The most cells one accumulator may hold. Its largest array is the index table, an
// Int32 power of two at least twice the capacity: 2^28 entries (1 GiB) serve 2^27
// cells, and the next size, 2 GiB, is over MAX_BUFFER_BYTES.
export const MAX_ACCUMULATOR_CELLS = 2 ** Math.floor(Math.log2(MAX_BUFFER_BYTES / 4)) / 2

// What the streamed consistency check (mvs.js fuseDepthMapsStreamed) allocates per
// reference pixel beside the map itself: the agree (Uint32) + angle (Float64) scratch
// planes, 12 B/px, and the eligible-pixel buffers (mvs.js streamedEligible) — Int32
// index + Float64×3 world point, 28 B, plus the Int32 list of pixels still open, 4 B,
// per eligible pixel, charged as if every pixel were.
export const DENSIFY_STREAMED_REF_BYTES_PER_PX = 12 + 32

// Bytes the fusion input holds resident. Resident maps (`streamed: false`) are the
// planes themselves, transferred to the worker (×1; residency 2 models a clone).
// Streamed maps are read from disk on demand, one reference at a time: the peak is the
// largest reference's full map plus its check buffers (DENSIFY_STREAMED_REF_BYTES_PER_PX).
// Comparison maps are depth planes in the comparison cache, which the caller charges
// separately (mvs.js adds `cacheBytes`) — no second full map is ever held.
export function densifyInputBytes(maps, { streamed = false, residency = 1 } = {}) {
  if (streamed) {
    let peak = 0
    for (const m of maps) {
      // depth 4 + cost 4 + rgb 3 (+ normals 12), plus the check's per-pixel buffers.
      const bytes = m.width * m.height * ((m.hasNormals ? 23 : 11) + DENSIFY_STREAMED_REF_BYTES_PER_PX)
      if (bytes > peak) peak = bytes
    }
    return peak
  }
  let bytes = 0
  for (const m of maps) {
    bytes += (m.depth?.byteLength || 0) + (m.cost?.byteLength || 0)
      + (m.rgb?.byteLength || 0) + (m.normals?.byteLength || 0)
  }
  return bytes * residency
}

// Project the peak resident bytes of a Build-Point-Cloud (Stage B fusion) run, so
// the gate can refuse before the browser OOM-kills the tab. `cells` is MEASURED by
// fusion itself (mvs.js fusionCellEstimateSteps: the distinct merge cells of every
// pixel that passes the cost gate, at the real merge cell, step and region) — an
// upper bound, since the consistency/parallax/grazing/isolated filters only remove.
// It used to be guessed as valid px ÷ 2, which ignored the merge cell, the step and
// the view overlap, so the remedies the refusal suggested could not change it.
// A tiled run (`tileCells` < `cells`, mvs.js planFusionSlabs) holds one slab's
// accumulator at a time, beside the finished slabs already in the cloud's own layout;
// joining the slabs at the end holds the cloud twice.
// `workers` slabs in flight at once (parallel fusion) each hold their own input and
// accumulator.
// Returns { input, accumulator, finished, assemble, total, cells, tileCells, workers }.
export function projectDensifyPeakBytes({ inputBytes, cells, tileCells = cells, workers = 1 }) {
  const t = Math.min(tileCells, cells), k = Math.max(1, workers)
  const live = Math.min(cells, k * t)
  const input = k * inputBytes
  const accumulator = live * DENSIFY_CELL_BYTES
  const finished = (cells - live) * DENSIFY_CLOUD_BYTES_PER_CELL
  const assemble = t < cells ? 2 * cells * DENSIFY_CLOUD_BYTES_PER_CELL : 0
  const fusing = input + accumulator + finished
  return { input, accumulator, finished, assemble, total: Math.max(fusing, assemble), cells, tileCells: t, workers: k }
}

// The dense cloud's own arrays per point: Float32 position (12) + Uint8 colour (3) +
// Float32 normal (12) — what a finished slab is converted to.
export const DENSIFY_CLOUD_BYTES_PER_CELL = 27

// The largest slab (in cells) that keeps a tiled fusion run within `budget`; 0 when
// no slab size does (the cloud itself, held twice while joining, is over budget).
export function maxFusionTileCells({ inputBytes, cells, budget, workers = 1 }) {
  if (2 * cells * DENSIFY_CLOUD_BYTES_PER_CELL > budget) return 0
  const k = Math.max(1, workers)
  const perTileCell = DENSIFY_CELL_BYTES - DENSIFY_CLOUD_BYTES_PER_CELL
  const t = Math.floor((budget - k * inputBytes - cells * DENSIFY_CLOUD_BYTES_PER_CELL) / (k * perTileCell))
  return Math.max(0, Math.min(cells, t))
}

// The one byte formatter (core/formatBytes.js), re-exported for existing importers.
export { formatBytes }
