import { encode, decode } from '../../core/segment/sam2.js'

// SAM2 smart-mask ops (F12). Two-phase, mirroring how the plan (TODO.md F12)
// splits the model: `segmentEncode` runs the heavy image encoder ONCE per image
// and caches the resulting embeddings **here in the worker** (they're large ORT
// tensors — never marshalled to the main thread); `segmentDecode` runs the light
// decoder per click against those cached embeddings and returns a binary mask.
//
// Pinned to worker 0 by the client (like LightGlue/SuperPoint) so the single heavy
// ORT session loads once and the module-scoped embedding cache is on the worker the
// client always dispatches to. `rasterize` (OffscreenCanvas decode) is injected,
// same as detect/dense.
export function makeSegmentOps({ rasterize }) {
  // uuid → { embeddings, w, h }. Only the most-recent few images are worth
  // keeping (each embedding set is a handful of MB); a tiny LRU cap avoids
  // unbounded growth as the user clicks through images.
  const cache = new Map()
  const MAX_CACHED = 4

  function remember(uuid, entry) {
    cache.delete(uuid) // refresh LRU order
    cache.set(uuid, entry)
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value)
  }

  // Encode one image → cache its embeddings under `uuid`. `maxDim` caps the
  // rasterisation before the fixed 1024² model resize (the encoder resizes
  // internally, so a huge source only wastes decode time). Returns dims + timing.
  async function segmentEncode([uuid, url, options = {}], { emit } = {}) {
    const { maxDim = 1024, backend, sessionOpts } = options
    const onLog = emit ? (msg) => emit('log', [msg]) : undefined
    const { data, width, height } = await rasterize(url, maxDim)
    const { embeddings, ms } = await encode(data, width, height, { onLog, backend, sessionOpts })
    remember(uuid, { embeddings, w: width, h: height })
    return { result: { uuid, width, height, ms } }
  }

  // Decode a mask for `uuid` from `points` ([{ x, y, positive }] in the encoded
  // raster's pixel space). Requires a prior segmentEncode for that uuid. Returns
  // the raw low-res logits (transferable Float32Array, mw·mh) so the caller can
  // upsample to any resolution — a native-res commit is far finer than a
  // pre-thresholded low-res mask (see decode()).
  async function segmentDecode([uuid, points, options = {}], { emit } = {}) {
    const entry = cache.get(uuid)
    if (!entry) throw new Error(`SAM2: no cached embedding for ${uuid} — run segmentEncode first`)
    remember(uuid, entry) // touch LRU
    const onLog = emit ? (msg) => emit('log', [msg]) : undefined
    const { backend, sessionOpts } = options
    const { logits, mw, mh, iou, ms } = await decode(entry.embeddings, points, entry.w, entry.h, { onLog, backend, sessionOpts })
    return {
      result: { uuid, width: entry.w, height: entry.h, mw, mh, logits, iou, ms },
      transfer: [logits.buffer],
    }
  }

  // Drop cached embeddings (all, or one uuid) — e.g. when leaving mask-edit mode
  // or when an image's pixels change (re-detect/mask edit).
  async function segmentForget([uuid] = []) {
    if (uuid == null) cache.clear()
    else cache.delete(uuid)
    return { result: { ok: true } }
  }

  return { segmentEncode, segmentDecode, segmentForget }
}
