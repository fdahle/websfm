// Cache-aware model loading, shared by the compute worker's feature backends.
//
// Cache Storage is populated by the MAIN thread (stores/useModelsStore.js) after
// the user consents and a progress modal streams the download. This module is the
// read side: the worker's core modules call `loadModelBytes(url)` which returns
// the cached weights when present, and otherwise falls back to a plain fetch (so
// dev — where the files sit at same-origin `public/models/` — keeps working with
// no consent flow, and so a same-origin production host without the modal still
// functions). Consent + progress is a UI concern and stays on the main thread;
// by the time the worker runs, the bytes are already cached.
//
// Pure w.r.t. Vue/DOM; `caches`/`fetch` exist in both Window and Worker scopes.
// Guarded with typeof checks so the module also imports cleanly under vitest node.

import { MODEL_CACHE_NAME } from './registry.js'

/** Cached bytes for `url`, or null on miss / no Cache Storage. Never throws. */
export async function readCachedModel(url) {
  try {
    if (typeof caches === 'undefined') return null
    const cache = await caches.open(MODEL_CACHE_NAME)
    const resp = await cache.match(url)
    return resp ? await resp.arrayBuffer() : null
  } catch {
    return null
  }
}

/** True iff `url`'s bytes are already in Cache Storage. */
export async function isModelCached(url) {
  return (await readCachedModel(url)) != null
}

/**
 * Resolve a model to its bytes for InferenceSession.create.
 * - A non-string (already an ArrayBuffer/Uint8Array) is passed through untouched.
 * - A string URL is served from Cache Storage when present, else fetched directly.
 */
export async function loadModelBytes(model, onLog, label = 'model') {
  if (typeof model !== 'string') return model
  const cached = await readCachedModel(model)
  if (cached) {
    onLog?.(`${label}: loaded ${(cached.byteLength / 1e6).toFixed(1)} MB from cache`)
    return cached
  }
  const t = (typeof performance !== 'undefined' ? performance.now() : 0)
  const resp = await fetch(model)
  if (!resp.ok) throw new Error(`${label} fetch failed: HTTP ${resp.status} for ${model}`)
  const buf = await resp.arrayBuffer()
  const ms = typeof performance !== 'undefined' ? Math.round(performance.now() - t) : 0
  onLog?.(`${label}: downloaded ${(buf.byteLength / 1e6).toFixed(1)} MB in ${ms} ms`)
  return buf
}
