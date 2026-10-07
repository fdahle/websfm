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

// id → model record for every downloadable model. `license` is shown at the
// download-consent prompt (ModelDownloadModal) and in About ▸ Licenses: a model
// weight carries its OWN license, separate from websfm's MIT code.
//
// `redistributable: false` marks weights websfm must not serve itself. The user
// fetches the file from `sourceUrl` (as `sourceFile`) and hands it to the app
// once (useModelsStore.provideModelFile); it is then cached exactly as a download
// would be. SuperPoint is the case: every public ONNX export carries Magic Leap's
// pretrained weights, whose license is academic / non-commercial research only.
// `scripts/check-release.mjs` refuses a release build that contains such a file.
//
// `source` records the exact upstream asset, so a re-download is reproducible.
const FABIO_SIM_V1 = 'https://github.com/fabio-sim/LightGlue-ONNX/releases/download/v1.0.0'
export const MODELS = {
  superpoint: {
    file: 'superpoint.onnx', label: 'SuperPoint feature detector', approxBytes: 5_300_000,
    license: 'Magic Leap academic / non-commercial research license',
    licenseUrl: 'https://github.com/magicleap/SuperPointPretrainedNetwork/blob/master/LICENSE',
    redistributable: false,
    // A plain link (not fetch) needs no CORS: one click saves the file.
    sourceUrl: `${FABIO_SIM_V1}/superpoint.onnx`, sourceFile: 'superpoint.onnx',
    source: 'fabio-sim/LightGlue-ONNX v1.0.0 superpoint.onnx',
  },
  lightglue: {
    file: 'lightglue.onnx', label: 'LightGlue matcher (for SuperPoint)', approxBytes: 45_600_000,
    license: 'Apache-2.0', licenseUrl: 'https://github.com/cvg/LightGlue/blob/main/LICENSE',
    source: 'fabio-sim/LightGlue-ONNX v1.0.0 superpoint_lightglue_fused_cpu.onnx',
  },
  disk: {
    file: 'disk.onnx', label: 'DISK feature detector', approxBytes: 4_400_000,
    license: 'Apache-2.0', licenseUrl: 'https://github.com/cvlab-epfl/disk/blob/master/LICENSE',
    source: 'fabio-sim/LightGlue-ONNX v1.0.0 disk.onnx',
  },
  lightglue_disk: {
    file: 'lightglue_disk.onnx', label: 'LightGlue matcher (for DISK)', approxBytes: 45_800_000,
    license: 'Apache-2.0', licenseUrl: 'https://github.com/cvg/LightGlue/blob/main/LICENSE',
    source: 'fabio-sim/LightGlue-ONNX v1.0.0 disk_lightglue_fused_cpu.onnx',
  },
  sam2_encoder: {
    file: 'sam2_encoder.onnx', label: 'SAM2 image encoder', approxBytes: 134_000_000,
    license: 'Apache-2.0', licenseUrl: 'https://github.com/facebookresearch/sam2/blob/main/LICENSE',
    source: 'onnx-community/sam2-hiera-tiny onnx/vision_encoder.onnx (value_info stripped)',
  },
  sam2_decoder: {
    file: 'sam2_decoder.onnx', label: 'SAM2 mask decoder', approxBytes: 21_000_000,
    license: 'Apache-2.0', licenseUrl: 'https://github.com/facebookresearch/sam2/blob/main/LICENSE',
    source: 'onnx-community/sam2-hiera-tiny onnx/prompt_encoder_mask_decoder.onnx (value_info stripped)',
  },
}

/** True when websfm may serve this model's weights itself. */
export function isRedistributable(id) {
  return MODELS[id]?.redistributable !== false
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
