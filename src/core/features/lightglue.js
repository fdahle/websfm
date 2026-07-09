// LightGlue matcher wrapper — the learned joint matcher paired with SuperPoint.
// Replaces brute-force NN + Lowe ratio: it takes BOTH images' keypoints +
// descriptors and emits correspondences directly. Runs via core/features/ort.js (same
// lazy/cached session pattern as superpoint.js). Its output still flows through
// the store's verifyMatches (F-RANSAC) + inlierSpread gates unchanged.
//
// Model I/O (fabio-sim LightGlue-ONNX v1.0.0 `superpoint_lightglue_fused_cpu`,
// public/models/lightglue.onnx — 1.4k-node graph with fused MultiHeadAttention/
// LayerNormalization/Gelu; the old v0.1.0 export was 9.7k nodes of dynamic-shape
// bookkeeping that made ORT's WebGPU EP hang in warm-up. Outputs verified
// bit-identical between the two exports; keep the fused one):
//   in : kpts0,kpts1 [1,N,2] float — keypoints normalized to ~[-1,1] via
//        (kpt − [w/2,h/2]) / (max(w,h)/2). There is NO image-size input, so this
//        normalization MUST be applied here (fabio-sim convention) — the #1
//        correctness risk; a wrong scale/centre silently degrades matches.
//        desc0,desc1 [1,N,256] float — SuperPoint descriptors.
//   out: matches0 [M,2] int64 index pairs (i0,i1) + mscores0 [M] float conf.
//        The parser also still accepts the old per-kpt assignment format
//        ([1,N], index into image1, −1 = unmatched) so a custom model swap
//        keeps working. The first run logs the actual dims so it's auditable.

import { createSession, tensor, resolveBackend } from './ort.js'

// Sessions are cached per `${modelKey}:${backend}` — a modelKey can hold both a
// WebGPU and a WASM session if we fall back mid-run (see below).
const sessions = new Map()
const warmedUp = new Set()
// Once the WebGPU path is proven unusable for a modelKey (hang/error on the
// one-time warm-up) we pin CPU WASM for the rest of the session so we don't pay
// the failed-GPU cost on every pair.
const pinnedWasm = new Set()

// ORT InferenceSessions are NOT reentrant: two concurrent `session.run()` calls on
// one wasm session deadlock/corrupt (the 7-way freeze this module used to hit).
// LightGlue is pinned to worker 0 (one heavy session), so serialize every run
// through a promise chain — any caller, present or future, queues rather than
// interleaves. Defense in depth alongside the store's serial dispatch for the
// LightGlue matcher. `fn` is retried-agnostic: the chain advances on both fulfil
// and reject so one failed pair can't wedge the queue.
let runChain = Promise.resolve()
function serialized(fn) {
  const p = runChain.then(fn, fn)
  runChain = p.then(() => {}, () => {})
  return p
}

// LightGlue's transformer used to be hard-pinned to CPU: the old fabio-sim export
// (opset-lower, ~9.7k nodes dominated by dynamic-shape bookkeeping) thrashed on
// ORT's WebGPU EP. On ORT 1.27's much-improved JSEP it can run on the GPU, so the
// GPU path is now *attemptable* (opt-in via `useGpu`) with a self-healing CPU
// fallback: if the one-time warm-up hangs past this budget or throws, we drop the
// GPU session, pin WASM, and re-run on CPU. Nothing downstream changes — same
// graph, same outputs, still gated by verifyMatches (F-RANSAC).
const GPU_WARMUP_TIMEOUT_MS = 30000

function defaultModelUrl() {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/'
  return `${base}models/lightglue.onnx`
}

// Resolve which backend to *try* for this run. WASM if the GPU path was already
// disproven for this model, or if the caller didn't opt in, or if the machine has
// no usable WebGPU adapter (resolveBackend gates that to Chromium + adapter).
async function chooseBackend(modelKey, preferGpu) {
  if (pinnedWasm.has(modelKey)) return 'wasm'
  if (preferGpu && (await resolveBackend()) === 'webgpu') return 'webgpu'
  return 'wasm'
}

function getSession(model, modelKey, backend, onLog) {
  const key = `${modelKey}:${backend}`
  if (!sessions.has(key)) {
    sessions.set(key, (async () => {
      onLog?.(`LightGlue: first run — backend ${backend}`
        + `${backend === 'webgpu'
          ? ' (experimental GPU path; auto-falls back to CPU on failure)'
          : ' (CPU WASM)'}; loading model…`)
      const session = await createSession(model, {}, onLog, backend)
      onLog?.(`LightGlue: runtime ready (backend ${backend}; inputs [${session.inputNames}] → outputs [${session.outputNames}])`)
      return session
    })())
  }
  return sessions.get(key)
}

// Race a promise against a timeout so a hung WebGPU warm-up can't wedge the whole
// match run. The underlying run() can't actually be cancelled — on timeout we
// abandon it and switch to CPU — but that leak is one-time and only on failure.
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// int64 (BigInt64Array) / int32 → plain number.
function num(data, i) {
  const v = data[i]
  return typeof v === 'bigint' ? Number(v) : v
}

// LightGlue's expected keypoint normalization (see header). Centre on the image,
// scale by half the longer side → roughly [-1,1].
function normalizeKpts(kps, w, h) {
  const n = kps.length
  const out = new Float32Array(n * 2)
  const cx = w / 2, cy = h / 2, s = Math.max(w, h) / 2 || 1
  for (let i = 0; i < n; i++) {
    out[i * 2]     = (kps[i].x - cx) / s
    out[i * 2 + 1] = (kps[i].y - cy) / s
  }
  return out
}

// Parse an ONNX LightGlue output map into {ia,ib,score}[] (ia→image A, ib→image B).
function parseMatches(out, session, minConf) {
  // Locate matches0 + mscores0 by name (fall back to output order).
  const names = session.outputNames
  const mName = names.find((nm) => /matches0/i.test(nm)) || names[0]
  const sName = names.find((nm) => /(mscores0|scores0|matching_scores0)/i.test(nm))
  const mT = out[mName]
  const sT = sName ? out[sName] : null
  const mData = mT.data
  const sData = sT ? sT.data : null
  const dims = mT.dims

  const matches = []
  if (dims.length >= 2 && dims[dims.length - 1] === 2) {
    // [M,2] index-pair format: each row is (i0, i1).
    const M = mData.length / 2
    for (let k = 0; k < M; k++) {
      const score = sData ? num(sData, k) : 1
      if (score < minConf) continue
      matches.push({ ia: num(mData, k * 2), ib: num(mData, k * 2 + 1), score })
    }
  } else {
    // Per-keypoint assignment: mData[i] = index into image1, or −1 if unmatched.
    for (let i = 0; i < mData.length; i++) {
      const j = num(mData, i)
      if (j < 0) continue
      const score = sData ? num(sData, i) : 1
      if (score < minConf) continue
      matches.push({ ia: i, ib: j, score })
    }
  }
  return { matches, dims, sName }
}

// One session.run on already-prepared, already-normalized feed arrays → parsed
// matches. THROWS on run failure so the caller decides whether to fall back to
// another backend (it does NOT itself switch backends). `first` guards the WebGPU
// warm-up with a timeout + watchdog; on CPU WASM run() blocks the worker loop so
// no watchdog fires there (its per-pair cost is logged after the fact by callers).
//
// feedsSpec: { kptsA:Float32Array(nA·2), kptsB, descsA:Float32Array(nA·dim), descsB,
//              nA, nB, dim } — coords already normalized, descriptors already sliced.
async function runPair(session, backend, feedsSpec, { minConf = 0, first = false, onLog } = {}) {
  const { kptsA, kptsB, descsA, descsB, nA, nB, dim } = feedsSpec
  const feeds = {
    kpts0: await tensor('float32', kptsA, [1, nA, 2]),
    kpts1: await tensor('float32', kptsB, [1, nB, 2]),
    desc0: await tensor('float32', descsA, [1, nA, dim]),
    desc1: await tensor('float32', descsB, [1, nB, dim]),
  }
  const watchdog = (first && backend === 'webgpu') ? setInterval(() => {
    onLog?.(`LightGlue: still matching ${nA}×${nB} on ${backend}… if this drags for minutes, `
      + 'the GPU warm-up will time out and fall back to CPU')
  }, 15000) : null
  let out
  try {
    // Guard only the first WebGPU run with a timeout — that's where a bad JSEP
    // graph would hang; steady-state runs on a proven session run unguarded.
    out = (backend === 'webgpu' && first)
      ? await withTimeout(session.run(feeds), GPU_WARMUP_TIMEOUT_MS, 'LightGlue WebGPU warm-up')
      : await session.run(feeds)
  } finally {
    if (watchdog) clearInterval(watchdog)
  }
  return parseMatches(out, session, minConf)
}

// Resolve a session + backend for one serialized LightGlue invocation and return a
// `run(feedsSpec, { first })` bound to it that transparently self-heals a failed
// WebGPU run to CPU WASM (pins WASM for the rest of the session). Resolving the
// session once here lets a multi-tile run (matchLightGlueTiled) reuse it across
// coarse pass + every tile instead of re-choosing per call.
async function openRun(modelKey, model, useGpu, minConf, onLog) {
  let backend = await chooseBackend(modelKey, useGpu)
  let session = await getSession(model, modelKey, backend, onLog)
  const run = async (feedsSpec, { first = false } = {}) => {
    try {
      const r = await runPair(session, backend, feedsSpec, { minConf, first, onLog })
      return { ...r, backend }
    } catch (err) {
      if (backend !== 'webgpu') throw err
      // GPU path failed (hang→timeout, unsupported op, device lost). Disprove it
      // for this model, drop the bad session, and re-run this feed on CPU WASM.
      onLog?.(`LightGlue: WebGPU path failed (${err?.message || err}) — falling back to CPU WASM for the rest of this run`)
      pinnedWasm.add(modelKey)
      sessions.delete(`${modelKey}:webgpu`)
      backend = 'wasm'
      session = await getSession(model, modelKey, 'wasm', onLog)
      const r = await runPair(session, backend, feedsSpec, { minConf, first, onLog })
      return { ...r, backend }
    }
  }
  return { run, getBackend: () => backend }
}

// Build a feedsSpec for a prefix-capped image pair (the plain, non-tiled path).
// Prefix cap keeps the strongest (keypoints arrive score-sorted), and because
// it's a prefix the returned indices are valid in the caller's full arrays as-is.
function prefixFeeds(kpsA, descA, wA, hA, kpsB, descB, wB, hB, maxKeypoints) {
  const dim = kpsA.length ? descA.length / kpsA.length : 256
  const cap = maxKeypoints > 0 ? maxKeypoints : Infinity
  const nA = Math.min(kpsA.length, cap)
  const nB = Math.min(kpsB.length, cap)
  return {
    spec: {
      kptsA: normalizeKpts(kpsA.slice(0, nA), wA, hA),
      kptsB: normalizeKpts(kpsB.slice(0, nB), wB, hB),
      descsA: descA.subarray(0, nA * dim),
      descsB: descB.subarray(0, nB * dim),
      nA, nB, dim,
    },
    capped: nA < kpsA.length || nB < kpsB.length,
  }
}

/**
 * Match two images with LightGlue.
 *
 * @param {object} args
 * @param {{x:number,y:number}[]} args.kpsA  keypoints of image A (original px)
 * @param {Float32Array} args.descA          A's descriptors, N_a × dim row-major
 * @param {number} args.wA @param {number} args.hA  A's original image size (px)
 * @param {{x:number,y:number}[]} args.kpsB
 * @param {Float32Array} args.descB
 * @param {number} args.wB @param {number} args.hB
 * @param {number} [args.minConf=0]  drop matches below this LightGlue confidence
 * @param {number} [args.maxKeypoints=2048]  cap per image (0 = all). Attention is
 *        O(N²) so this is THE runtime lever; keypoints arrive score-sorted from
 *        detection, so taking the prefix keeps the strongest.
 * @param {boolean} [args.useGpu=false]  opt into the experimental WebGPU backend
 *        (Chromium + adapter only; self-heals to CPU WASM on failure)
 * @returns {Promise<{ matches: {ia:number,ib:number,score:number}[] }>}
 *          ia indexes kpsA, ib indexes kpsB (same convention as the brute-force path)
 */
export async function matchLightGlue(args) {
  const {
    kpsA, descA, wA, hA, kpsB, descB, wB, hB, minConf = 0, maxKeypoints = 2048,
    useGpu = false, model = defaultModelUrl(), modelKey = 'default', onLog,
  } = args
  const { spec, capped } = prefixFeeds(kpsA, descA, wA, hA, kpsB, descB, wB, hB, maxKeypoints)

  // Serialize: ORT sessions are not reentrant (see `serialized`). Everything from
  // session resolution through run() lives inside the mutex; only the feed arrays
  // (already built above) are prepared outside it.
  return serialized(async () => {
    const { run } = await openRun(modelKey, model, useGpu, minConf, onLog)
    // Mark warm-up STARTED (not finished): with serial dispatch pairs run one at a
    // time now, but flipping the flag before the first await also stops any future
    // re-entrant caller from each claiming to be "first".
    const first = !warmedUp.has(modelKey)
    if (first) {
      warmedUp.add(modelKey)
      onLog?.(`LightGlue: first match ${spec.nA}×${spec.nB} keypoints`
        + `${capped ? ` (capped from ${kpsA.length}×${kpsB.length}, strongest kept)` : ''}`
        + ' — one-time graph warm-up; single-thread wasm can take tens of seconds per pair…')
    }
    const tRun = performance.now()
    const { matches, dims, sName, backend } = await run(spec, { first })
    const ms = Math.round(performance.now() - tRun)
    if (first) {
      onLog?.(`LightGlue: first match ${spec.nA}×${spec.nB} kpts → ${matches.length} correspondences in `
        + `${ms} ms on ${backend} (matches0 dims [${dims}]${sName ? '' : ', no score output'})`)
    }
    // Per-pair timing at 'debug' for EVERY pair — a slow-but-alive run is then
    // distinguishable from a hang in the console.
    onLog?.(`LightGlue: ${spec.nA}×${spec.nB} kpts → ${matches.length} matches in ${ms} ms on ${backend}`, 'debug')
    return { matches }
  })
}
