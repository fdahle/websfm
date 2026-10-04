// Pure (de)serialization of dense Stage A depth maps ↔ flat binary sidecars.
//
// A depth map is the most expensive artifact the pipeline produces (minutes per
// image on CPU), so unlike the other recomputable caches it is persisted. The
// heavy part is four per-pixel planes; everything else (dims, K, R, t) is a few
// bytes of metadata. This module is the pure half — it knows the on-disk layout
// but nothing about OPFS or the store; `utils/opfs.js` does the I/O and
// `useReconstructionStore` decides when.
//
// Layout, per map, mirroring the reconstruction cloud sidecars:
//   meta    → an entry in depthmaps/index.json
//   depth   Float32  W·H     metres along the camera ray; <= 0 means "no data"
//   cost    Float32  W·H     ZNCC matching cost (fusion's maxCost gate reads it)
//   nrm     Float32  3·W·H   camera-frame unit plane normals (Poisson mesh input;
//                            absent on runs that produced none — do NOT heal)
//   rgb     Uint8    3·W·H   working-resolution colour (ortho reads it)

export const DEPTH_BIN_KEYS = ['depth', 'cost', 'nrm', 'rgb']

// Hand back a typed array's bytes as a standalone ArrayBuffer. Planes arriving
// from the worker own their buffers, but a view onto a larger buffer would
// otherwise silently persist its neighbours' bytes too.
function bufferOf(ta) {
  if (!ta) return null
  return ta.byteOffset === 0 && ta.byteLength === ta.buffer.byteLength
    ? ta.buffer
    : ta.buffer.slice(ta.byteOffset, ta.byteOffset + ta.byteLength)
}

// Coverage summary of a depth plane, computed once at write time (when the plane is
// already in hand) so the Quality Report ▸ Coverage view can read it from the tiny
// index without hydrating hundreds of MB of planes. validPx = count of depth > 0;
// depthMin/Max span the valid depths (null when none); depthMedian is the median
// valid depth (v3, PLAN-eval-quality-hub WS2.4 — the real representative depth for a
// true GSD, replacing the midpoint approximation). Collecting the valid depths to
// sort is a one-time cost at write, dwarfed by the minutes already spent computing
// the map.
function depthCoverage(depth) {
  if (!depth || !depth.length) return { validPx: 0, depthMin: null, depthMax: null, depthMedian: null }
  let min = Infinity, max = -Infinity
  const vals = []
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i]
    if (d > 0) { vals.push(d); if (d < min) min = d; if (d > max) max = d }
  }
  if (!vals.length) return { validPx: 0, depthMin: null, depthMax: null, depthMedian: null }
  vals.sort((a, b) => a - b)
  return {
    validPx: vals.length, depthMin: min, depthMax: max,
    depthMedian: vals[vals.length >> 1],
  }
}

// Split one in-memory depth map into { meta, buffers } for the writer. The
// display PNG (`displayDataUrl`) is deliberately dropped: the images store
// already persists it per image, and it is display-only.
export function serializeDepthMap(m) {
  const cov = depthCoverage(m.depth)
  return {
    meta: {
      uuid: m.uuid,
      width: m.width,
      height: m.height,
      K: { fx: m.K.fx, fy: m.K.fy, cx: m.K.cx, cy: m.K.cy },
      R: m.R.map((row) => [...row]),
      t: [...m.t],
      hasNormals: !!m.normals,
      validPx: cov.validPx,
      depthMin: cov.depthMin,
      depthMax: cov.depthMax,
      depthMedian: cov.depthMedian,
    },
    buffers: {
      depth: bufferOf(m.depth),
      cost: bufferOf(m.cost),
      nrm: bufferOf(m.normals),
      rgb: bufferOf(m.rgb),
    },
  }
}

// Expected byte length of each plane at these dimensions.
export function planeBytes(width, height) {
  const px = width * height
  return { depth: px * 4, cost: px * 4, nrm: px * 3 * 4, rgb: px * 3 }
}

// True when none of the required planes are on disk at all — the map is gone, not
// damaged. Removing an image deletes its planes (see opfs `deleteDepth`) while the
// index still lists it, and that map should simply drop out; a *partial* or
// wrong-sized read is corruption instead, and the caller must not fuse it.
export function depthPlanesMissing(buffers) {
  if (!buffers) return true
  return ['depth', 'cost', 'rgb'].every((k) => !buffers[k] || buffers[k].byteLength === 0)
}

// Rebuild one depth map from its metadata + sidecar buffers. Returns null when a
// required plane is missing or the wrong size for the recorded dimensions —
// a truncated write / half-deleted project must surface as "recompute the depth
// maps", never as planes that fuse into a silently wrong dense cloud.
export function deserializeDepthMap(meta, buffers) {
  if (!meta || !buffers) return null
  const { width, height } = meta
  if (!(width > 0) || !(height > 0)) return null
  const want = planeBytes(width, height)
  for (const key of ['depth', 'cost', 'rgb']) {
    if (!buffers[key] || buffers[key].byteLength !== want[key]) return null
  }
  // Normals are optional, but a present-and-wrong-sized one is still corruption.
  const hasNrm = !!buffers.nrm && buffers.nrm.byteLength > 0
  if (hasNrm && buffers.nrm.byteLength !== want.nrm) return null
  return {
    uuid: meta.uuid,
    width,
    height,
    K: meta.K,
    R: meta.R,
    t: meta.t,
    depth: new Float32Array(buffers.depth),
    cost: new Float32Array(buffers.cost),
    rgb: new Uint8Array(buffers.rgb),
    normals: hasNrm ? new Float32Array(buffers.nrm) : null,
  }
}

// Depth maps live in the main sparse cloud's coordinate frame, so a re-run of the
// sparse reconstruction invalidates them. The cloud id is NOT enough on its own:
// `upsertSparseCloud` carries the previous id forward on a rebuild. Its
// `createdAt` is refreshed by every upsert, so id+createdAt is the fingerprint.
// version 2 added validPx/depthMin/depthMax to each map's meta; version 3 adds
// depthMedian (the real GSD basis). A v1/v2 index simply lacks the newer fields —
// the coverage view falls back (midpoint for GSD, "—" for the rest) rather than
// refusing or re-hydrating; a missing field must never trip the staleness path
// (isDepthIndexStale is about the sparse-cloud stamp only).
export function buildDepthIndex(maps, { sparseCloud, settings } = {}) {
  return {
    version: 3,
    sparseCloudId: sparseCloud?.id ?? null,
    sparseCreatedAt: sparseCloud?.createdAt ?? null,
    settings: settings ?? null,
    maps: maps.map((m) => serializeDepthMap(m).meta),
  }
}

// True when persisted maps cannot be trusted against the current sparse cloud.
// A missing stamp (hand-edited / future legacy index) counts as stale: refusing
// costs a recompute, accepting risks a wrong cloud.
export function isDepthIndexStale(index, sparseCloud) {
  if (!index || !Array.isArray(index.maps) || !index.maps.length) return false
  if (!sparseCloud) return true
  if (index.sparseCloudId == null || index.sparseCreatedAt == null) return true
  return index.sparseCloudId !== sparseCloud.id
    || index.sparseCreatedAt !== sparseCloud.createdAt
}

// Total bytes of the per-pixel planes across maps — for the "persisted N MB" log
// line, computed from metadata alone so a restore can report before loading.
export function depthMapBytes(metas) {
  let total = 0
  for (const m of metas) {
    const want = planeBytes(m.width, m.height)
    total += want.depth + want.cost + want.rgb + (m.hasNormals ? want.nrm : 0)
  }
  return total
}
