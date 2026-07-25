import { markRaw } from 'vue'

// Cloud ↔ on-disk shape. Lifted out of useReconstructionStore so the format has one
// home and can be round-tripped in tests (it handles three cloud kinds, a CSR
// view-track layout and two legacy shapes — none of which was covered before).
//
// Lives under stores/ rather than core/ because it applies `markRaw`: the big typed
// arrays and the points array must stay PLAIN, both because a reactive Proxy is
// wasteful over millions of points and because it cannot be structured-cloned to a
// worker. core/ may not import Vue, so this is store-layer by construction.
//
// `makeCloudId` is injected rather than imported: cloud ids are minted by the store
// (a monotonic per-session counter), and a restore only needs one for a legacy doc
// that predates stored ids.

// Pack one cloud into the on-disk shape: small metadata (cameras stay JSON —
// ~hundreds at most) plus binary buffers for the heavy per-point data. Colour is
// whole-cloud (the colouring pass runs over every point), so a single hasColor
// flag governs the col buffer. View-tracks use a CSR layout: vcount[i] tracks for
// point i, flattened into vcam/vkp; camera uuids are dictionary-encoded via
// viewUuids (seeded from the cloud's cameras, extended for any stray uuid).
// Dense clouds are already flat ({ count, pos:Float32, col:Uint8 }) with no
// view-tracks, so serialization is near-passthrough. pos is widened to Float64 on
// disk to match the sparse sidecar format (so the reader stays dtype-uniform and
// dense clouds persisted before the flat rework still load through this branch).
export function serializeDenseCloud(c) {
  const N = c.count || 0
  const pos = new Float64Array(N * 3)
  pos.set(c.pos.subarray(0, N * 3))
  const col = c.col ? c.col.slice(0, N * 3) : null
  // World-space normals stay Float32 on disk (unit scale — no precision gain from
  // widening). Absent on normal-less/legacy runs; the reader leaves nrm undefined.
  const nrm = c.nrm ? c.nrm.slice(0, N * 3) : null
  return {
    id: c.id, name: c.name, kind: 'dense', createdAt: c.createdAt,
    imported: !!c.imported, derived: !!c.derived, secondary: !!c.secondary,
    cameras: [], pointCount: N, hasColor: !!col, hasNormals: !!nrm, viewUuids: [],
    buffers: { pos: pos.buffer, col: col ? col.buffer : null, nrm: nrm ? nrm.buffer : null,
      vcount: null, vcam: null, vkp: null, vx: null, vy: null },
  }
}

// Mesh cloud on-disk shape: pos (Float64, per-vertex, uniform sidecar dtype) + col
// (Uint8, per-vertex) + idx (Uint32, 3·triangles). nVerts + count(=tris) in metadata.
export function serializeMeshCloud(c) {
  const nVerts = c.nVerts || 0
  const pos = new Float64Array(nVerts * 3)
  pos.set(c.pos.subarray(0, nVerts * 3))
  const col = c.col ? c.col.slice(0, nVerts * 3) : null
  const idx = c.idx ? Uint32Array.from(c.idx) : new Uint32Array(0)
  return {
    id: c.id, name: c.name, kind: 'mesh', createdAt: c.createdAt,
    imported: !!c.imported, secondary: !!c.secondary,
    cameras: [], pointCount: nVerts, nVerts, triCount: c.count || 0,
    hasColor: !!col, viewUuids: [],
    buffers: { pos: pos.buffer, col: col ? col.buffer : null, idx: idx.buffer,
      vcount: null, vcam: null, vkp: null, vx: null, vy: null },
  }
}

export function serializeCloud(c) {
  if (c.kind === 'dense') return serializeDenseCloud(c)
  if (c.kind === 'mesh') return serializeMeshCloud(c)
  const pts = c.points
  const N = pts.length
  const pos = new Float64Array(N * 3)
  const hasColor = pts.some((p) => p.color)
  const col = hasColor ? new Uint8Array(N * 3) : null

  const camIndex = new Map()
  const viewUuids = []
  for (const uuid of c.cameras.keys()) { camIndex.set(uuid, viewUuids.length); viewUuids.push(uuid) }

  const vcount = new Uint32Array(N)
  let totalViews = 0
  for (const p of pts) totalViews += p.views ? p.views.size : 0
  const vcam = new Uint32Array(totalViews)
  const vkp = new Uint32Array(totalViews)
  // Per-view BA-frame pixel (COLMAP export). Only allocated when some point carries
  // it (sparse clouds from a real reconstruct); NaN marks a view without a pixel.
  const hasViewPx = pts.some((p) => p.viewsPx && p.viewsPx.size)
  const vx = hasViewPx ? new Float32Array(totalViews).fill(NaN) : null
  const vy = hasViewPx ? new Float32Array(totalViews).fill(NaN) : null

  let vi = 0
  for (let i = 0; i < N; i++) {
    const p = pts[i]
    pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z
    if (col && p.color) { col[i * 3] = p.color[0]; col[i * 3 + 1] = p.color[1]; col[i * 3 + 2] = p.color[2] }
    if (p.views && p.views.size) {
      vcount[i] = p.views.size
      for (const [uuid, kp] of p.views) {
        let ci = camIndex.get(uuid)
        if (ci === undefined) { ci = viewUuids.length; camIndex.set(uuid, ci); viewUuids.push(uuid) }
        vcam[vi] = ci; vkp[vi] = kp
        if (vx) { const px = p.viewsPx?.get(uuid); if (px) { vx[vi] = px[0]; vy[vi] = px[1] } }
        vi++
      }
    }
  }
  return {
    id: c.id, name: c.name, kind: c.kind, createdAt: c.createdAt,
    imported: !!c.imported, secondary: !!c.secondary,
    cameras: [...c.cameras.entries()].map(([uuid, cam]) => ({ uuid, ...cam })),
    pointCount: N, hasColor, viewUuids,
    buffers: {
      pos: pos.buffer,
      col: col ? col.buffer : null,
      vcount: vcount.buffer,
      vcam: vcam.buffer,
      vkp: vkp.buffer,
      vx: vx ? vx.buffer : null,
      vy: vy ? vy.buffer : null,
    },
  }
}

export function deserializeCloud(c, makeCloudId) {
  const N = c.pointCount ?? 0
  const b = c.buffers || {}
  // Dense clouds restore into the flat { count, pos:Float32, col:Uint8 } shape.
  // On-disk pos is Float64 (uniform sidecar format); narrow it to Float32 in memory.
  if (c.kind === 'dense') {
    const posF = b.pos ? Float32Array.from(new Float64Array(b.pos)) : new Float32Array(0)
    const col = c.hasColor && b.col ? new Uint8Array(b.col) : null
    // Normals stay Float32 on disk; undefined when the run produced none (no heal).
    const nrm = c.hasNormals && b.nrm ? new Float32Array(b.nrm) : null
    return {
      id: c.id ?? makeCloudId(), name: c.name ?? 'Dense cloud', kind: 'dense',
      createdAt: c.createdAt ?? Date.now(), cameras: markRaw(new Map()),
      ...(c.imported ? { imported: true } : {}),
      // Absent on projects saved before cloud editing existed ⇒ not derived.
      ...(c.derived ? { derived: true } : {}),
      count: N, pos: markRaw(posF), col: markRaw(col),
      ...(nrm ? { nrm: markRaw(nrm) } : {}),
    }
  }
  if (c.kind === 'mesh') {
    const nVerts = c.nVerts ?? N
    const posF = b.pos ? Float32Array.from(new Float64Array(b.pos)) : new Float32Array(0)
    const col = c.hasColor && b.col ? new Uint8Array(b.col) : null
    const idx = b.idx ? new Uint32Array(b.idx) : new Uint32Array(0)
    return {
      id: c.id ?? makeCloudId(), name: c.name ?? 'Mesh', kind: 'mesh',
      createdAt: c.createdAt ?? Date.now(), cameras: markRaw(new Map()),
      ...(c.imported ? { imported: true } : {}),
      count: c.triCount ?? (idx.length / 3), nVerts,
      pos: markRaw(posF), idx: markRaw(idx), col: markRaw(col),
    }
  }
  const pos = b.pos ? new Float64Array(b.pos) : new Float64Array(0)
  const col = c.hasColor && b.col ? new Uint8Array(b.col) : null
  const vcount = b.vcount ? new Uint32Array(b.vcount) : null
  const vcam = b.vcam ? new Uint32Array(b.vcam) : null
  const vkp = b.vkp ? new Uint32Array(b.vkp) : null
  const vx = b.vx ? new Float32Array(b.vx) : null
  const vy = b.vy ? new Float32Array(b.vy) : null
  const viewUuids = c.viewUuids || []

  const cameras = new Map()
  for (const cam of c.cameras || []) { const { uuid, R, t, K } = cam; cameras.set(uuid, { R, t, K }) }

  const points = new Array(N)
  let vi = 0
  for (let i = 0; i < N; i++) {
    const views = new Map()
    let viewsPx
    if (vcount && vcam && vkp) {
      const k = vcount[i]
      for (let j = 0; j < k; j++) {
        const uuid = viewUuids[vcam[vi]]
        views.set(uuid, vkp[vi])
        if (vx && vy && Number.isFinite(vx[vi])) {
          (viewsPx ??= new Map()).set(uuid, [vx[vi], vy[vi]])
        }
        vi++
      }
    }
    points[i] = {
      x: pos[i * 3], y: pos[i * 3 + 1], z: pos[i * 3 + 2],
      color: col ? [col[i * 3], col[i * 3 + 1], col[i * 3 + 2]] : undefined,
      views,
      viewsPx,
    }
  }
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

// Legacy inline shape (points embedded in JSON) — kept so a pre-binary project
// still opens. New projects always write version 2.
export function legacyDeserializeCloud(c, makeCloudId) {
  // Legacy dense clouds embedded points as objects; fold them into the flat shape.
  if (c.kind === 'dense') {
    const src = c.points || []
    const n = src.length
    const pos = new Float32Array(n * 3)
    const col = new Uint8Array(n * 3)
    for (let i = 0; i < n; i++) {
      const p = src[i]
      pos[i*3] = p.x; pos[i*3+1] = p.y; pos[i*3+2] = p.z
      const cc = p.color || [200, 200, 200]
      col[i*3] = cc[0]; col[i*3+1] = cc[1]; col[i*3+2] = cc[2]
    }
    return {
      id: c.id ?? makeCloudId(), name: c.name ?? 'Dense cloud', kind: 'dense',
      createdAt: c.createdAt ?? Date.now(), cameras: markRaw(new Map()),
      count: n, pos: markRaw(pos), col: markRaw(col),
    }
  }
  const map = new Map()
  for (const cam of c.cameras || []) { const { uuid, R, t, K } = cam; map.set(uuid, { R, t, K }) }
  return {
    id: c.id ?? makeCloudId(),
    name: c.name ?? 'Sparse cloud',
    kind: c.kind ?? 'sparse',
    createdAt: c.createdAt ?? Date.now(),
    cameras: markRaw(map),
    points: markRaw((c.points || []).map(({ x, y, z, color, views }) => ({
      x, y, z, color, views: new Map(views || []),
    }))),
  }
}

