// SuperPoint detector wrapper — the learned alternative to detect_sift.
// Wraps an ONNX SuperPoint model via core/ort.js, mirroring how core/matching.js
// wraps its wasm (lazy, cached, plain-data in / plain-data out).
//
// Contract (matches the SIFT path so the worker's detect() can branch cleanly):
//   in : gray Float32Array length w*h, normalised [0,1], row-major; w,h in the
//        rasterised (network-input) pixel space the caller already produced.
//   out: { keypoints: [{x,y,score}], descriptors: Float32Array(N*256, row-major),
//          dim: 256 }, coords in that same network-input space (the worker maps
//          them back to original pixels via /scale, exactly like SIFT).
//
// Output tensors are identified by SHAPE, not name — SuperPoint ONNX exports
// disagree on output names and descriptor orientation ([1,256,N] channels-first
// vs [1,N,256]). We locate: descriptors = the 256-axis tensor, keypoints = the
// last-dim-2 tensor, scores = the remaining ~1-D tensor. If your export orders
// keypoints as (y,x) rather than (x,y), that's the one thing to flip here — the
// #1 thing to validate on a known image (see TODO.md SP1).

import { createSession, tensor, resolveBackend } from './ort.js'

export const SUPERPOINT_DESC_DIM = 256

// One cached session per model key (default bundle, or a custom upload later).
const sessions = new Map()
// Model keys whose first (shader-compiling) inference has already run.
const warmedUp = new Set()

function defaultModelUrl() {
  // Bundled default under public/models/ (SP0); SP4 lets a custom upload override.
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/'
  return `${base}models/superpoint.onnx`
}

// Fetch the model bytes ourselves (when given a URL) so the download phase is
// timed + logged separately from ORT init — otherwise a slow createSession is
// ambiguous between "downloading model", "compiling 26 MB wasm", and "building
// the WebGPU device". A Uint8Array/ArrayBuffer is passed through untouched.
async function loadModelBytes(model, onLog) {
  if (typeof model !== 'string') return model
  const t = performance.now()
  const resp = await fetch(model)
  if (!resp.ok) throw new Error(`SuperPoint model fetch failed: HTTP ${resp.status} for ${model}`)
  const buf = await resp.arrayBuffer()
  onLog?.(`SuperPoint: model downloaded (${(buf.byteLength / 1e6).toFixed(1)} MB) in `
    + `${Math.round(performance.now() - t)} ms — now compiling ONNX runtime + WebGPU device (first run only)…`)
  return buf
}

// Build the session once per model key. The first call is the expensive one and
// is logged in phases so a stall is attributable to a specific step.
function getSession(model, key, onLog) {
  if (!sessions.has(key)) {
    sessions.set(key, (async () => {
      const backend = await resolveBackend()
      onLog?.(`SuperPoint: first run — backend ${backend}`
        + `${backend === 'webgpu' ? '' : ' (CPU; WebGPU via ORT is Chromium-only for now — use Chrome/Edge for GPU speed)'}; fetching model…`)
      const bytes = await loadModelBytes(model, onLog)
      const t = performance.now()
      const session = await createSession(bytes, {}, onLog)
      onLog?.(`SuperPoint: runtime ready in ${Math.round(performance.now() - t)} ms `
        + `(backend ${backend}; inputs [${session.inputNames}] → outputs [${session.outputNames}])`)
      return session
    })())
  }
  return sessions.get(key)
}

// Coerce a tensor's data (Float32Array / BigInt64Array / Int32Array) to plain
// number access without materialising a whole copy.
function num(data, i) {
  const v = data[i]
  return typeof v === 'bigint' ? Number(v) : v
}

// Classify the run() outputs by shape into {kpTensor, descTensor, scoreTensor}.
// Keypoints are claimed FIRST (last dim exactly 2); the remaining two are told
// apart by element count relative to N (desc = N·256, score = N), so a run that
// happens to find exactly 256 keypoints can't misassign the [1,256,2] / [1,256]
// tensors to the descriptor slot.
function classifyOutputs(results, outputNames) {
  const tensors = outputNames.map((name) => results[name]).filter(Boolean)
  const kp = tensors.find((t) => t.dims[t.dims.length - 1] === 2) || null
  if (!kp) return { kp: null, desc: null, score: null }
  const n = kp.dims[kp.dims.length - 2]
  const count = (t) => t.dims.reduce((a, b) => a * b, 1)
  const rest = tensors.filter((t) => t !== kp)
  const desc = rest.find((t) => t.dims.includes(SUPERPOINT_DESC_DIM) && count(t) === n * SUPERPOINT_DESC_DIM) || null
  const score = rest.find((t) => t !== desc && count(t) === n) || null
  return { kp, desc, score }
}

/**
 * Run SuperPoint on one grayscale image.
 *
 * @param {Float32Array} gray  length w*h, normalised [0,1]
 * @param {number} w
 * @param {number} h
 * @param {object} [opts]
 * @param {number} [opts.maxKeypoints=5000]  keep top-K by score (0 = all)
 * @param {ArrayBuffer|Uint8Array|string} [opts.model]  onnx source
 * @param {string} [opts.modelKey='default']  session-cache key
 * @returns {Promise<{keypoints:{x:number,y:number,score:number}[], descriptors:Float32Array, dim:number}>}
 */
export async function detectSuperPoint(gray, w, h, opts = {}) {
  const { maxKeypoints = 5000, model = defaultModelUrl(), modelKey = 'default', onLog } = opts
  const session = await getSession(model, modelKey, onLog)

  const input = await tensor('float32', gray, [1, 1, h, w])
  // On WebGPU the first run() compiles the graph's shaders — often the real
  // first-image cost (not createSession). Time it once so a stall here is visible.
  const first = !warmedUp.has(modelKey)
  if (first) onLog?.(`SuperPoint: first inference on ${w}×${h} (compiling GPU shaders — one-time)…`)
  const tRun = performance.now()
  const results = await session.run({ [session.inputNames[0]]: input })
  if (first) {
    warmedUp.add(modelKey)
    onLog?.(`SuperPoint: first inference done in ${Math.round(performance.now() - tRun)} ms; subsequent images reuse the compiled graph`)
  }
  const { kp, desc, score } = classifyOutputs(results, session.outputNames)
  if (!kp || !desc) {
    throw new Error(
      `SuperPoint: could not locate keypoint/descriptor outputs among [${session.outputNames.join(', ')}]`,
    )
  }

  const n = kp.dims[kp.dims.length - 2] // [...,N,2]
  // Descriptor layout: find the non-256 (=N) axis to know orientation.
  const dDims = desc.dims
  const descAxis = dDims.lastIndexOf(SUPERPOINT_DESC_DIM)
  const channelsFirst = descAxis === dDims.length - 2 // [...,256,N]
  const dData = desc.data
  const readDesc = channelsFirst
    ? (i, d) => dData[d * n + i] // [256,N]: row d, col i
    : (i, d) => dData[i * SUPERPOINT_DESC_DIM + d] // [N,256]: row i

  const kData = kp.data
  const sData = score ? score.data : null

  // Order by score (desc) so an optional cap keeps the strongest, and the sparse
  // cloud / LightGlue see features best-first (SIFT is response-sorted too).
  const order = Array.from({ length: n }, (_, i) => i)
  if (sData) order.sort((a, b) => num(sData, b) - num(sData, a))
  const kept = maxKeypoints > 0 ? Math.min(n, maxKeypoints) : n

  const keypoints = new Array(kept)
  const descriptors = new Float32Array(kept * SUPERPOINT_DESC_DIM)
  for (let k = 0; k < kept; k++) {
    const i = order[k]
    keypoints[k] = {
      x: num(kData, i * 2),
      y: num(kData, i * 2 + 1),
      score: sData ? num(sData, i) : 1,
    }
    const base = k * SUPERPOINT_DESC_DIM
    for (let d = 0; d < SUPERPOINT_DESC_DIM; d++) descriptors[base + d] = readDesc(i, d)
  }

  return { keypoints, descriptors, dim: SUPERPOINT_DESC_DIM }
}
