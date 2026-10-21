// A mesh as a hierarchical 3D Tiles tileset: split in space, decimated per level.
// Pure; the caller places the result (core/products/tiles3d.js) and writes the files.
//
// - **Split.** The mesh's box is halved along every axis at least half as long as its
//   longest (a quadtree for terrain, an octree for an object), recursively, until a
//   cell holds at most `tileTriangles` triangles. A triangle goes to the cell holding
//   its centroid: none is cut, so neighbouring cells share the vertices along their
//   (jagged) border.
// - **Leaves** are the mesh itself, untouched; a textured mesh's leaves keep their
//   texture (the atlas pages are written once, beside the tiles, and every leaf
//   refers to the pages it uses).
// - **Parents, bottom-up.** A parent is its children's tiles joined and decimated
//   (meshDecimate.js) back to `tileTriangles`, with every vertex on the parent's own
//   border LOCKED: it is in the decimated mesh, unmoved. The vertices along a cell
//   border are then the same at every level, so a tile meets its neighbour vertex for
//   vertex whichever level either is drawn at (no cracks), and decimation of the
//   inside is free. A decimated tile has vertex colours, no texture: collapsing edges
//   moves vertices, which the texture's per-photo UVs cannot follow.
// - **REPLACE refinement**: a parent is a coarser version of its children's surface.
// - **geometricError** of a parent: the larger of (a) how far its surface may stand
//   from the original (the decimation's largest collapse error, plus its children's),
//   and (b) its triangles' mean edge length, the size of the detail (colour and shape)
//   it can show. 0 for a leaf.

import { decimateMesh } from './meshDecimate.js'
import { coincidentVertices } from './meshEdit.js'
import { meshToGlbParts } from './exporters.js'
import { buildTileTree } from './tiles3d.js'
import { EXPORT_DEFAULTS } from '../defaults.user.js'

const TILE_TRIANGLES = EXPORT_DEFAULTS.tileTriangles
const MAX_DEPTH = 16

// Concatenate parts (meshToGlbParts) into one Uint8Array.
function joinParts(parts) {
  const list = [...parts]
  const out = new Uint8Array(list.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of list) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/**
 * The cell tree over triangle centroids. → root { id, depth, tris: Uint32Array, children: [...] }
 * (internal cells keep their triangles too: they are what the parent's border is
 * judged against).
 */
export function splitMesh(cx, triIndices, box, { tileTriangles = TILE_TRIANGLES, id = 'r', depth = 0 } = {}) {
  const cell = { id, depth, tris: triIndices, children: [] }
  if (triIndices.length <= tileTriangles || depth >= MAX_DEPTH) return cell
  const ext = [0, 1, 2].map((k) => box.max[k] - box.min[k])
  const longest = Math.max(...ext)
  const axes = [0, 1, 2].filter((k) => ext[k] >= longest / 2 && ext[k] > 0)
  if (!axes.length) return cell
  const mid = [0, 1, 2].map((k) => (box.min[k] + box.max[k]) / 2)
  const parts = new Map() // octant code → indices
  const code = new Uint8Array(triIndices.length)
  const counts = new Int32Array(8)
  for (let j = 0; j < triIndices.length; j++) {
    const t = triIndices[j]
    let c = 0
    for (let a = 0; a < axes.length; a++) if (cx[3 * t + axes[a]] >= mid[axes[a]]) c |= 1 << a
    code[j] = c
    counts[c]++
  }
  for (let c = 0; c < 8; c++) if (counts[c]) parts.set(c, { idx: new Uint32Array(counts[c]), fill: 0 })
  for (let j = 0; j < triIndices.length; j++) {
    const p = parts.get(code[j])
    p.idx[p.fill++] = triIndices[j]
  }
  for (const [c, { idx }] of [...parts.entries()].sort((a, b) => a[0] - b[0])) {
    const sub = { min: [...box.min], max: [...box.max] }
    axes.forEach((k, a) => {
      if (c & (1 << a)) sub.min[k] = mid[k]
      else sub.max[k] = mid[k]
    })
    cell.children.push(splitMesh(cx, idx, sub, { tileTriangles, id: `${id}${c}`, depth: depth + 1 }))
  }
  return cell
}

/**
 * Tile a mesh. `mesh` { nVerts, count, pos (Float64, export frame), idx, col?, uv? };
 * `texture` { pages: [{ bytes, type }], groups: [{ page, start, count }] } with `mesh.uv`.
 * opts { origin, color, transform, tileTriangles, emit(name, bytes) (awaited), onLog,
 * onProgress(done, total) } → { tileset, external, tiles, levels, bytes, textured }
 */
export async function meshToTiles(
  mesh,
  texture,
  { origin = [0, 0, 0], color = true, transform = null, tileTriangles = TILE_TRIANGLES, emit, onLog, onProgress } = {},
) {
  const nV = mesh.nVerts ?? mesh.pos.length / 3
  const nT = mesh.count ?? mesh.idx.length / 3
  const textured = !!(texture?.pages?.length && texture.groups?.length && mesh.uv)

  // The surface: a textured mesh's per-chart copies joined (the copies share a
  // position bit for bit), so cells, borders and decimation see one vertex per point.
  const { id: sid, first, m } = textured ? coincidentVertices(mesh.pos, nV) : { id: null, first: null, m: nV }
  const S = new Float64Array(3 * m)
  for (let r = 0; r < m; r++) {
    const v = first ? first[r] : r
    for (let k = 0; k < 3; k++) S[3 * r + k] = mesh.pos[3 * v + k] - origin[k]
  }
  const SC = mesh.col ? new Uint8Array(3 * m) : null
  if (SC)
    for (let r = 0; r < m; r++) {
      const v = first ? first[r] : r
      for (let k = 0; k < 3; k++) SC[3 * r + k] = mesh.col[3 * v + k]
    }
  const sIdx = new Uint32Array(3 * nT)
  for (let i = 0; i < 3 * nT; i++) sIdx[i] = sid ? sid[mesh.idx[i]] : mesh.idx[i]

  // Centroids, bounds, and every surface vertex's triangle count (for borders).
  const cx = new Float64Array(3 * nT)
  const degree = new Uint32Array(m)
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  for (let t = 0; t < nT; t++) {
    for (let c = 0; c < 3; c++) {
      const v = sIdx[3 * t + c]
      degree[v]++
      for (let k = 0; k < 3; k++) cx[3 * t + k] += S[3 * v + k] / 3
    }
    for (let k = 0; k < 3; k++) {
      if (cx[3 * t + k] < box.min[k]) box.min[k] = cx[3 * t + k]
      if (cx[3 * t + k] > box.max[k]) box.max[k] = cx[3 * t + k]
    }
  }
  const tree = splitMesh(
    cx,
    Uint32Array.from({ length: nT }, (_, t) => t),
    box,
    { tileTriangles },
  )

  // A textured mesh's page per triangle, and its pages beside the tiles.
  let triPage = null
  if (textured) {
    triPage = new Uint16Array(nT)
    for (const g of texture.groups) triPage.fill(g.page, g.start, g.start + g.count)
    for (let k = 0; k < texture.pages.length; k++) {
      await emit(`tiles/${pageName(texture.pages[k], k)}`, texture.pages[k].bytes)
    }
  }

  // Scratch for borders: triangles of the current cell counted per surface vertex.
  const inside = new Uint32Array(m)
  const borderOf = (tris) => {
    const touched = []
    for (const t of tris)
      for (let c = 0; c < 3; c++) {
        const v = sIdx[3 * t + c]
        if (!inside[v]++) touched.push(v)
      }
    const border = new Set()
    for (const v of touched) {
      if (inside[v] < degree[v]) border.add(v)
      inside[v] = 0
    }
    return border
  }

  let bytes = 0,
    done = 0,
    levels = 0
  const write = async (cell, part) => {
    // Bounds and centre of the tile's vertices (tile frame); the glTF holds them
    // around the centre.
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < part.nVerts; i++) {
      for (let k = 0; k < 3; k++) {
        const v = part.pos[3 * i + k]
        if (v < min[k]) min[k] = v
        if (v > max[k]) max[k] = v
      }
    }
    const centre = [0, 1, 2].map((k) => (min[k] + max[k]) / 2)
    const glb = joinParts(
      meshToGlbParts(part, { color, texture: part.texture ?? null, origin: centre, translation: centre, yUp: true }),
    )
    await emit(`tiles/${cell.id}.glb`, glb)
    bytes += glb.length
    return { min, max }
  }

  // Bottom-up. → the tile node (for buildTileTree) and the tile's surface for its
  // parent: { pos, idx, col, gid (surface vertex ids) }.
  async function build(cell) {
    levels = Math.max(levels, cell.depth + 1)
    if (!cell.children.length) {
      const part = textured ? texturedLeaf(cell.tris) : surfacePart(cell.tris)
      const b = await write(cell, part)
      done += cell.tris.length
      onProgress?.(done, nT)
      return {
        node: { id: cell.id, content: true, ...b, geometricError: 0, children: [] },
        surface: surfacePart(cell.tris),
        err: 0,
      }
    }
    const kids = []
    for (const c of cell.children) kids.push(await build(c))
    // The children's surfaces, welded on their shared (locked) vertices.
    const local = new Map() // gid → index in the joined mesh
    const gids = [],
      pos = [],
      col = SC ? [] : null,
      idx = []
    for (const { surface } of kids) {
      const map = new Int32Array(surface.nVerts)
      for (let i = 0; i < surface.nVerts; i++) {
        const g = surface.gid[i]
        let j = local.get(g)
        if (j === undefined) {
          j = gids.length
          local.set(g, j)
          gids.push(g)
          pos.push(surface.pos[3 * i], surface.pos[3 * i + 1], surface.pos[3 * i + 2])
          if (col) col.push(surface.col[3 * i], surface.col[3 * i + 1], surface.col[3 * i + 2])
        }
        map[i] = j
      }
      for (let i = 0; i < surface.idx.length; i++) idx.push(map[surface.idx[i]])
    }
    const joined = {
      nVerts: gids.length,
      count: idx.length / 3,
      pos: Float64Array.from(pos),
      idx: Uint32Array.from(idx),
      col: col ? Uint8Array.from(col) : null,
    }
    const border = borderOf(cell.tris)
    const locked = new Uint8Array(joined.nVerts)
    for (let i = 0; i < joined.nVerts; i++) if (border.has(gids[i])) locked[i] = 1
    const target = Math.min(tileTriangles, joined.count)
    const { mesh: dec, stats, sourceVertex } = decimateMesh(joined, { targetTriangles: target, locked })
    // A locked vertex is written from the surface itself (bit-identical in every tile).
    const gid = new Int32Array(dec.nVerts)
    for (let r = 0; r < dec.nVerts; r++) {
      const s = sourceVertex[r]
      gid[r] = gids[s]
      if (locked[s]) for (let k = 0; k < 3; k++) dec.pos[3 * r + k] = S[3 * gids[s] + k]
    }
    if (dec.count > target * 1.5) {
      onLog?.(
        `3D Tiles: tile ${cell.id} kept ${dec.count.toLocaleString()} triangles (target ${target.toLocaleString()}): ` +
          `${border.size.toLocaleString()} border vertices are locked`,
        'debug',
        'Export',
      )
    }
    const err = stats.maxError + Math.max(...kids.map((k) => k.err))
    const b = await write(cell, dec)
    const geometricError = Math.max(err, meanEdge(dec))
    return {
      node: { id: cell.id, content: true, ...b, geometricError, children: kids.map((k) => k.node) },
      surface: { ...dec, gid },
      err,
    }
  }

  // A leaf's surface triangles, compacted, with their surface ids.
  function surfacePart(tris) {
    const map = new Map(),
      gid = [],
      idx = new Uint32Array(3 * tris.length)
    tris.forEach((t, j) => {
      for (let c = 0; c < 3; c++) {
        const v = sIdx[3 * t + c]
        let r = map.get(v)
        if (r === undefined) {
          r = gid.length
          map.set(v, r)
          gid.push(v)
        }
        idx[3 * j + c] = r
      }
    })
    const n = gid.length,
      pos = new Float64Array(3 * n),
      col = SC ? new Uint8Array(3 * n) : null
    for (let r = 0; r < n; r++)
      for (let k = 0; k < 3; k++) {
        pos[3 * r + k] = S[3 * gid[r] + k]
        if (col) col[3 * r + k] = SC[3 * gid[r] + k]
      }
    return { nVerts: n, count: tris.length, pos, idx, col, gid: Int32Array.from(gid) }
  }

  // A textured leaf: its original triangles (with their UV copies), in page order,
  // with the pages it uses.
  function texturedLeaf(tris) {
    const order = Uint32Array.from(tris).sort((a, b) => triPage[a] - triPage[b] || a - b)
    const map = new Map(),
      verts = []
    const idx = new Uint32Array(3 * order.length)
    const groups = [],
      pageIndex = new Map()
    order.forEach((t, j) => {
      const p = triPage[t]
      if (!pageIndex.has(p)) {
        pageIndex.set(p, pageIndex.size)
        groups.push({ page: pageIndex.get(p), start: j, count: 0 })
      }
      groups[groups.length - 1].count++
      for (let c = 0; c < 3; c++) {
        const v = mesh.idx[3 * t + c]
        let r = map.get(v)
        if (r === undefined) {
          r = verts.length
          map.set(v, r)
          verts.push(v)
        }
        idx[3 * j + c] = r
      }
    })
    const n = verts.length,
      pos = new Float64Array(3 * n),
      uv = new Float32Array(2 * n)
    for (let r = 0; r < n; r++) {
      const v = verts[r]
      for (let k = 0; k < 3; k++) pos[3 * r + k] = mesh.pos[3 * v + k] - origin[k]
      uv[2 * r] = mesh.uv[2 * v]
      uv[2 * r + 1] = mesh.uv[2 * v + 1]
    }
    const pages = [...pageIndex.keys()].map((p) => ({
      uri: pageName(texture.pages[p], p),
      type: texture.pages[p].type,
    }))
    return { nVerts: n, count: order.length, pos, idx, uv, texture: { pages, groups } }
  }

  const { node } = await build(tree)
  const { tileset, external, tiles } = buildTileTree(node, { transform, refine: 'REPLACE' })
  return { tileset, external, tiles, levels, bytes, textured }
}

const pageName = (page, k) => `atlas-${k}.${page.type === 'image/png' ? 'png' : 'jpg'}`

// Mean edge length of a mesh's triangles.
function meanEdge(mesh) {
  let s = 0,
    n = 0
  const P = mesh.pos
  for (let t = 0; t < mesh.count; t++) {
    for (let c = 0; c < 3; c++) {
      const a = mesh.idx[3 * t + c],
        b = mesh.idx[3 * t + ((c + 1) % 3)]
      s += Math.hypot(P[3 * a] - P[3 * b], P[3 * a + 1] - P[3 * b + 1], P[3 * a + 2] - P[3 * b + 2])
      n++
    }
  }
  return n ? s / n : 0
}
