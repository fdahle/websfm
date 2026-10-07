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

// Every real weight file is megabytes; anything this small is an error page.
export const MIN_MODEL_BYTES = 64 * 1024

/**
 * Why a response cannot be an ONNX model, or null if it plausibly is. ONNX is a
 * binary protobuf, so a body that opens with `<` is a web page. The usual source
 * is a dev server's or static host's SPA fallback: a missing `/models/x.onnx`
 * comes back as `index.html` with HTTP 200, so `resp.ok` passes, and ORT later
 * fails with the opaque "protobuf parsing failed".
 * `head` = the first bytes of the body (≥ 16 is plenty), `size` = total bytes
 * (omit when unknown).
 */
export function modelBytesProblem({ head, size, contentType = '' }) {
  if (/text\/html/i.test(contentType)) return 'the server returned an HTML page'
  if (head) {
    const u8 = head instanceof Uint8Array ? head : new Uint8Array(head)
    let i = 0
    // Skip whitespace and a UTF-8 BOM before looking for the opening tag.
    while (i < u8.length && [0x20, 0x09, 0x0a, 0x0d, 0xef, 0xbb, 0xbf].includes(u8[i])) i++
    if (u8[i] === 0x3c) return 'the server returned an HTML/XML page'
  }
  if (Number.isFinite(size) && size < MIN_MODEL_BYTES) return `only ${size} bytes arrived`
  return null
}

/** The error to throw when `url` did not serve a model; names the likely fix. */
export function badModelError(label, url, problem) {
  return new Error(`${label}: ${url} is not an ONNX model (${problem}). The file is probably `
    + 'missing on the server: place the .onnx files in public/models/ or set VITE_MODEL_BASE_URL.')
}

async function evictCachedModel(url) {
  try { await (await caches.open(MODEL_CACHE_NAME)).delete(url) } catch { /* best effort */ }
}

/**
 * Cached bytes for `url`, or null on miss / no Cache Storage. Never throws. An
 * entry that is not a model (an HTML fallback page stored by an earlier download)
 * is evicted and reported as a miss.
 */
export async function readCachedModel(url) {
  try {
    if (typeof caches === 'undefined') return null
    const cache = await caches.open(MODEL_CACHE_NAME)
    const resp = await cache.match(url)
    if (!resp) return null
    const buf = await resp.arrayBuffer()
    if (modelBytesProblem({ head: new Uint8Array(buf, 0, Math.min(64, buf.byteLength)), size: buf.byteLength })) {
      await evictCachedModel(url)
      return null
    }
    return buf
  } catch {
    return null
  }
}

/**
 * True iff `url`'s bytes are already in Cache Storage. Reads headers only, never
 * the body. An entry whose recorded length is too small to be a model is evicted,
 * so the consent flow downloads it again instead of trusting a stored error page.
 */
export async function isModelCached(url) {
  try {
    if (typeof caches === 'undefined') return false
    const resp = await (await caches.open(MODEL_CACHE_NAME)).match(url)
    if (!resp) return false
    const len = Number(resp.headers?.get?.('content-length'))
    if (len > 0 && modelBytesProblem({ size: len })) {
      await evictCachedModel(url)
      return false
    }
    return true
  } catch {
    return false
  }
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
  const problem = modelBytesProblem({
    head: new Uint8Array(buf, 0, Math.min(64, buf.byteLength)),
    size: buf.byteLength,
    contentType: resp.headers?.get?.('content-type') ?? '',
  })
  if (problem) throw badModelError(label, model, problem)
  const ms = typeof performance !== 'undefined' ? Math.round(performance.now() - t) : 0
  onLog?.(`${label}: downloaded ${(buf.byteLength / 1e6).toFixed(1)} MB in ${ms} ms`)
  return buf
}
