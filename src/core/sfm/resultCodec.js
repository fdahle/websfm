// Compact worker -> main-thread transport for sparse reconstruction results.
//
// A normal SfM result contains one JS array per point, one JS array per view, and
// another tuple for every observation. Structured-cloning that graph at the end of
// a large run briefly duplicates millions of objects and can exhaust the browser
// heap even though the finished cloud itself fits comfortably. Pack the numeric
// payload into transferable buffers instead: a cloud's points are already columns
// (SparsePoints), so packing hands their arrays over as they are.

import { SparsePoints } from './sparsePoints.js'

const PACKED_VERSION = 1

// Build a cloud around transferred/restored numeric buffers (sparsePoints.js). Without
// a colorMask every stored colour counts as present.
export function makePackedPoints({
  pos,
  col = null,
  colorMask = null,
  viewUuids = [],
  vcount,
  vcam,
  vkp,
  vx = null,
  vy = null,
}) {
  return new SparsePoints({ pos, col, colorMask, viewUuids, vcount, vcam, vkp, vx, vy })
}

// Convert the solver's mutable Map-backed points directly to the compact immutable
// result shape. This avoids first materialising one tuple array per observation —
// the former end-of-run allocation that was larger than the transport itself.
export function compactPointRecords(points, { colorOf, pixelOf, consume = false } = {}) {
  const count = points.length
  const pos = new Float64Array(count * 3)
  const vcount = new Uint32Array(count)
  let totalViews = 0
  for (let i = 0; i < count; i++) {
    const p = points[i]
    pos[i * 3] = p.x
    pos[i * 3 + 1] = p.y
    pos[i * 3 + 2] = p.z
    const n = p.views?.size ?? p.views?.length ?? 0
    vcount[i] = n
    totalViews += n
  }

  // At most 4 bytes/point; allocating eagerly avoids retaining one RGB array per
  // point between the count and fill passes. Drop it if the model has no colour.
  const col = new Uint8Array(count * 3)
  const colorMask = new Uint8Array(count)
  let hasColor = false
  const vcam = new Uint32Array(totalViews)
  const vkp = new Uint32Array(totalViews)
  const vx = new Float32Array(totalViews).fill(NaN)
  const vy = new Float32Array(totalViews).fill(NaN)
  const viewUuids = []
  const cameraIndex = new Map()
  let vi = 0
  for (let i = 0; i < count; i++) {
    const p = points[i]
    const color = colorOf ? colorOf(p) : p.color
    if (color) {
      hasColor = true
      col[i * 3] = color[0]
      col[i * 3 + 1] = color[1]
      col[i * 3 + 2] = color[2]
      colorMask[i] = 1
    }
    for (const view of p.views || []) {
      const uuid = view[0]
      let ci = cameraIndex.get(uuid)
      if (ci === undefined) {
        ci = viewUuids.length
        cameraIndex.set(uuid, ci)
        viewUuids.push(uuid)
      }
      vcam[vi] = ci
      vkp[vi] = view[1]
      const px = pixelOf?.(uuid, view[1], p)
      if (px) {
        vx[vi] = px[0]
        vy[vi] = px[1]
      }
      vi++
    }
    if (consume) points[i] = null
  }
  return makePackedPoints({
    pos,
    col: hasColor ? col : null,
    colorMask: hasColor ? colorMask : null,
    viewUuids,
    vcount,
    vcam,
    vkp,
    vx,
    vy,
  })
}

// The same compact result straight from the solver's TrackStore (trackStore.js): live
// points in order, each point's views in order — identical buffers to
// compactPointRecords over the equivalent Map-backed points.
//   uuidOf(img) → uuid; colorOf(p) → [r,g,b] | null; pixelOf(img, kp) → [x, y] | null
export function compactTrackRecords(tracks, { uuidOf, colorOf, pixelOf }) {
  const ids = tracks.liveIds()
  const count = ids.length
  const pos = new Float64Array(count * 3)
  const vcount = new Uint32Array(count)
  let totalViews = 0
  for (let i = 0; i < count; i++) {
    const p = ids[i]
    pos[i * 3] = tracks.x(p)
    pos[i * 3 + 1] = tracks.y(p)
    pos[i * 3 + 2] = tracks.z(p)
    const n = tracks.viewCount(p)
    vcount[i] = n
    totalViews += n
  }
  const col = new Uint8Array(count * 3)
  const colorMask = new Uint8Array(count)
  let hasColor = false
  const vcam = new Uint32Array(totalViews)
  const vkp = new Uint32Array(totalViews)
  const vx = new Float32Array(totalViews).fill(NaN)
  const vy = new Float32Array(totalViews).fill(NaN)
  const viewUuids = []
  const cameraIndex = new Map()
  let vi = 0
  for (let i = 0; i < count; i++) {
    const p = ids[i]
    const color = colorOf(p)
    if (color) {
      hasColor = true
      col[i * 3] = color[0]
      col[i * 3 + 1] = color[1]
      col[i * 3 + 2] = color[2]
      colorMask[i] = 1
    }
    tracks.forEachView(p, (img, kp) => {
      const uuid = uuidOf(img)
      let ci = cameraIndex.get(uuid)
      if (ci === undefined) {
        ci = viewUuids.length
        cameraIndex.set(uuid, ci)
        viewUuids.push(uuid)
      }
      vcam[vi] = ci
      vkp[vi] = kp
      const px = pixelOf(img, kp)
      if (px) {
        vx[vi] = px[0]
        vy[vi] = px[1]
      }
      vi++
    })
  }
  return makePackedPoints({
    pos,
    col: hasColor ? col : null,
    colorMask: hasColor ? colorMask : null,
    viewUuids,
    vcount,
    vcam,
    vkp,
    vx,
    vy,
  })
}

// A typed array whose buffer is exactly its own: transferable / clonable as is.
const own = (a) => (a && (a.byteOffset !== 0 || a.byteLength !== a.buffer.byteLength) ? a.slice() : a)

function packModel(model, transfer) {
  const points = model?.points ?? SparsePoints.empty()
  if (!(points instanceof SparsePoints)) throw new Error('packModel: points must be a SparsePoints cloud')
  const c = points.columns()
  const buffers = {
    pos: own(c.pos).buffer,
    col: c.col ? own(c.col).buffer : null,
    colorMask: c.col && c.colorMask ? own(c.colorMask).buffer : null,
    vcount: own(c.vcount).buffer,
    vcam: own(c.vcam).buffer,
    vkp: own(c.vkp).buffer,
    vx: c.vx ? own(c.vx).buffer : null,
    vy: c.vy ? own(c.vy).buffer : null,
  }
  for (const buffer of Object.values(buffers)) if (buffer && !transfer.includes(buffer)) transfer.push(buffer)

  const { points: _points, secondaryModels: _secondaryModels, ...metadata } = model || {}
  // A plain copy of the uuid list: a cloud reached through a reactive proxy hands
  // out a proxied array, which postMessage cannot clone.
  return {
    ...metadata,
    packedVersion: PACKED_VERSION,
    pointCount: points.length,
    viewUuids: [...c.viewUuids],
    hasColor: points.hasColor,
    buffers,
  }
}

export function packReconstructionResult(result) {
  const transfer = []
  const packed = packModel(result, transfer)
  packed.secondaryModels = (result?.secondaryModels || []).map((model) => packModel(model, transfer))
  return { result: packed, transfer }
}

// Store models use a Map; the transport uses camera records. Clone only the
// small calibration records. The point buffers are the cloud's own: a main-thread
// caller must structured-clone (not transfer) them, or the live cloud is detached.
export function packSparseCloud(cloud) {
  return packReconstructionResult({
    status: 'done',
    points: cloud.points,
    cameras: [...cloud.cameras].map(([uuid, c]) => ({
      uuid,
      R: c.R.map((row) => [...row]),
      t: [...c.t],
      K: { ...c.K },
    })),
  })
}

function unpackModel(model) {
  if (!model || model.packedVersion !== PACKED_VERSION) return model
  const count = model.pointCount ?? 0
  const b = model.buffers || {}
  const pos = new Float64Array(b.pos)
  const col = b.col ? new Uint8Array(b.col) : null
  const colorMask = b.colorMask ? new Uint8Array(b.colorMask) : null
  const vcount = new Uint32Array(b.vcount)
  const vcam = new Uint32Array(b.vcam)
  const vkp = new Uint32Array(b.vkp)
  const vx = b.vx ? new Float32Array(b.vx) : null
  const vy = b.vy ? new Float32Array(b.vy) : null
  const uuids = model.viewUuids || []

  const cameras = new Map((model.cameras || []).map(({ uuid, R, t, K }) => [uuid, { R, t, K }]))
  const points = makePackedPoints({
    pos,
    col,
    colorMask,
    viewUuids: uuids,
    vcount,
    vcam,
    vkp,
    vx,
    vy,
  })

  const {
    packedVersion: _packedVersion,
    pointCount: _pointCount,
    viewUuids: _viewUuids,
    hasColor: _hasColor,
    buffers: _buffers,
    secondaryModels: _secondaryModels,
    ...metadata
  } = model
  return { ...metadata, cameras, points }
}

export function unpackReconstructionResult(result) {
  const unpacked = unpackModel(result)
  if (!unpacked || result?.packedVersion !== PACKED_VERSION) return unpacked
  unpacked.secondaryModels = (result.secondaryModels || []).map(unpackModel)
  return unpacked
}
