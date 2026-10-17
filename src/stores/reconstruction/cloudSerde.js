import { markRaw } from 'vue'
import { packAttributes, unpackAttributes, attributeLayout } from '../../core/io/cloudAttributes.js'
import { makePackedPoints } from '../../core/sfm/resultCodec.js'

// Cloud ↔ on-disk shape. Lifted out of useReconstructionStore so the format has one
// home and can be round-tripped in tests (it handles three cloud kinds and a CSR
// view-track layout).
//
// Lives under stores/ rather than core/ because it applies `markRaw`: the big typed
// arrays and the points array must stay PLAIN, both because a reactive Proxy is
// wasteful over millions of points and because it cannot be structured-cloned to a
// worker. core/ may not import Vue, so this is store-layer by construction.
//
// `makeCloudId` is injected rather than imported: cloud ids are minted by the store
// (a monotonic per-session counter); a restore only falls back to one for a
// document cloud that carries no id.

// Pack one cloud into the on-disk shape: small metadata (cameras stay JSON —
// ~hundreds at most) plus binary buffers for the heavy per-point data. Colour is
// whole-cloud (the colouring pass runs over every point), so a single hasColor
// flag governs the col buffer. View-tracks use a CSR layout: vcount[i] tracks for
// point i, flattened into vcam/vkp; camera uuids are dictionary-encoded via
// viewUuids (seeded from the cloud's cameras, extended for any stray uuid).
// Dense clouds are already flat ({ count, pos:Float32, col:Uint8 }) with no
// view-tracks, so serialization is near-passthrough. pos keeps its in-memory width
// on disk: a computed Float32 cloud writes 12 bytes per point, an imported Float64
// one 24. The file is self-describing by its size (posArray below), so a cloud
// whose older Float64 file is reused (savedCloudFiles.js) still reads correctly.
// Earlier saves widened every dense/mesh pos to Float64: twice the bytes to read,
// plus a full widening copy on every save and a narrowing copy on every load — at
// 20 M points that was 494 MB read and two transient copies per open.
// `{ buffers: false }` returns the same metadata with `buffers: null` and allocates
// nothing — the save path for a cloud whose sidecars are reused (savedCloudFiles.js).
export function serializeDenseCloud(c, { buffers = true } = {}) {
  const N = c.count || 0
  // A streamed cloud (core/lod/streamed.js): its points live only in its octree.
  if (!c.pos && c.lod) {
    return {
      id: c.id, name: c.name, kind: 'dense', createdAt: c.createdAt, streamed: true, posType: 'f64',
      imported: !!c.imported, derived: !!c.derived, secondary: !!c.secondary,
      cameras: [], pointCount: N, hasColor: false, hasNormals: false, viewUuids: [], buffers: null,
    }
  }
  const meta = {
    id: c.id, name: c.name, kind: 'dense', createdAt: c.createdAt,
    posType: c.pos instanceof Float64Array ? 'f64' : 'f32',
    imported: !!c.imported, derived: !!c.derived, secondary: !!c.secondary,
    cameras: [], pointCount: N, hasColor: !!c.col, hasNormals: !!c.nrm, viewUuids: [],
  }
  if (!buffers) return { ...meta, buffers: null }
  const pos = c.pos.slice(0, N * 3)
  const col = c.col ? c.col.slice(0, N * 3) : null
  // World-space normals stay Float32 on disk (unit scale — no precision gain from
  // widening). Absent on normal-less/legacy runs; the reader leaves nrm undefined.
  const nrm = c.nrm ? c.nrm.slice(0, N * 3) : null
  return {
    ...meta,
    buffers: { pos: pos.buffer, col: col ? col.buffer : null, nrm: nrm ? nrm.buffer : null,
      vcount: null, vcam: null, vkp: null, vx: null, vy: null },
  }
}

// Mesh cloud on-disk shape: pos (per-vertex, its in-memory width as for dense) + col
// (Uint8, per-vertex) + idx (Uint32, 3·triangles). nVerts + count(=tris) in metadata.
export function serializeMeshCloud(c, { buffers = true } = {}) {
  const nVerts = c.nVerts || 0
  const meta = {
    id: c.id, name: c.name, kind: 'mesh', createdAt: c.createdAt,
    posType: c.pos instanceof Float64Array ? 'f64' : 'f32',
    imported: !!c.imported, derived: !!c.derived, secondary: !!c.secondary,
    cameras: [], pointCount: nVerts, nVerts, triCount: c.count || 0,
    hasColor: !!c.col, viewUuids: [],
    ...(c.meshSummary ? { meshSummary: c.meshSummary } : {}),
    // A textured mesh: UVs (Float32, 2 per vertex) and the atlas pages (JPEG bytes in
    // one buffer, each page's slice here) are sidecars; the page table and the
    // face groups per page are metadata.
    ...(c.uv && c.texture ? {
      hasUv: true,
      texture: { pages: c.texture.pages, groups: c.texture.groups, bytes: c.texture.data.byteLength },
      ...(c.textureSummary ? { textureSummary: c.textureSummary } : {}),
    } : {}),
  }
  if (!buffers) return { ...meta, buffers: null }
  const pos = c.pos.slice(0, nVerts * 3)
  const col = c.col ? c.col.slice(0, nVerts * 3) : null
  const idx = c.idx ? Uint32Array.from(c.idx) : new Uint32Array(0)
  return {
    ...meta,
    buffers: { pos: pos.buffer, col: col ? col.buffer : null, idx: idx.buffer,
      ...(meta.hasUv ? { uv: c.uv.slice(0, nVerts * 2).buffer, texture: c.texture.data.slice().buffer } : {}),
      vcount: null, vcam: null, vkp: null, vx: null, vy: null },
  }
}

function serializeCloudData(c, opts) {
  if (c.kind === 'dense') return serializeDenseCloud(c, opts)
  if (c.kind === 'mesh') return serializeMeshCloud(c, opts)
  // A sparse cloud's points are already the columns the disk format stores
  // (SparsePoints): write them as they are (the save does not transfer them).
  const pts = c.points
  const own = (a) => (a.byteOffset !== 0 || a.byteLength !== a.buffer.byteLength ? a.slice() : a)
  const { pos, col, colorMask, viewUuids, vcount, vcam, vkp, vx, vy } = pts.columns()
  return {
    id: c.id, name: c.name, kind: c.kind, createdAt: c.createdAt,
    imported: !!c.imported, secondary: !!c.secondary,
    cameras: [...c.cameras.entries()].map(([uuid, cam]) => ({ uuid, ...cam })),
    pointCount: pts.length, hasColor: pts.hasColor, viewUuids: [...viewUuids],
    buffers: {
      pos: own(pos).buffer,
      col: col ? own(col).buffer : null,
      colorMask: col && colorMask ? own(colorMask).buffer : null,
      vcount: own(vcount).buffer,
      vcam: own(vcam).buffer,
      vkp: own(vkp).buffer,
      vx: vx ? own(vx).buffer : null,
      vy: vy ? own(vy).buffer : null,
    },
  }
}

// A dense/mesh pos sidecar as stored: 12 bytes per point is Float32 (a view, no
// copy), 24 is Float64 — narrowed to Float32 only for an older computed cloud that
// was Float32 in memory when saved. Imported Float64 coordinates are never narrowed.
function posArray(c, buffer, n) {
  if (!buffer) return new Float64Array(0)
  if (n > 0 && buffer.byteLength === n * 12) return new Float32Array(buffer)
  const stored = new Float64Array(buffer)
  return c.posType === 'f32' && !c.imported ? new Float32Array(stored) : stored
}

function deserializeCloudData(c, makeCloudId) {
  const N = c.pointCount ?? 0
  const b = c.buffers || {}
  // Dense clouds restore into the flat shape with their original position precision.
  // Retain Float64 precision in memory, including imported projected coordinates.
  if (c.kind === 'dense' && c.streamed) {
    return {
      id: c.id ?? makeCloudId(), name: c.name ?? 'Dense cloud', kind: 'dense', createdAt: c.createdAt ?? Date.now(),
      cameras: markRaw(new Map()), ...(c.imported ? { imported: true } : {}), ...(c.derived ? { derived: true } : {}),
      count: N, pos: null, col: null,
    }
  }
  if (c.kind === 'dense') {
    const posF = posArray(c, b.pos, N)
    const col = c.hasColor && b.col ? new Uint8Array(b.col) : null
    // Normals stay Float32 on disk; undefined when the run produced none (no heal).
    const nrm = c.hasNormals && b.nrm ? new Float32Array(b.nrm) : null
    return {
      id: c.id ?? makeCloudId(), name: c.name ?? 'Dense cloud', kind: 'dense',
      createdAt: c.createdAt ?? Date.now(), cameras: markRaw(new Map()),
      ...(c.imported ? { imported: true } : {}),
      // Absent on projects saved before cloud editing existed ⇒ not derived.
      ...(c.derived ? { derived: true } : {}),
      count: N, pos: markRaw(posF), col: col ? markRaw(col) : null,
      ...(nrm ? { nrm: markRaw(nrm) } : {}),
    }
  }
  if (c.kind === 'mesh') {
    const nVerts = c.nVerts ?? N
    const posF = posArray(c, b.pos, nVerts)
    const col = c.hasColor && b.col ? new Uint8Array(b.col) : null
    const idx = b.idx ? new Uint32Array(b.idx) : new Uint32Array(0)
    return {
      id: c.id ?? makeCloudId(), name: c.name ?? 'Mesh', kind: 'mesh',
      createdAt: c.createdAt ?? Date.now(), cameras: markRaw(new Map()),
      ...(c.imported ? { imported: true } : {}),
      // A Mesh ▾ tool output; a re-mesh must never replace it. Absent on meshes
      // saved before mesh editing existed ⇒ not derived.
      ...(c.derived ? { derived: true } : {}),
      count: c.triCount ?? (idx.length / 3), nVerts,
      pos: markRaw(posF), idx: markRaw(idx), col: col ? markRaw(col) : null,
      // The mesh run record; absent on meshes saved before it existed ⇒ unknown.
      ...(c.meshSummary ? { meshSummary: c.meshSummary } : {}),
      ...(c.hasUv && b.uv && b.texture ? {
        uv: markRaw(new Float32Array(b.uv)),
        texture: markRaw({ data: new Uint8Array(b.texture), pages: c.texture.pages, groups: c.texture.groups }),
        ...(c.textureSummary ? { textureSummary: c.textureSummary } : {}),
      } : {}),
    }
  }
  const pos = b.pos ? new Float64Array(b.pos) : new Float64Array(0)
  const col = c.hasColor && b.col ? new Uint8Array(b.col) : null
  const colorMask = b.colorMask ? new Uint8Array(b.colorMask) : null
  const vcount = b.vcount ? new Uint32Array(b.vcount) : null
  const vcam = b.vcam ? new Uint32Array(b.vcam) : null
  const vkp = b.vkp ? new Uint32Array(b.vkp) : null
  const vx = b.vx ? new Float32Array(b.vx) : null
  const vy = b.vy ? new Float32Array(b.vy) : null
  const viewUuids = c.viewUuids || []

  const cameras = new Map()
  for (const cam of c.cameras || []) { const { uuid, R, t, K } = cam; cameras.set(uuid, { R, t, K }) }

  // A cloud saved without tracks (none in practice) restores with no views.
  const points = makePackedPoints({ pos, col, colorMask, viewUuids, vx, vy,
    vcount: vcount ?? new Uint32Array(N), vcam: vcam ?? new Uint32Array(0), vkp: vkp ?? new Uint32Array(0) })
  return {
    id: c.id ?? makeCloudId(),
    name: c.name ?? 'Sparse cloud',
    kind: c.kind ?? 'sparse',
    createdAt: c.createdAt ?? Date.now(),
    ...(c.imported ? { imported: true } : {}),
    ...(c.secondary ? { secondary: true } : {}),
    cameras: markRaw(cameras),
    points: markRaw(points),
  }
}

// Keep view styling and scalar fields alongside every cloud kind.
// `reuse` ({ key: { name, bytes } }, from savedCloudFiles.js) means the cloud's heavy
// data is unchanged since a save that wrote those files: the metadata is rebuilt (it
// carries the editable name/visibility/style) but no buffer is allocated or copied,
// and the saver points this generation at the existing files. Only dense and mesh
// clouds qualify; a sparse cloud always serialises in full.
export function serializeCloud(c, { reuse = null } = {}) {
  const count = c.kind === 'mesh' ? c.nVerts : (c.count ?? c.points?.length ?? 0)
  const style = c.style ? JSON.parse(JSON.stringify(c.style)) : null
  if (reuse && (c.kind === 'dense' || c.kind === 'mesh')) {
    const data = serializeCloudData(c, { buffers: false })
    const { fields } = attributeLayout(c.attributes, count)
    return { ...data, visible: c.visible !== false, style, attributeFields: fields, ...lodMeta(c), buffers: null, reuse }
  }
  const data = serializeCloudData(c)
  const { fields, buffer } = packAttributes(c.attributes, count)
  return { ...data, visible: c.visible !== false, style, attributeFields: fields, ...lodMeta(c), buffers: { ...data.buffers, attributes: buffer } }
}

// A dense cloud's level-of-detail octree (reconstruction/cloudLod.js): metadata only,
// its files live in lod/. Restored only when it still describes the cloud's points.
const lodMeta = (c) => (c.kind === 'dense' && c.lod ? { lod: JSON.parse(JSON.stringify(c.lod)) } : {})

// Attributes (intensity, classification, …) are optional extras: a damaged
// attribute sidecar drops that cloud's attributes, never the cloud — and never,
// by throwing inside the restore map, every other cloud in the project. The
// reason rides along as `attributeError` (not persisted) for the restore log.
export function deserializeCloud(c, makeCloudId) {
  const cloud = deserializeCloudData(c, makeCloudId)
  let attributes = {}, attributeError = null
  try {
    attributes = unpackAttributes(c.attributeFields, c.buffers?.attributes, c.pointCount ?? 0)
  } catch (err) {
    attributeError = err?.message ?? String(err)
  }
  // A streamed cloud's octree is all it has, so it is kept as it is.
  const lod = c.kind === 'dense' && c.lod && (c.streamed || c.lod.points === (c.pointCount ?? 0)) ? markRaw(c.lod) : null
  return { ...cloud, visible: c.visible !== false, style: c.style ?? null,
    ...(lod ? { lod } : {}),
    ...(Object.keys(attributes).length ? { attributes: markRaw(attributes) } : {}),
    ...(attributeError ? { attributeError } : {}) }
}
