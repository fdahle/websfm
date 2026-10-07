// Learned (ONNX) detector runner — SuperPoint and DISK, the learned alternatives
// to detect_sift. Wraps an ONNX model via core/features/ort.js, mirroring how
// core/features/bruteforce.js wraps its wasm (lazy, cached, plain-data in / out).
// Which detectors exist, and their descriptor width / input channels, is
// core/features/learnedDetectors.js; this module only runs one.
//
// Contract (matches the SIFT path so the worker's detect() can branch cleanly):
//   in : pixels Float32Array, normalised [0,1], planar CHW (channels × h × w) with
//        `spec.channels` planes — 1 = luma (SuperPoint), 3 = RGB (DISK); w,h in the
//        rasterised (network-input) pixel space the caller already produced.
//   out: { keypoints: [{x,y,score}], descriptors: Float32Array(N*dim, row-major),
//          dim }, coords in that same network-input space (the worker maps them
//          back to original pixels, exactly like SIFT).
//
// Output tensors are identified by SHAPE, not name — ONNX exports disagree on
// output names and descriptor orientation ([1,D,N] channels-first vs [1,N,D]). We
// locate: keypoints = the last-dim-2 tensor, descriptors = the tensor of N·D
// elements with a D axis, scores = the remaining N-element tensor. Both shipped
// exports (fabio-sim LightGlue-ONNX v1.0.0) emit keypoints as (x, y); an export
// that orders them (y, x) is the one thing to flip here.

import { createSession, tensor, resolveBackend } from './ort.js'
import { modelUrl } from '../models/registry.js'
import { loadModelBytes } from '../models/modelCache.js'

// ONNX Runtime raises an "Integer overflow" / SafeIntOnOverflow when a single untiled
// pass on a very large image blows past its int32 tensor-size math (see
// DETECT_TUNING.spMaxUntiledInputPx). It is NOT a GPU-memory failure, so we don't fall
// back GPU→CPU (WASM overflows the same way) — we rethrow an actionable message.
function isSizeOverflow(err) {
  return /integer overflow|safeint/i.test(String(err?.message || err))
}
function sizeOverflowError(label, w, h) {
  const mp = ((w * h) / 1e6).toFixed(1)
  return new Error(
    `${label}: input ${w}×${h} (${mp} MP) is too large for a single pass — ONNX `
    + `Runtime overflowed its 32-bit tensor-size limit. Enable Tiling in the Detect `
    + `Features dialog (recommended) or lower the Detection resolution.`,
  )
}

// One cached session per `${modelKey}:${backend}` — a modelKey can hold both a
// WebGPU and a WASM session if we fall back mid-run (see detectLearned).
const sessions = new Map()
// Model keys whose first (shader-compiling) inference has already run.
const warmedUp = new Set()
// Once the WebGPU path fails for a modelKey (OOM / device error on a run) we
// remember the SMALLEST input (pixel count) it failed at and use CPU WASM for
// any input that big or bigger, so we don't pay the failed-GPU cost on every
// image. These detectors are fully convolutional and run early layers at full
// input resolution, so a large image can exhaust GPU memory (std::bad_alloc
// from ORT's WebGPU EP) where a smaller one fits — which is why the pin is
// size-aware: a 10000px full-frame failure must not condemn 1024px tiles.
const gpuFailedAtPx = new Map() // modelKey → smallest failed npix

// Resolve which backend to *try* for this model + input size: WASM if the GPU
// path already failed at this size or smaller (see gpuFailedAtPx), or if the
// machine has no usable WebGPU adapter (resolveBackend gates that to Chromium +
// adapter); else WebGPU. Returns { backend, reason } so the caller can log an
// honest explanation instead of the generic "Chromium-only" line.
async function chooseBackend(modelKey, npix) {
  const failedAt = gpuFailedAtPx.get(modelKey)
  if (failedAt !== undefined && npix >= failedAt) {
    return { backend: 'wasm', reason: `WebGPU failed earlier at ${failedAt} px — inputs that size or larger stay on CPU` }
  }
  const backend = await resolveBackend()
  return { backend, reason: backend === 'webgpu' ? '' : 'WebGPU via ORT is Chromium-only for now — use Chrome/Edge for GPU speed' }
}

// Build the session once per `${modelKey}:${backend}`. The first call is the
// expensive one and is logged in phases so a stall is attributable to a step.
function getSession(label, model, modelKey, backend, onLog, reason = '') {
  const key = `${modelKey}:${backend}`
  if (!sessions.has(key)) {
    sessions.set(key, (async () => {
      onLog?.(`${label}: first run — backend ${backend}`
        + `${reason ? ` (CPU; ${reason})` : ''}; fetching model…`)
      const bytes = await loadModelBytes(model, onLog, label)
      const t = performance.now()
      const session = await createSession(bytes, {}, onLog, backend)
      onLog?.(`${label}: runtime ready in ${Math.round(performance.now() - t)} ms `
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
// apart by element count relative to N (desc = N·D, score = N), so a run that
// happens to find exactly D keypoints can't misassign the [1,D,2] / [1,D]
// tensors to the descriptor slot.
export function classifyOutputs(results, outputNames, dim) {
  const tensors = outputNames.map((name) => results[name]).filter(Boolean)
  const kp = tensors.find((t) => t.dims[t.dims.length - 1] === 2) || null
  if (!kp) return { kp: null, desc: null, score: null }
  const n = kp.dims[kp.dims.length - 2]
  const count = (t) => t.dims.reduce((a, b) => a * b, 1)
  const rest = tensors.filter((t) => t !== kp)
  const desc = rest.find((t) => t.dims.includes(dim) && count(t) === n * dim) || null
  const score = rest.find((t) => t !== desc && count(t) === n) || null
  return { kp, desc, score }
}

/**
 * Run a learned detector on one image.
 *
 * @param {{label:string, modelId:string, descDim:number, channels:number}} spec
 *   a core/features/learnedDetectors.js entry
 * @param {Float32Array} pixels  planar CHW, spec.channels × h × w, normalised [0,1]
 * @param {number} w
 * @param {number} h
 * @param {object} [opts]
 * @param {number} [opts.maxKeypoints=5000]  keep top-K by score (0 = all)
 * @param {ArrayBuffer|Uint8Array|string} [opts.model]  onnx source (default: the registry URL)
 * @param {string} [opts.modelKey=spec.modelId]  session-cache key
 * @returns {Promise<{keypoints:{x:number,y:number,score:number}[], descriptors:Float32Array, dim:number}>}
 */
export async function detectLearned(spec, pixels, w, h, opts = {}) {
  const { label, descDim: dim, channels } = spec
  const {
    maxKeypoints = 5000, model = modelUrl(spec.modelId), modelKey = spec.modelId, onLog,
  } = opts
  let { backend, reason } = await chooseBackend(modelKey, w * h)
  let session = await getSession(label, model, modelKey, backend, onLog, reason)

  // Tensor data is consumed by run(); build fresh copies so the WASM re-run after
  // a WebGPU failure isn't handed an already-consumed buffer.
  const makeInput = () => tensor('float32', pixels.slice(), [1, channels, h, w])
  // On WebGPU the first run() compiles the graph's shaders — often the real
  // first-image cost (not createSession). Time it once so a stall here is visible.
  const first = !warmedUp.has(modelKey)
  if (first) onLog?.(`${label}: first inference on ${w}×${h} on ${backend}`
    + `${backend === 'webgpu' ? ' (compiling GPU shaders — one-time)' : ''}…`)
  const tRun = performance.now()
  let results
  try {
    results = await session.run({ [session.inputNames[0]]: await makeInput() })
  } catch (err) {
    // A size overflow is a hard int32 ceiling, not a GPU-memory issue — falling back
    // to WASM would overflow identically, so rethrow a clear "enable tiling" message
    // (on either backend) instead of the raw SafeIntOnOverflow.
    if (isSizeOverflow(err)) throw sizeOverflowError(label, w, h)
    if (backend !== 'webgpu') throw err
    // GPU path failed (OOM/std::bad_alloc at this resolution, unsupported op,
    // device lost). Record the failure SIZE for this model — smaller inputs
    // (e.g. tiles) may still fit — drop the bad session, and re-run this image
    // on CPU WASM: same graph, same outputs, just slower.
    onLog?.(`${label}: WebGPU path failed at ${w}×${h} (${err?.message || err}) — `
      + 'falling back to CPU WASM for inputs this size or larger')
    const npix = w * h
    const prev = gpuFailedAtPx.get(modelKey)
    gpuFailedAtPx.set(modelKey, prev === undefined ? npix : Math.min(prev, npix))
    sessions.delete(`${modelKey}:webgpu`)
    backend = 'wasm'
    session = await getSession(label, model, modelKey, 'wasm', onLog)
    try {
      results = await session.run({ [session.inputNames[0]]: await makeInput() })
    } catch (err2) {
      if (isSizeOverflow(err2)) throw sizeOverflowError(label, w, h)
      throw err2
    }
  }
  if (first) {
    warmedUp.add(modelKey)
    onLog?.(`${label}: first inference done in ${Math.round(performance.now() - tRun)} ms on ${backend}; subsequent images reuse the compiled graph`)
  }
  return parseDetections(results, session.outputNames, spec, maxKeypoints)
}

/**
 * Turn a detector's raw outputs into best-first keypoints + row-major descriptors,
 * capped at `maxKeypoints` by score. Pure; exported for tests.
 */
export function parseDetections(results, outputNames, spec, maxKeypoints) {
  const dim = spec.descDim
  const { kp, desc, score } = classifyOutputs(results, outputNames, dim)
  if (!kp || !desc) {
    throw new Error(
      `${spec.label}: could not locate keypoint/descriptor (${dim}-d) outputs among [${outputNames.join(', ')}]`,
    )
  }

  const n = kp.dims[kp.dims.length - 2] // [...,N,2]
  // Descriptor layout: find the non-D (=N) axis to know orientation.
  const dDims = desc.dims
  const descAxis = dDims.lastIndexOf(dim)
  const channelsFirst = descAxis === dDims.length - 2 // [...,D,N]
  const dData = desc.data
  const readDesc = channelsFirst
    ? (i, d) => dData[d * n + i] // [D,N]: row d, col i
    : (i, d) => dData[i * dim + d] // [N,D]: row i

  const kData = kp.data
  const sData = score ? score.data : null

  // Order by score (desc) so an optional cap keeps the strongest, and the sparse
  // cloud / LightGlue see features best-first (SIFT is response-sorted too).
  const order = Array.from({ length: n }, (_, i) => i)
  if (sData) order.sort((a, b) => num(sData, b) - num(sData, a))
  const kept = maxKeypoints > 0 ? Math.min(n, maxKeypoints) : n

  const keypoints = new Array(kept)
  const descriptors = new Float32Array(kept * dim)
  for (let k = 0; k < kept; k++) {
    const i = order[k]
    keypoints[k] = {
      x: num(kData, i * 2),
      y: num(kData, i * 2 + 1),
      score: sData ? num(sData, i) : 1,
    }
    const base = k * dim
    for (let d = 0; d < dim; d++) descriptors[base + d] = readDesc(i, d)
  }

  return { keypoints, descriptors, dim }
}

/**
 * Planar network input from an RGBA raster: 1 channel = Rec. 601 luma (matching
 * core/sfm/geometry.js rgbaToGray), 3 = R,G,B planes; all /255.
 */
export function rgbaToPlanar(data, width, height, channels) {
  const n = width * height
  const out = new Float32Array(n * channels)
  if (channels === 1) {
    for (let i = 0; i < n; i++) {
      const o = i * 4
      out[i] = (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114) / 255
    }
  } else {
    for (let i = 0; i < n; i++) {
      const o = i * 4
      out[i] = data[o] / 255
      out[n + i] = data[o + 1] / 255
      out[2 * n + i] = data[o + 2] / 255
    }
  }
  return out
}

