// A mesh split into blocks for the worker pool, as Decimate runs it on a large mesh: each
// worker decimates one block with the vertices it shares with another block LOCKED
// (meshDecimate.js `locked`: never moved or removed), so the blocks still meet vertex
// for vertex when joined; one last pass over the joined mesh then decimates across the
// seams to the target. Pure.
//
// The blocks stop short of the target (BLOCK_HEADROOM more triangles), so the last pass
// has work: it takes the cheapest collapses of the whole mesh, which include the seams'
// short edges, left at full density by the locks. Measured against one pass over the
// whole mesh (a 2 M and a 3.9 M triangle terrain, a 2 M triangle sphere; error = RMS
// and largest distance of the input's vertices to the result): the same or slightly
// smaller error, seams at 1.03–1.09× the density elsewhere, 4–4.5× faster on 7 workers.

/** Triangles a block keeps above the target, for the last pass across the seams. */
export const BLOCK_HEADROOM = 0.2

/**
 * Blocks of about equal triangle count, cut across the longest side of the mesh's box at
 * quantiles of the triangles' centroids. → { parts: [{ tris: Uint32Array }],
 * shared: Uint8Array (per vertex, 1 = in triangles of two blocks or more) }
 */
export function planMeshBlocks(mesh, blocks) {
  const { pos, idx } = mesh
  const nT = Math.floor(idx.length / 3)
  const nV = Math.floor(pos.length / 3)
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity]
  for (let v = 0; v < nV; v++)
    for (let k = 0; k < 3; k++) {
      const x = pos[3 * v + k]
      if (x < lo[k]) lo[k] = x
      if (x > hi[k]) hi[k] = x
    }
  const ext = [0, 1, 2].map((k) => hi[k] - lo[k])
  const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2
  const m = Math.max(1, Math.min(Math.floor(blocks) || 1, nT))
  const centre = (t) =>
    (pos[3 * idx[3 * t] + axis] + pos[3 * idx[3 * t + 1] + axis] + pos[3 * idx[3 * t + 2] + axis]) / 3
  const step = Math.max(1, Math.floor(nT / 200_000))
  const sample = []
  for (let t = 0; t < nT; t += step) sample.push(centre(t))
  sample.sort((a, b) => a - b)
  const cuts = []
  for (let s = 1; s < m; s++) cuts.push(sample[Math.floor((s * sample.length) / m)])
  const blockOf = (v) => {
    let a = 0,
      b = cuts.length
    while (a < b) {
      const c = (a + b) >> 1
      if (cuts[c] <= v) a = c + 1
      else b = c
    }
    return a
  }
  const of = new Uint16Array(nT)
  const count = new Uint32Array(m)
  // Per vertex: the block of its first triangle, and whether another block has it too.
  const first = new Int32Array(nV).fill(-1)
  const shared = new Uint8Array(nV)
  for (let t = 0; t < nT; t++) {
    const b = blockOf(centre(t))
    of[t] = b
    count[b]++
    for (let c = 0; c < 3; c++) {
      const v = idx[3 * t + c]
      if (first[v] < 0) first[v] = b
      else if (first[v] !== b) shared[v] = 1
    }
  }
  const parts = Array.from({ length: m }, (_, b) => ({ tris: new Uint32Array(count[b]) }))
  const fill = new Uint32Array(m)
  for (let t = 0; t < nT; t++) parts[of[t]].tris[fill[of[t]]++] = t
  return { parts, shared }
}

/**
 * The triangles `tris` of a mesh as a mesh of their own, with its vertices' indices in
 * the whole mesh (`vertex`) and the shared ones locked. Positions as Float64.
 * → { mesh: { nVerts, count, pos, idx, col }, vertex: Uint32Array, locked: Uint8Array }
 */
export function blockMesh(mesh, tris, shared) {
  const nV = Math.floor(mesh.pos.length / 3)
  const local = new Int32Array(nV).fill(-1)
  const idx = new Uint32Array(3 * tris.length)
  let n = 0
  for (let j = 0; j < tris.length; j++)
    for (let c = 0; c < 3; c++) {
      const v = mesh.idx[3 * tris[j] + c]
      if (local[v] < 0) local[v] = n++
      idx[3 * j + c] = local[v]
    }
  const vertex = new Uint32Array(n)
  for (let v = 0; v < nV; v++) if (local[v] >= 0) vertex[local[v]] = v
  const pos = new Float64Array(3 * n)
  const col = mesh.col ? new Uint8Array(3 * n) : null
  const locked = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const v = vertex[i]
    for (let k = 0; k < 3; k++) {
      pos[3 * i + k] = mesh.pos[3 * v + k]
      if (col) col[3 * i + k] = mesh.col[3 * v + k]
    }
    locked[i] = shared[v]
  }
  return { mesh: { nVerts: n, count: tris.length, pos, idx, col }, vertex, locked }
}

/**
 * Decimated blocks joined into one mesh: a locked (shared) vertex is one vertex,
 * whichever blocks hold it; every other vertex is its block's own. `blocks`: per block
 * { mesh (decimated), vertex (per its vertex, the whole mesh's index it came from:
 * blockMesh's `vertex` through decimateMesh's `sourceVertex`) }.
 * → { nVerts, count, pos: Float64Array, idx: Uint32Array, col }
 */
export function joinBlocks(blocks, shared) {
  let nV = 0,
    nT = 0
  for (const b of blocks) {
    nV += b.mesh.nVerts
    nT += b.mesh.count
  }
  const withCol = blocks.every((b) => b.mesh.col)
  const pos = new Float64Array(3 * nV)
  const col = withCol ? new Uint8Array(3 * nV) : null
  const idx = new Uint32Array(3 * nT)
  const joined = new Map() // shared vertex → its index in the joined mesh
  let v = 0,
    t = 0
  for (const b of blocks) {
    const map = new Uint32Array(b.mesh.nVerts)
    for (let i = 0; i < b.mesh.nVerts; i++) {
      const g = b.vertex[i]
      if (shared[g]) {
        const at = joined.get(g)
        if (at !== undefined) {
          map[i] = at
          continue
        }
        joined.set(g, v)
      }
      map[i] = v
      for (let k = 0; k < 3; k++) {
        pos[3 * v + k] = b.mesh.pos[3 * i + k]
        if (col) col[3 * v + k] = b.mesh.col[3 * i + k]
      }
      v++
    }
    for (let j = 0; j < 3 * b.mesh.count; j++) idx[t++] = map[b.mesh.idx[j]]
  }
  return {
    nVerts: v,
    count: nT,
    pos: pos.slice(0, 3 * v),
    idx,
    col: col ? col.slice(0, 3 * v) : null,
  }
}
