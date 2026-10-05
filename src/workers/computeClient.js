// Typed client for the compute worker (compute.worker.js). Exposes drop-in
// async replacements for the old main-thread wasm wrappers — same signatures and
// return shapes — so the stores only had to swap their import. The heavy work now
// runs off the main thread, keeping the UI responsive during detect/match runs.
//
// A worker pool is provisioned (round-robin dispatch). `matchAll` now dispatches
// up to POOL_SIZE pairs concurrently (the match store is concurrency-safe — it
// mutates in place + triggerRefs rather than swapping the whole Map). The big
// single-call ops (reconstruct/dense/products) still use one worker at a time.

// One worker per core (minus one for the UI thread), capped so we don't spawn a
// pile of workers that each load their own wasm copy on first use.
export const MAX_POOL_SIZE = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))
const storedPoolSize = typeof localStorage === 'undefined'
  ? 0
  : Number(localStorage.getItem('websfm.compute.workerCount'))
export let POOL_SIZE = storedPoolSize > 0
  ? Math.max(1, Math.min(MAX_POOL_SIZE, Math.round(storedPoolSize)))
  : MAX_POOL_SIZE

let workers = null
let rr = 0
let nextId = 1
const pending = new Map()

function handleMessage(e) {
  const { id, ok, result, error, ev, args } = e.data
  const entry = pending.get(id)
  if (!entry) return
  // Intermediate streaming event (e.g. reconstruct log/progress) — not terminal.
  if (ev) { entry.onEvent?.(ev, args); return }
  pending.delete(id)
  entry.onTiming?.({ postMessageMs: entry.postMessageMs,
    workerMs: e.data.workerMs ?? 0, roundTripMs: performance.now() - entry.started })
  if (ok) entry.resolve(result)
  else entry.reject(new Error(error))
}

function spawn(index) {
  const w = new Worker(new URL('./compute.worker.js', import.meta.url), {
    type: 'module',
    name: 'compute',
  })
  w.onmessage = handleMessage
  w.onerror = (e) => {
    // A worker-level error has no request id. Pending entries retain their worker,
    // so only jobs on this failed slot are rejected; healthy slots keep running.
    const err = new Error(e.message || 'compute worker error')
    for (const [id, entry] of pending) {
      if (entry.worker !== w) continue
      pending.delete(id)
      entry.reject(err)
    }
    if (workers?.[index] === w) {
      w.terminate()
      workers[index] = spawn(index)
    }
  }
  return w
}

function getPool() {
  if (!workers) workers = Array.from({ length: POOL_SIZE }, (_, index) => spawn(index))
  return workers
}

// Hard-cancel: terminate every worker and reject all in-flight requests. The
// pool respawns lazily on the next call. Used to abort a running op (e.g. a long
// reconstruct) that can't be interrupted cooperatively mid-call.
export function terminateAll(reason = 'cancelled') {
  const oldWorkers = workers
  workers = null
  if (oldWorkers) for (const w of oldWorkers) w.terminate()
  for (const [id, entry] of pending) { pending.delete(id); entry.reject(new Error(reason)) }
}

// Reconfigure only while idle: killing a pool with active jobs would turn a
// harmless preference change into a cancelled reconstruction. Returns false
// when a run is active; the persisted choice still takes effect after reload.
export function configureWorkerPoolSize(value) {
  const requested = Number(value)
  const next = requested > 0
    ? Math.max(1, Math.min(MAX_POOL_SIZE, Math.round(requested)))
    : MAX_POOL_SIZE
  if (next === POOL_SIZE) return true
  if (pending.size) return false
  const oldWorkers = workers
  workers = null
  if (oldWorkers) for (const worker of oldWorkers) worker.terminate()
  rr = 0
  POOL_SIZE = next
  return true
}

function call(op, args, { transfer = [], onEvent, onTiming, worker: pinned, avoid } = {}) {
  const pool = getPool()
  // `pinned` forces a specific worker (learned backends load a heavy per-worker
  // runtime once — see detectKeypoints); otherwise round-robin across the pool,
  // skipping `avoid` (a worker busy with pinned work, e.g. GPU matching) when there
  // is any other worker to use.
  let slot
  if (pinned != null) slot = pinned % pool.length
  else {
    slot = rr++ % pool.length
    if (avoid != null && pool.length > 1 && slot === avoid % pool.length) slot = rr++ % pool.length
  }
  const worker = pool[slot]
  const id = nextId++
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, onEvent, onTiming, worker, started: performance.now(), postMessageMs: 0 }
    pending.set(id, entry)
    try {
      worker.postMessage({ id, op, args }, transfer)
      entry.postMessageMs = performance.now() - entry.started
    } catch (err) {
      pending.delete(id)
      reject(err)
    }
  })
}

// ── Drop-in compute API (mirrors core/features/sift.js + core/features/{bruteforce,verify}.js) ─────────

export function detectKeypoints(url, options = {}, { onLog } = {}) {
  // SuperPoint/ONNX loads a heavy runtime (~26 MB wasm + model + a WebGPU device)
  // per worker on first use. Round-robining it across the pool makes the first
  // POOL_SIZE images each initialize independently — in parallel, contending for
  // the GPU — which stalls hard. Pin it to one worker so that happens exactly
  // once; SIFT (tiny wasm) stays round-robin. Streams init/backend log lines.
  const learned = options.detector === 'superpoint'
  return call('detect', [url, options], {
    worker: learned ? 0 : undefined,
    onEvent: onLog ? (ev, a) => { if (ev === 'log') onLog(...a) } : undefined,
  })
}

// Cut ZNCC templates out of the reference film scan (F4 auto-measurement). Once
// per run; round-robin is fine (no heavy per-worker runtime to warm up).
export function prepareFiducialTemplates(url, obs, options = {}, { onLog } = {}) {
  return call('prepareFiducialTemplates', [url, obs, options], {
    onEvent: onLog ? (ev, a) => { if (ev === 'log') onLog(...a) } : undefined,
  })
}

// Match those templates in one target scan. `templates` are structured-cloned
// into every call by design — do NOT add their buffers to a transfer list here,
// they are reused across all images of the sensor and transferring would detach
// them after the first.
export function detectFiducials(url, templates, predictions, options = {}, { onLog } = {}) {
  return call('detectFiducials', [url, templates, predictions, options], {
    onEvent: onLog ? (ev, a) => { if (ev === 'log') onLog(...a) } : undefined,
  })
}

export function detectFiducialSpots(url, options = {}, { onLog } = {}) {
  // Modal settings are commonly a Vue reactive Proxy. Proxies are not supported
  // by the browser's structured-clone algorithm, so materialize the small,
  // primitive-only options bag before it crosses postMessage.
  return call('detectFiducialSpots', [url, { ...options }], {
    onEvent: onLog ? (ev, a) => { if (ev === 'log') onLog(...a) } : undefined,
  })
}

export function matchDescriptors(descA, descB, options = {}, { onTiming, avoidWorker } = {}) {
  // No transfer: structured-clone copies the descriptors so the caller's
  // in-memory buffers (reused across pairs) are not detached.
  return call('match', [descA, descB, options], { onTiming, avoid: avoidWorker })
}

// WebGPU brute-force matching (workers/gpu/matchGpu.js). All three ops pin ONE
// worker: WebGPU gives every worker its own device, and the per-run descriptor
// cache lives in that device's memory — round-robin would hold POOL_SIZE copies of
// it (~0.5 GB each on a 128-image run). Other work passes `avoidWorker` to keep off
// this slot while a GPU run is active. No transfer: descriptors are cloned so the
// caller's per-run cache stays usable for a resend or a WASM fallback.
export const GPU_MATCH_WORKER = 0
export const matchGpuBegin = (opts) => call('matchGpuBegin', [opts], { worker: GPU_MATCH_WORKER })
export const matchGpuEnd = (opts) => call('matchGpuEnd', [opts], { worker: GPU_MATCH_WORKER })
export function matchDescriptorsGpu(args, { onTiming } = {}) {
  return call('matchGpu', [args], { worker: GPU_MATCH_WORKER, onTiming })
}

// LightGlue joint match. Pinned to worker 0 for the same reason SuperPoint is —
// one heavy ORT session, loaded once — so concurrent pairs serialize on it rather
// than each booting their own runtime. Streams first-run init log lines.
export function matchLightGlue(args, { onLog, onTiming } = {}) {
  return call('matchLightGlue', [args], {
    onTiming,
    worker: 0,
    onEvent: onLog ? (ev, a) => { if (ev === 'log') onLog(...a) } : undefined,
  })
}

export function verifyMatches(kpsA, kpsB, matches, options = {}, { onTiming, avoidWorker } = {}) {
  return call('verify', [kpsA, kpsB, matches, options], { onTiming, avoid: avoidWorker })
}

// Packed verification (core/features/verify.js `packMatchedPoints`): the two
// coordinate buffers are TRANSFERRED — they are built per call and never reused.
export function verifyPointPairs(ptsA, ptsB, options = {}, { onTiming, avoidWorker } = {}) {
  return call('verifyPoints', [ptsA, ptsB, options], {
    onTiming, avoid: avoidWorker, transfer: [ptsA.buffer, ptsB.buffer],
  })
}

export const sparseMetrics = (packed) => call('sparseMetrics', [packed])
export const refineSparse = (packed, settings, constraints = {}) => call('refineSparse', [packed, settings, constraints])
export const readRasterWindow = (file, options = {}) => call('readRasterWindow', [{ file, ...options }])
export const findReferenceMatches = (url, reference) => call('findReferenceMatches', [url, reference])

// SAM2 smart-mask selection (F12). All three ops pin worker 0 so the heavy ORT
// encoder/decoder sessions load once AND the per-uuid embedding cache (held in
// workers/ops/segment.js module scope) is on the worker every call reaches.
//
// segmentEncode: run the image encoder once, cache embeddings under `uuid`.
// Streams first-run init/log lines. Resolves to { uuid, width, height, ms }.
export function segmentEncode(uuid, url, options = {}, { onLog } = {}) {
  return call('segmentEncode', [uuid, url, options], {
    worker: 0,
    onEvent: onLog ? (ev, a) => { if (ev === 'log') onLog(...a) } : undefined,
  })
}

// segmentDecode: run the decoder for `points` ([{ x, y, positive }] in the
// encoded raster's pixel space) against the cached embedding. Resolves to
// { uuid, width, height, mask: Uint8Array(w·h), iou, ms }.
export function segmentDecode(uuid, points, options = {}, { onLog } = {}) {
  return call('segmentDecode', [uuid, points, options], {
    worker: 0,
    onEvent: onLog ? (ev, a) => { if (ev === 'log') onLog(...a) } : undefined,
  })
}

// segmentForget: drop cached embeddings (one uuid, or all when uuid is null).
export function segmentForget(uuid = null) {
  return call('segmentForget', [uuid], { worker: 0 })
}

// TIFF decode + re-encode (geotiff, ~seconds for a large raster) — dispatched
// round-robin like detect/match so a batch of TIFFs transcodes in parallel
// across the pool instead of blocking the main thread one file at a time.
// `onThumbnail(blob, width, height)` fires once decode finishes, well before
// the full-res result resolves, so callers can show a preview early.
export function transcodeTiff(blob, jpegQuality, { onThumbnail, onDisplay } = {}) {
  return call('transcodeTiff', [blob, jpegQuality], {
    onEvent: (onThumbnail || onDisplay)
      ? (ev, a) => {
          if (ev === 'thumbnail') onThumbnail?.(...a)
          else if (ev === 'display') onDisplay?.(...a)
        }
      : undefined,
  })
}

// The three long-running ops share one streaming shape: intermediate `log` /
// `progress` events during the run, a final result on resolve. This factory wires
// the { onLog, onProgress } hooks to the worker's event stream.
function streamingOp(op) {
  return (input, { onLog, onProgress, transfer = [] } = {}) =>
    call(op, [input], {
      transfer,
      onEvent: (ev, args) => {
        if (ev === 'log') onLog?.(...args)
        else if (ev === 'progress') onProgress?.(...args)
      },
    })
}

// Incremental SfM (see core/sfm/sfm.js). `onLog`/`onProgress` fire during the run;
// resolves to a compact transferable result; the reconstruction store expands it
// with resultCodec after ownership of the buffers reaches the main thread.
export const reconstruct = streamingOp('reconstruct')

// Dense Stage A — Build Depth Maps (PatchMatch MVS, see core/dense/mvs.js). Resolves to
// { maps: [{ uuid, width, height, K, R, t, depth, cost, rgb, displayDataUrl }] }.
export const computeDepthMaps = streamingOp('computeDepthMaps')

// Dense Stage B — fuse the Stage A depth maps into a coloured point cloud.
// Resolves to { points: Float32Array } packed as [x,y,z,r,g,b] per point.
export const densify = streamingOp('densify')

// Products — DEM (rasterise a height grid in the chosen frame). Resolves to the
// grid { width, height, gsd, originX, originY, data, mask, zMin, zMax, frame,
// crs, unit, previewDataUrl }. See core/products/dem.js.
export const generateDem = streamingOp('generateDem')

// Products — orthophoto (reproject each DEM cell into the cached depth maps).
// Resolves to { width, height, rgba:Uint8Array, covered, previewDataUrl }.
// See core/products/ortho.js.
export const generateOrtho = streamingOp('generateOrtho')

// Products — mesh (screened Poisson over the dense cloud, see core/products/mesh.js).
// Input { dense:{ count, pos, col, nrm }, settings }; resolves to
// { mesh:{ nVerts, count, pos, idx, col }, denseHome:{ pos, col, nrm } }.
export const meshify = streamingOp('meshify')

// Cloud editing — crop / filter / merge over flat (dense) clouds. See
// core/products/cloudEdit.js. Input { mode, clouds:[{ id, count, pos, col, nrm }],
// settings }; the source buffers are TRANSFERRED in and round-tripped back under
// `home[]` (keyed by cloud id) so the store can re-attach them. Resolves to
// { cloud:{ count, pos, col?, nrm? }, home }.
export const editCloud = streamingOp('editCloud')

// Import — parse a point-cloud / mesh file (PLY / LAS / XYZ text) off the main
// thread. The buffer is transferred in (detached for the caller); resolves to
// { parsed, stats } with the flat cloud buffers transferred back.
export function parseCloudFile(buffer, name, { onLog } = {}) {
  return call('parseCloud', [{ buffer, name }], {
    transfer: [buffer],
    onEvent: onLog ? (ev, a) => { if (ev === 'log') onLog(...a) } : undefined,
  })
}

// Decode + classify a georeferenced raster (reference DEM / orthophoto) off the
// main thread — a 200 MB REMA tile decoded on the UI thread is the same trap
// parseCloudFile exists to avoid. `forceKind` ('dem'|'ortho') skips the sniff.
// Resolves to { meta, plane }; `plane` is transferred both ways (no clone).
export function parseRasterFile(buffer, name, { forceKind = null, style = null, previewOnly = false, onLog } = {}) {
  return call('parseRaster', [{ ...(buffer instanceof Blob ? { file: buffer } : { buffer }), name, forceKind, style, previewOnly }], {
    transfer: buffer instanceof Blob ? [] : [buffer],
    onEvent: onLog ? (ev, a) => { if (ev === 'log') onLog(...a) } : undefined,
  })
}

// Recompute only a styled raster's ≤1024 px preview PNG for a new style — no
// full-resolution plane, no OPFS write. Milliseconds where parseRasterFile is
// seconds, which is what lets a restyle repaint immediately; the full plane is
// re-decoded lazily on the next sample. Resolves to { style, previewDataUrl }.
export function restyleRasterPreview(source, name, style, { onLog, cacheKey, rangesOnly = false } = {}) {
  const isFile = source instanceof Blob
  return call('restyleRasterPreview', [{ ...(isFile ? { file: source } : { buffer: source }), name, style, cacheKey, rangesOnly }], {
    worker: POOL_SIZE - 1,
    transfer: isFile ? [] : [source],
    onEvent: onLog ? (ev, a) => { if (ev === 'log') onLog(...a) } : undefined,
  })
}

// Undistorted-image export — resample one image into the pinhole frame the sparse
// model lives in, off the main thread. One image per call so peak memory is one
// image, not the batch (a 100 MP scan is ~400 MB as RGBA). Resolves to
// { bytes, width, height, K, rect, mime }; `bytes` is transferred back.
export function undistortImage(args, { onLog } = {}) {
  return call('undistortImage', [args], {
    onEvent: onLog ? (ev, a) => { if (ev === 'log') onLog(...a) } : undefined,
  })
}

// LAZ export — LASzip compression off the main thread (a 30 M-point cloud is
// ~780 MB of point records). The cloud buffers are transferred in and round-
// tripped home under `home`, so the caller's cloud is never left detached.
export function exportLazCloud(cloud, { crsCode = null, geographic = false, onLog } = {}) {
  const transfer = [cloud.pos.buffer]
  if (cloud.col) transfer.push(cloud.col.buffer)
  return call('exportLaz', [{ cloud, crsCode, geographic }], {
    transfer,
    onEvent: onLog ? (ev, a) => { if (ev === 'log') onLog(...a) } : undefined,
  })
}

export const prepareRasterCog = (file, meta) => call('prepareRasterCog', [{ file, meta }], { worker: 1 })
