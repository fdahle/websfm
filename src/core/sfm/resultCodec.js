// Compact worker -> main-thread transport for sparse reconstruction results.
//
// A normal SfM result contains one JS array per point, one JS array per view, and
// another tuple for every observation. Structured-cloning that graph at the end of
// a large run briefly duplicates millions of objects and can exhaust the browser
// heap even though the finished cloud itself fits comfortably. Pack the numeric
// payload into transferable buffers instead. The main thread expands it directly
// into the Map-based shape used by the rest of the application.

const PACKED_VERSION = 1

// Read-only Map-compatible window onto the shared CSR observation buffers. Sparse
// clouds are immutable after reconstruction, so consumers only need Map's read
// surface. One tiny slice replaces all Map buckets and per-pixel arrays for a point.
export class PackedViewSlice {
  constructor(tracks, start, end, pixels = false) {
    this.tracks = tracks
    this.start = start
    this.end = end
    this.pixels = pixels
  }

  get size() {
    if (!this.pixels) return this.end - this.start
    let n = 0
    for (let i = this.start; i < this.end; i++) if (Number.isFinite(this.tracks.vx?.[i])) n++
    return n
  }
  get length() { return this.size }

  get(uuid) {
    const { viewUuids, vcam, vkp, vx, vy } = this.tracks
    for (let i = this.start; i < this.end; i++) {
      if (viewUuids[vcam[i]] !== uuid) continue
      if (!this.pixels) return vkp[i]
      return Number.isFinite(vx?.[i]) ? [vx[i], vy[i]] : undefined
    }
    return undefined
  }

  has(uuid) { return this.get(uuid) !== undefined }

  *[Symbol.iterator]() {
    const { viewUuids, vcam, vkp, vx, vy } = this.tracks
    for (let i = this.start; i < this.end; i++) {
      const uuid = viewUuids[vcam[i]]
      if (this.pixels) {
        if (Number.isFinite(vx?.[i])) yield [uuid, [vx[i], vy[i]]]
      } else {
        yield [uuid, vkp[i]]
      }
    }
  }

  entries() { return this[Symbol.iterator]() }
  *keys() { for (const [key] of this) yield key }
  *values() { for (const [, value] of this) yield value }
  map(callback, thisArg) {
    const out = []
    let i = 0
    for (const value of this) out.push(callback.call(thisArg, value, i++, this))
    return out
  }
  some(callback, thisArg) {
    let i = 0
    for (const value of this) if (callback.call(thisArg, value, i++, this)) return true
    return false
  }
  forEach(callback, thisArg) {
    for (const [key, value] of this) callback.call(thisArg, value, key, this)
  }
}

export function attachPackedTracks(points, tracks) {
  Object.defineProperty(points, 'packedTracks', {
    value: tracks, configurable: true, enumerable: false, writable: false,
  })
  return points
}

// Build lightweight point records around transferred/restored numeric buffers.
// `pos` may be Float32 or Float64. Legacy persisted clouds omit colorMask, in
// which case every stored colour is considered present for backward compatibility.
export function makePackedPoints({
  pos, col = null, colorMask = null, viewUuids = [], vcount, vcam, vkp,
  vx = null, vy = null, missingColorIsUndefined = false,
}) {
  const tracks = { viewUuids, vcount, vcam, vkp, vx, vy }
  const count = vcount.length
  const points = new Array(count)
  let vi = 0
  for (let i = 0; i < count; i++) {
    const start = vi
    const end = start + vcount[i]
    const views = new PackedViewSlice(tracks, start, end)
    let viewsPx
    if (vx) {
      for (let j = start; j < end; j++) {
        if (Number.isFinite(vx[j])) { viewsPx = new PackedViewSlice(tracks, start, end, true); break }
      }
    }
    points[i] = {
      x: pos[i * 3], y: pos[i * 3 + 1], z: pos[i * 3 + 2],
      color: col && (!colorMask || colorMask[i])
        ? [col[i * 3], col[i * 3 + 1], col[i * 3 + 2]]
        : (missingColorIsUndefined ? undefined : null),
      views,
      viewsPx,
    }
    vi = end
  }
  return attachPackedTracks(points, tracks)
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
    pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z
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
      col[i * 3] = color[0]; col[i * 3 + 1] = color[1]; col[i * 3 + 2] = color[2]
      colorMask[i] = 1
    }
    for (const view of (p.views || [])) {
      const uuid = view[0]
      let ci = cameraIndex.get(uuid)
      if (ci === undefined) { ci = viewUuids.length; cameraIndex.set(uuid, ci); viewUuids.push(uuid) }
      vcam[vi] = ci
      vkp[vi] = view[1]
      const px = pixelOf?.(uuid, view[1], p)
      if (px) { vx[vi] = px[0]; vy[vi] = px[1] }
      vi++
    }
    if (consume) points[i] = null
  }
  return makePackedPoints({
    pos, col: hasColor ? col : null, colorMask: hasColor ? colorMask : null,
    viewUuids, vcount, vcam, vkp, vx, vy,
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
    pos[i * 3] = tracks.x(p); pos[i * 3 + 1] = tracks.y(p); pos[i * 3 + 2] = tracks.z(p)
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
      col[i * 3] = color[0]; col[i * 3 + 1] = color[1]; col[i * 3 + 2] = color[2]
      colorMask[i] = 1
    }
    tracks.forEachView(p, (img, kp) => {
      const uuid = uuidOf(img)
      let ci = cameraIndex.get(uuid)
      if (ci === undefined) { ci = viewUuids.length; cameraIndex.set(uuid, ci); viewUuids.push(uuid) }
      vcam[vi] = ci
      vkp[vi] = kp
      const px = pixelOf(img, kp)
      if (px) { vx[vi] = px[0]; vy[vi] = px[1] }
      vi++
    })
  }
  return makePackedPoints({
    pos, col: hasColor ? col : null, colorMask: hasColor ? colorMask : null,
    viewUuids, vcount, vcam, vkp, vx, vy,
  })
}

function packModel(model, transfer) {
  const points = model?.points || []
  const pointCount = points.length
  const pos = new Float64Array(pointCount * 3)
  const sourceTracks = points.packedTracks ?? null
  const vcount = sourceTracks?.vcount ?? new Uint32Array(pointCount)

  let totalViews = 0
  let hasColor = false
  for (let i = 0; i < pointCount; i++) {
    totalViews += points[i].views?.size ?? points[i].views?.length ?? 0
    if (points[i].color) hasColor = true
  }

  const col = hasColor ? new Uint8Array(pointCount * 3) : null
  // Preserve the distinction between a genuinely black point and a point for
  // which none of the observing keypoints carried colour.
  const colorMask = hasColor ? new Uint8Array(pointCount) : null
  const vcam = sourceTracks?.vcam ?? new Uint32Array(totalViews)
  const vkp = sourceTracks?.vkp ?? new Uint32Array(totalViews)
  // NaN means that a legacy/malformed observation has no BA-frame pixel. This is
  // also the existing on-disk convention, so no extra mask needs to stay resident.
  const vx = sourceTracks?.vx ?? new Float32Array(totalViews).fill(NaN)
  const vy = sourceTracks?.vy ?? new Float32Array(totalViews).fill(NaN)

  const viewUuids = sourceTracks?.viewUuids ?? []
  const cameraIndex = new Map()
  const indexOfCamera = (uuid) => {
    let index = cameraIndex.get(uuid)
    if (index === undefined) {
      index = viewUuids.length
      cameraIndex.set(uuid, index)
      viewUuids.push(uuid)
    }
    return index
  }

  let vi = 0
  for (let i = 0; i < pointCount; i++) {
    const p = points[i]
    pos[i * 3] = p.x
    pos[i * 3 + 1] = p.y
    pos[i * 3 + 2] = p.z
    if (col && p.color) {
      col[i * 3] = p.color[0]
      col[i * 3 + 1] = p.color[1]
      col[i * 3 + 2] = p.color[2]
      colorMask[i] = 1
    }
    if (!sourceTracks) {
      const views = p.views || []
      vcount[i] = views.size ?? views.length
      for (const view of views) {
        vcam[vi] = indexOfCamera(view[0])
        vkp[vi] = view[1]
        const packedPx = p.viewsPx?.get?.(view[0])
        if (view.length >= 4 || packedPx) {
          vx[vi] = packedPx?.[0] ?? view[2]
          vy[vi] = packedPx?.[1] ?? view[3]
        }
        vi++
      }
    }
  }

  const buffers = {
    pos: pos.buffer,
    col: col?.buffer ?? null,
    colorMask: colorMask?.buffer ?? null,
    vcount: vcount.buffer,
    vcam: vcam.buffer,
    vkp: vkp.buffer,
    vx: vx.buffer,
    vy: vy.buffer,
  }
  for (const buffer of Object.values(buffers)) if (buffer) transfer.push(buffer)

  const { points: _points, secondaryModels: _secondaryModels, ...metadata } = model || {}
  return { ...metadata, packedVersion: PACKED_VERSION, pointCount, viewUuids, hasColor, buffers }
}

export function packReconstructionResult(result) {
  const transfer = []
  const packed = packModel(result, transfer)
  packed.secondaryModels = (result?.secondaryModels || []).map((model) => packModel(model, transfer))
  return { result: packed, transfer }
}

// Store models use a Map; the transport uses camera records. Clone only the
// small calibration records; point buffers are copied by the transport caller.
export function packSparseCloud(cloud) {
  return packReconstructionResult({
    status: 'done', points: cloud.points,
    cameras: [...cloud.cameras].map(([uuid, c]) => ({ uuid, R: c.R.map(row => [...row]), t: [...c.t], K: { ...c.K } })),
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
  const vx = new Float32Array(b.vx)
  const vy = new Float32Array(b.vy)
  const uuids = model.viewUuids || []

  const cameras = new Map((model.cameras || []).map(({ uuid, R, t, K }) => [uuid, { R, t, K }]))
  const points = makePackedPoints({
    pos, col, colorMask, viewUuids: uuids, vcount, vcam, vkp, vx, vy,
  })

  const {
    packedVersion: _packedVersion, pointCount: _pointCount, viewUuids: _viewUuids,
    hasColor: _hasColor, buffers: _buffers, secondaryModels: _secondaryModels,
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
