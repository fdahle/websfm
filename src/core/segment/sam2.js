// Segment-Anything-2 wrapper (F12) — click-to-segment "smart mask selection".
// Pure worker-side module, same lazy/cached/serialized session pattern as
// core/features/lightglue.js and superpoint.js (all three go through
// core/features/ort.js). Plain data in, plain data out; the worker op
// (workers/ops/segment.js) owns the per-uuid embedding cache and the transfer.
//
// SAM2 splits into two ONNX graphs:
//   ENCODER (heavy, ~35–40 MB hiera-tiny): run ONCE per image →
//     in : image [1,3,S,S] float, S=1024, ImageNet-normalized, CHW.
//     out: image_embeddings [1,256,64,64] + high_res_feats_0 [1,32,256,256]
//          + high_res_feats_1 [1,64,128,128].  ← cached per image uuid.
//   DECODER (light, ~5–16 MB): run per click (~10–50 ms):
//     in : the three encoder outputs (mapped BY NAME), point_coords [1,N,2]
//          in model (S-space) pixels, point_labels [1,N] (1=positive/include,
//          0=negative/exclude, per SAM convention), mask_input [1,1,256,256] +
//          has_mask_input [1] (0 ⇒ no prior mask), optional orig_im_size [2].
//     out: masks [1,M,256,256] low-res logits + iou_predictions [1,M].
//
// Contract robustness (mirrors superpoint.js's shape-based output classification):
// exact tensor NAMES vary between SAM2 exports, so decoder inputs are matched by
// name *fragment* (coord/label/mask_input/has_mask/orig_im_size) against the
// session's real inputNames, the encoder→decoder feature handoff is name-keyed
// (both graphs call them image_embeddings/high_res_feats_0/1), and decoder outputs
// are classified by SHAPE (masks = the 4-D tensor, iou = the small 1-D/2-D one).
// This is the #1 thing to validate against your specific export — see TODO.md F12
// "de-risk first". The pure preprocessing/decoding math below is unit-tested;
// only the ORT glue needs a browser.

import { createSession, tensor, resolveBackend } from '../features/ort.js'

export const SAM2_INPUT_SIZE = 1024
// ImageNet normalization — SAM2's SAM2Transforms resizes the image straight to
// S×S (NO aspect-preserving letterbox/pad) then applies these; point coords are
// therefore scaled per-axis (see pointsToModelSpace).
const IMAGENET_MEAN = [0.485, 0.456, 0.406]
const IMAGENET_STD = [0.229, 0.224, 0.225]

// ── Pure (DOM-free, unit-tested) ───────────────────────────────────────────────

// Bilinear sample of one channel `c` of an RGBA buffer at fractional (fx,fy).
function sampleChannel(rgba, w, h, fx, fy, c) {
  const x0 = Math.min(w - 1, Math.max(0, Math.floor(fx)))
  const y0 = Math.min(h - 1, Math.max(0, Math.floor(fy)))
  const x1 = Math.min(w - 1, x0 + 1)
  const y1 = Math.min(h - 1, y0 + 1)
  const dx = fx - x0, dy = fy - y0
  const p = (x, y) => rgba[(y * w + x) * 4 + c]
  const top = p(x0, y0) * (1 - dx) + p(x1, y0) * dx
  const bot = p(x0, y1) * (1 - dx) + p(x1, y1) * dx
  return top * (1 - dy) + bot * dy
}

/**
 * RGBA image (w×h) → the encoder's `image` input: an S×S, ImageNet-normalized,
 * CHW Float32Array (length 3·S·S). Straight resize (no pad), matching SAM2's
 * SAM2Transforms; the per-axis scale is undone in pointsToModelSpace.
 */
export function imageToInputTensor(rgba, w, h, size = SAM2_INPUT_SIZE) {
  const out = new Float32Array(3 * size * size)
  const sx = w / size, sy = h / size
  const plane = size * size
  for (let y = 0; y < size; y++) {
    // Sample at pixel centres so a 1:1 resize is identity.
    const fy = (y + 0.5) * sy - 0.5
    for (let x = 0; x < size; x++) {
      const fx = (x + 0.5) * sx - 0.5
      const o = y * size + x
      for (let c = 0; c < 3; c++) {
        const v = sampleChannel(rgba, w, h, fx, fy, c) / 255
        out[c * plane + o] = (v - IMAGENET_MEAN[c]) / IMAGENET_STD[c]
      }
    }
  }
  return out
}

/**
 * Prompt points in ORIGINAL image pixels → decoder inputs in model (S-space)
 * pixels. `points` = [{ x, y, positive }]; label 1 = include, 0 = exclude.
 * Returns flat Float32Arrays sized [N·2] (coords) and [N] (labels).
 */
export function pointsToModelSpace(points, w, h, size = SAM2_INPUT_SIZE) {
  const n = points.length
  const coords = new Float32Array(n * 2)
  const labels = new Float32Array(n)
  const sx = size / w, sy = size / h
  for (let i = 0; i < n; i++) {
    coords[i * 2] = points[i].x * sx
    coords[i * 2 + 1] = points[i].y * sy
    labels[i] = points[i].positive === false ? 0 : 1
  }
  return { coords, labels }
}

/** Index of the highest-IoU mask among `count` candidates (0 if no scores). */
export function bestMaskIndex(iou, count) {
  if (!iou || !count) return 0
  let best = 0, bestV = -Infinity
  for (let i = 0; i < count; i++) {
    const v = typeof iou[i] === 'bigint' ? Number(iou[i]) : iou[i]
    if (v > bestV) { bestV = v; best = i }
  }
  return best
}

/**
 * One mask's low-res logits (mw×mh) → a binary 0/1 Uint8Array(w·h) at the
 * original image resolution: bilinear-upsample the logits, threshold at
 * `threshold` (SAM's mask logits cross 0 at the boundary). 1 = inside segment.
 */
export function logitsToBinaryMask(logits, mw, mh, w, h, threshold = 0) {
  const out = new Uint8Array(w * h)
  const sx = mw / w, sy = mh / h
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) * sy - 0.5
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) * sx - 0.5
      // Bilinear over the single-channel logit map.
      const x0 = Math.min(mw - 1, Math.max(0, Math.floor(fx)))
      const y0 = Math.min(mh - 1, Math.max(0, Math.floor(fy)))
      const x1 = Math.min(mw - 1, x0 + 1)
      const y1 = Math.min(mh - 1, y0 + 1)
      const dx = fx - x0, dy = fy - y0
      const v = (logits[y0 * mw + x0] * (1 - dx) + logits[y0 * mw + x1] * dx) * (1 - dy)
        + (logits[y1 * mw + x0] * (1 - dx) + logits[y1 * mw + x1] * dx) * dy
      out[y * w + x] = v > threshold ? 1 : 0
    }
  }
  return out
}

// ── ORT glue (browser-only; validate the export before trusting names) ─────────

function defaultEncoderUrl() {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/'
  return `${base}models/sam2_encoder.onnx`
}
function defaultDecoderUrl() {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/'
  return `${base}models/sam2_decoder.onnx`
}

// One cached session per `${role}:${backend}` (role = encoder | decoder). Like
// LightGlue, a role can hold both a WebGPU and a WASM session if we fall back.
const sessions = new Map()

// ORT InferenceSessions are NOT reentrant (see the LightGlue note): serialize
// every encode/decode through a single promise chain so concurrent clicks queue
// rather than interleave on one wasm session. The chain advances on both fulfil
// and reject so one failed run can't wedge the queue.
let runChain = Promise.resolve()
export function serialized(fn) {
  const p = runChain.then(fn, fn)
  runChain = p.then(() => {}, () => {})
  return p
}

async function loadModelBytes(model, onLog, label) {
  if (typeof model !== 'string') return model
  const t = performance.now()
  const resp = await fetch(model)
  if (!resp.ok) throw new Error(`SAM2 ${label} fetch failed: HTTP ${resp.status} for ${model}`)
  const buf = await resp.arrayBuffer()
  onLog?.(`SAM2: ${label} downloaded (${(buf.byteLength / 1e6).toFixed(1)} MB) in `
    + `${Math.round(performance.now() - t)} ms`)
  return buf
}

function getSession(role, model, backend, onLog, sessionOpts = {}) {
  // Cache key includes the optimization level so a de-risk retry with a different
  // level builds a fresh session rather than returning the failed/cached one.
  const key = `${role}:${backend}:${sessionOpts.graphOptimizationLevel || 'all'}`
  if (!sessions.has(key)) {
    sessions.set(key, (async () => {
      onLog?.(`SAM2: first use — ${role} on backend ${backend}`
        + `${sessionOpts.graphOptimizationLevel ? ` (opt=${sessionOpts.graphOptimizationLevel})` : ''}; fetching model…`)
      const bytes = await loadModelBytes(model, onLog, role)
      const session = await createSession(bytes, sessionOpts, onLog, backend)
      onLog?.(`SAM2: ${role} ready (backend ${backend}; inputs [${session.inputNames}] → outputs [${session.outputNames}])`)
      return session
    })())
  }
  return sessions.get(key)
}

// Name-fragment resolver over a session's real input names (case-insensitive).
// Exported for the contract test (decoder input names vary between exports).
export function findInput(names, ...fragments) {
  const lower = names.map((n) => n.toLowerCase())
  for (const frag of fragments) {
    const i = lower.findIndex((n) => n.includes(frag))
    if (i >= 0) return names[i]
  }
  return null
}

/**
 * Run the encoder on one RGBA image. Returns the raw ORT output tensors keyed by
 * their output name (image_embeddings / high_res_feats_0 / high_res_feats_1) so
 * the caller (worker op) can cache them per uuid and feed them straight back into
 * decode(). `w`,`h` are the original image dims, echoed back for decode's resize.
 */
export async function encode(rgba, w, h, opts = {}) {
  const { encoderModel = defaultEncoderUrl(), backend: backendOverride, sessionOpts, onLog } = opts
  const backend = backendOverride || await resolveBackend()
  const session = await getSession('encoder', encoderModel, backend, onLog, sessionOpts)
  const input = await tensor('float32', imageToInputTensor(rgba, w, h), [1, 3, SAM2_INPUT_SIZE, SAM2_INPUT_SIZE])
  const t = performance.now()
  const results = await serialized(() => session.run({ [session.inputNames[0]]: input }))
  const ms = Math.round(performance.now() - t)
  onLog?.(`SAM2: encoded ${w}×${h} in ${ms} ms (backend ${backend})`)
  // Keep only the named embedding tensors (drop anything else the export emits).
  const embeddings = {}
  for (const name of session.outputNames) embeddings[name] = results[name]
  return { embeddings, w, h, ms }
}

/**
 * Run the decoder for one set of prompt points against cached encoder embeddings.
 * `points` = [{ x, y, positive }] in ORIGINAL image pixels. Returns a binary
 * Uint8Array(w·h) (1 = inside the segmented region) + the chosen IoU.
 */
export async function decode(embeddings, points, w, h, opts = {}) {
  const { decoderModel = defaultDecoderUrl(), backend: backendOverride, sessionOpts, onLog } = opts
  // Decoder defaults to CPU WASM, NOT resolveBackend(): ORT's WebGPU EP crashes
  // when the decoder is re-run with a changing point count (the per-click case) —
  // `getBindGroupLayout` of undefined / wasm OOB as its kernel-artifact cache
  // trips over the varying input_points shape. The decoder is tiny (~20 MB) and
  // runs per click, so CPU is fast enough and stable. Opt back into GPU with
  // { backend: 'webgpu' } once ORT fixes the EP. The heavy encoder stays on GPU.
  const backend = backendOverride || 'wasm'
  const session = await getSession('decoder', decoderModel, backend, onLog, sessionOpts)
  const names = session.inputNames

  const { coords, labels } = pointsToModelSpace(points, w, h)
  const n = points.length
  const feeds = {}
  // Encoder→decoder feature handoff, matched by shared name.
  for (const name of names) if (embeddings[name]) feeds[name] = embeddings[name]

  // Prompt-point inputs. Names differ between exports (Meta: point_coords/
  // point_labels; transformers.js onnx-community: input_points/input_labels), so
  // match on the widest set of fragments. `label` is claimed before the bare
  // `point`/`mask` fragments so input_labels can't be mistaken for input_points.
  const labelName = findInput(names, 'point_label', 'input_label', 'label')
  const coordName = findInput(names, 'point_coord', 'input_point', 'coord', 'point')
  // The has-mask flag must be resolved FIRST and excluded, because "input_masks"
  // is a substring of "has_input_masks" — otherwise the prior-mask tensor and its
  // presence flag collide.
  const hasMaskName = findInput(names, 'has_mask', 'has_input_mask', 'has_input', 'has_')
  const maskName = names.find((n) => /mask/i.test(n) && n !== hasMaskName) || null
  const origSizeName = findInput(names, 'orig_im_size', 'orig')
  if (!coordName || !labelName) {
    throw new Error(`SAM2 decoder: no point coord/label input among [${names.join(', ')}]`)
  }
  feeds[coordName] = await tensor('float32', coords, [1, n, 2])
  feeds[labelName] = await tensor('float32', labels, [1, n])
  // No prior mask: zeroed 256×256 + has_mask_input 0 (SAM's low-res mask size).
  if (maskName) feeds[maskName] = await tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256])
  if (hasMaskName) feeds[hasMaskName] = await tensor('float32', new Float32Array([0]), [1])
  if (origSizeName) feeds[origSizeName] = await tensor('float32', new Float32Array([h, w]), [2])

  const t = performance.now()
  const results = await serialized(() => session.run(feeds))
  const ms = Math.round(performance.now() - t)

  // Classify outputs by shape: masks = the 4-D tensor, iou = the small (≤2-D) one.
  const outs = session.outputNames.map((name) => results[name]).filter(Boolean)
  const maskT = outs.find((tt) => tt.dims.length === 4)
  const iouT = outs.find((tt) => tt !== maskT && tt.dims.length <= 2)
  if (!maskT) throw new Error(`SAM2 decoder: no mask output among [${session.outputNames.join(', ')}]`)

  const [, m, mh, mw] = maskT.dims // [1, M, H, W]
  const idx = bestMaskIndex(iouT?.data, m)
  const plane = mh * mw
  // Return the raw low-res logits (a transferable copy), NOT a pre-thresholded
  // mask: the caller upsamples them to whatever resolution it wants. Thresholding
  // here would bake in the low-res grid, so a native-resolution commit
  // (logitsToBinaryMask → native w,h) gets a far smoother boundary than
  // nearest-scaling a 256²→enc mask up to full image size.
  const logits = maskT.data.slice(idx * plane, (idx + 1) * plane) // Float32Array copy
  const iou = iouT ? (typeof iouT.data[idx] === 'bigint' ? Number(iouT.data[idx]) : iouT.data[idx]) : 1
  onLog?.(`SAM2: decoded ${n} point(s) → logits ${mw}×${mh}, IoU ${iou.toFixed(3)}, ${ms} ms`)
  return { logits, mw, mh, iou, ms }
}
