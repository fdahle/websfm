// WebGPU device lifecycle for the compute worker. Lazy singleton that mirrors the
// wasm init pattern (`siftReady ??= initSift()`): the first caller acquires an
// adapter + device, everyone after reuses it. Worker-only — this touches
// `navigator.gpu`, so it must never be imported from `core/*` (which stays
// pure/DOM-free). Returns null whenever GPU is unavailable so callers can fall
// back to the WASM path.

let devicePromise = null

// Cheap synchronous probe — is the WebGPU API even present?
export function isGpuAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.gpu
}

// Resolve to { device, adapter, info, limits } or null. Cached; safe to call per
// depth-map run. On device loss the cache is dropped so the next call re-inits
// (or, if the GPU is gone for good, falls back to WASM).
export function ensureDevice() {
  if (!isGpuAvailable()) return Promise.resolve(null)
  if (!devicePromise) devicePromise = initDevice()
  return devicePromise
}

async function initDevice() {
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return null

    // Ask for the adapter's *maximum* buffer limits. The defaults (128 MiB
    // storage-binding / 256 MiB buffer) are tiny next to what discrete/Apple GPUs
    // actually support (often multiple GB), and depth-map state scales with
    // pixels (npix×16 B) — at maxDim≈5000 the state buffer alone is ~380 MB and
    // would blow the default cap. Requesting up to `adapter.limits` is always
    // valid (those values are the supported maxima).
    const requiredLimits = {}
    for (const k of ['maxBufferSize', 'maxStorageBufferBindingSize']) {
      const v = adapter.limits?.[k]
      if (typeof v === 'number') requiredLimits[k] = v
    }
    const device = await adapter.requestDevice({ requiredLimits })

    // Drop the cached promise if this device is lost, so ensureDevice() re-inits.
    // (Ignore the 'destroyed' reason — that's our own teardown, not a failure.)
    device.lost.then((info) => {
      if (info?.reason !== 'destroyed') devicePromise = null
    })

    // Adapter identity (vendor/architecture) for the diagnostic log. The API has
    // moved from requestAdapterInfo() to a plain `.info` getter; support both.
    let info = {}
    try {
      info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {})
    } catch { /* info is best-effort */ }

    return { device, adapter, info, limits: device.limits, isFallback: !!adapter.isFallbackAdapter }
  } catch {
    // Any failure (no adapter, device request rejected) → treat as "no GPU".
    return null
  }
}

// Tear down the cached device (used by tests / explicit reset). Not needed in
// normal operation — the device lives for the worker's lifetime.
export async function destroyDevice() {
  if (!devicePromise) return
  const state = await devicePromise.catch(() => null)
  devicePromise = null
  state?.device?.destroy?.()
}
