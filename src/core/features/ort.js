// Shared ONNX Runtime Web bootstrap for the learned-feature backends
// (SuperPoint detection, LightGlue matching). One place owns the runtime config
// and the lazy-init pattern, mirroring the `initPromise` that core/features/bruteforce.js
// uses for its wasm.
//
// Execution providers: WebGPU first, WASM fallback — ORT tries them in order per
// session, so a machine with no WebGPU adapter transparently runs on WASM.
//
// Threading: multi-threaded when the page is cross-origin isolated, else 1.
// Multi-threaded ORT wasm needs SharedArrayBuffer → COOP/COEP; vite.config.js
// sends COOP: same-origin + COEP: credentialless (NOT require-corp, which would
// block the OpenLayers basemap tiles — credentialless lets no-cors subresources
// through). Chromium/Firefox isolate and get threads (~3× on LightGlue CPU);
// Safari ignores `credentialless`, stays un-isolated, and runs single-threaded.
// The production host must send the same two headers to get threads there.
//
// The ORT module is dynamic-imported so this file (and its importers) stay
// loadable under vitest's Node env; real inference is browser-only. Tests mock
// the InferenceSession — see TODO.md SP5.
//
// ORT's wasm runtime is served as a STATIC asset from public/ort/ (copied from
// node_modules/onnxruntime-web/dist). We point `wasmPaths` at that directory
// PREFIX so ORT fetches its own wasm by the exact filename its glue expects. This
// avoids the `?url` route, which handed the bundle a build it couldn't bind to
// ("ke.$b is not a function" — a wasm/glue version mismatch). Keep public/ort/ in
// sync with the onnxruntime-web version.

let ortPromise = null

export function getOrt(onLog) {
  if (!ortPromise) {
    ortPromise = (async () => {
      const t = performance.now()
      const ort = await import('onnxruntime-web/webgpu')
      onLog?.(`ORT: module loaded in ${Math.round(performance.now() - t)} ms`)
      // Quiet the per-session "VerifyEachNodeIsAssignedToAnEp" warning — it's
      // expected (some SuperPoint/LightGlue ops have no WebGPU kernel and run on
      // the CPU EP), not an error. Keep genuine errors.
      ort.env.logLevel = 'error'
      const base = (import.meta.env && import.meta.env.BASE_URL) || '/'
      ort.env.wasm.wasmPaths = `${base}ort/`
      if (!globalThis.crossOriginIsolated) ort.env.wasm.numThreads = 1
      return ort
    })()
  }
  return ortPromise
}

// Decide the execution backend once. ORT's WebGPU (JSEP) EP is only reliable on
// Chromium — on Safari, adapter acquisition succeeds but the EP then *hangs*
// inside session creation (WebGPU-in-worker + JSEP immaturity), and because it
// hangs rather than errors ORT never falls through to WASM. So we only offer
// WebGPU to ORT on Chromium (UA contains "Chrome/" — Chrome/Edge/Brave/Opera,
// but not Safari or Firefox) with an actual adapter; everyone else uses CPU WASM.
let backendPromise = null
export function resolveBackend() {
  if (!backendPromise) {
    backendPromise = (async () => {
      const ua = globalThis.navigator?.userAgent || ''
      const chromium = /Chrome\//.test(ua)
      if (chromium && globalThis.navigator?.gpu) {
        try {
          if (await navigator.gpu.requestAdapter()) return 'webgpu'
        } catch { /* fall through to wasm */ }
      }
      return 'wasm'
    })()
  }
  return backendPromise
}

/**
 * Create an InferenceSession from an ArrayBuffer / URL / Uint8Array. Uses WebGPU
 * only where it's reliable (see resolveBackend), else CPU WASM. Sessions are
 * heavy (LightGlue ≈45 MB) — callers cache and reuse them, not per call.
 *
 * @param {ArrayBuffer|Uint8Array|string} model
 * @param {import('onnxruntime-web').InferenceSession.SessionOptions} [opts]
 */
export async function createSession(model, opts = {}, onLog, backendOverride) {
  const ort = await getOrt(onLog)
  // `backendOverride` lets a caller pin a backend regardless of the machine —
  // e.g. LightGlue drives this to try 'webgpu' (opt-in) or 'wasm', managing its
  // own GPU→CPU fallback in core/features/lightglue.js rather than trusting ORT's EP order.
  const backend = backendOverride || await resolveBackend()
  onLog?.(`ORT: compiling wasm + creating session (${backend})…`)
  // A watchdog line so a hang here is visible and reportable — session creation
  // has no progress callback, and on a cold cache (or with DevTools open, which
  // slows Chrome's wasm compile a lot) it can take a while.
  const watchdog = setInterval(() => {
    onLog?.(`ORT: still creating session (${backend})… if this repeats for minutes, `
      + 'check the browser console (worker context) for errors; closing DevTools speeds up wasm compile')
  }, 15000)
  const t = performance.now()
  try {
    const session = await ort.InferenceSession.create(model, {
      executionProviders: backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
      graphOptimizationLevel: 'all',
      // Suppress the per-session "VerifyEachNodeIsAssignedToAnEp" warning — it's
      // session-scoped (not covered by env.logLevel) and expected (shape ops run
      // on CPU by design). 3 = Error; genuine errors still surface.
      logSeverityLevel: 3,
      ...opts,
    })
    onLog?.(`ORT: session created in ${Math.round(performance.now() - t)} ms (${backend})`)
    return session
  } finally {
    clearInterval(watchdog)
  }
}

/** A Tensor constructor accessor, for building model inputs. */
export async function tensor(type, data, dims) {
  const ort = await getOrt()
  return new ort.Tensor(type, data, dims)
}
