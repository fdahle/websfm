// Central registry of the learned-model weights the app can fetch on demand.
//
// The ONNX weights (SuperPoint, LightGlue, SAM2 encoder/decoder) are NOT committed
// to the repo — they are large (the SAM2 encoder alone is ~128 MB, over GitHub's
// 100 MB per-file limit) and only a subset of users touch the learned backends. So
// they live at a hostable URL and are downloaded **on first use**, with user
// consent + a progress modal (see stores/useModelsStore.js), then cached in the
// browser's Cache Storage so the download is one-time per machine.
//
// This module is pure (no DOM, no Vue) so it can be imported from BOTH the main
// thread (the download/consent store) and the compute worker (the core feature
// modules that read the cached bytes). Both sides MUST resolve a model to the
// exact same URL string, or the worker's cache lookup misses what the main thread
// stored — that is why URL resolution lives here and nowhere else.

// id → { file, label, approxBytes, license } for every downloadable model.
// `license` is shown at the download-consent prompt (ModelDownloadModal) and in
// the About ▸ Licenses list — a model weight carries its OWN license, separate
// from websfm's MIT code, so a user knows what they are acquiring. The SuperPoint
// weights are from rpautrat's MIT-licensed reimplementation, NOT Magic Leap's
// original (research / non-commercial only) — keep them distinct if the file changes.
export const MODELS = {
  superpoint:   { file: 'superpoint.onnx',   label: 'SuperPoint feature detector', approxBytes: 5_000_000,   license: 'MIT' },
  lightglue:    { file: 'lightglue.onnx',    label: 'LightGlue matcher',           approxBytes: 45_000_000,  license: 'Apache-2.0' },
  sam2_encoder: { file: 'sam2_encoder.onnx', label: 'SAM2 image encoder',          approxBytes: 134_000_000, license: 'Apache-2.0' },
  sam2_decoder: { file: 'sam2_decoder.onnx', label: 'SAM2 mask decoder',           approxBytes: 21_000_000,  license: 'Apache-2.0' },
}

// Cache Storage bucket the downloaded weights live in. Bump the version suffix if
// a model file's contents change under the same name (forces a re-download).
export const MODEL_CACHE_NAME = 'websfm-models-v1'

/**
 * Base URL the model files are served from. Defaults to `<BASE_URL>models/`
 * (same origin), but a self-hosted deployment can point it at any static host /
 * CDN by setting `VITE_MODEL_BASE_URL` at build time (e.g.
 * `VITE_MODEL_BASE_URL=https://models.example.org/websfm/`).
 */
export function modelBaseUrl() {
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}
  const configured = env.VITE_MODEL_BASE_URL
  const base = configured || `${env.BASE_URL || '/'}models/`
  return base.endsWith('/') ? base : `${base}/`
}

/** Absolute (origin-relative) URL for a model id — the shared cache key. */
export function modelUrl(id) {
  const m = MODELS[id]
  if (!m) throw new Error(`Unknown model id: ${id}`)
  return `${modelBaseUrl()}${m.file}`
}

/** Human-readable MB for a byte count (e.g. 44.8). */
export function toMB(bytes) {
  return (bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)
}
