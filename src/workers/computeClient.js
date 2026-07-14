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
export const POOL_SIZE = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))

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
  if (ok) entry.resolve(result)
  else entry.reject(new Error(error))
}

function spawn() {
  const w = new Worker(new URL('./compute.worker.js', import.meta.url), {
    type: 'module',
    name: 'compute',
  })
  w.onmessage = handleMessage
  w.onerror = (e) => {
    // A worker-level error has no request id; fail everything in flight so callers
    // don't hang. (Rare — per-request errors come back as { ok: false }.)
    const err = new Error(e.message || 'compute worker error')
    for (const [id, entry] of pending) { pending.delete(id); entry.reject(err) }
  }
  return w
}

function getPool() {
  if (!workers) workers = Array.from({ length: POOL_SIZE }, spawn)
  return workers
}

// Hard-cancel: terminate every worker and reject all in-flight requests. The
// pool respawns lazily on the next call. Used to abort a running op (e.g. a long
// reconstruct) that can't be interrupted cooperatively mid-call.
export function terminateAll(reason = 'cancelled') {
  if (workers) for (const w of workers) w.terminate()
  workers = null
  for (const [id, entry] of pending) { pending.delete(id); entry.reject(new Error(reason)) }
}

function call(op, args, { transfer = [], onEvent, worker: pinned } = {}) {
  const pool = getPool()
  // `pinned` forces a specific worker (learned backends load a heavy per-worker
  // runtime once — see detectKeypoints); otherwise round-robin across the pool.
  const worker = pinned != null ? pool[pinned % pool.length] : pool[rr++ % pool.length]
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onEvent })
    worker.postMessage({ id, op, args }, transfer)
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

export function matchDescriptors(descA, descB, options = {}) {
  // No transfer: structured-clone copies the descriptors so the caller's
  // in-memory buffers (reused across pairs) are not detached.
  return call('match', [descA, descB, options])
}

// LightGlue joint match. Pinned to worker 0 for the same reason SuperPoint is —
// one heavy ORT session, loaded once — so concurrent pairs serialize on it rather
// than each booting their own runtime. Streams first-run init log lines.
export function matchLightGlue(args, { onLog } = {}) {
  return call('matchLightGlue', [args], {
    worker: 0,
    onEvent: onLog ? (ev, a) => { if (ev === 'log') onLog(...a) } : undefined,
  })
}

export function verifyMatches(kpsA, kpsB, matches, options = {}) {
  return call('verify', [kpsA, kpsB, matches, options])
}

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
// resolves to { status, cameras, points } when the model is complete.
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

// Import — parse a point-cloud / mesh file (PLY / LAS / XYZ text) off the main
// thread. The buffer is transferred in (detached for the caller); resolves to
// { parsed, stats } with the flat cloud buffers transferred back.
export function parseCloudFile(buffer, name, { onLog } = {}) {
  return call('parseCloud', [{ buffer, name }], {
    transfer: [buffer],
    onEvent: onLog ? (ev, a) => { if (ev === 'log') onLog(...a) } : undefined,
  })
}
