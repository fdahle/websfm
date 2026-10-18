// A cloud's level-of-detail octree as a 3D Tiles 1.1 tileset (plan-lod ▸ L5 exports;
// core/products/tiles3d.js has the placement and the glTF packing). Pure over a reader
// (core/lod/reader.js, or memoryLodReader below): nodes are read one at a time and
// each becomes one tile, handed to `emit` as soon as it is written, so a streamed
// cloud's tileset is never in memory whole.
//
// - **One tile per octree node**, glTF POINTS content (`tiles/<level>-<x>-<y>-<z>.glb`):
//   positions Float32 relative to the node's own centre, which goes back as the glTF
//   node's translation; colour; classification and intensity as metadata.
// - **ADD refinement.** A node keeps a grid subsample of its cube and passes the rest
//   on, so every point is in exactly one node: a child adds points to its parent's,
//   it does not replace them.
// - **geometricError = the node's spacing** (the octree's grid cell, halving per
//   level), in the export frame's units; 0 for a node without children. That is the
//   gap a viewer sees when it draws the node without its children, and the size
//   CesiumJS's point attenuation gives a point of that tile.
// - Boxes are the nodes' points' bounds in the export frame, not the octree cubes: a
//   georeference rotates the cube, and the points rarely fill it.
//
// The export frame: positions go through `sim` (the georeference, or null), then the
// tileset's `origin` is subtracted, so the tile frame is the one the root transform
// (ecefTransformFromProbes) places.

import { applySimilarity } from '../products/georef.js'
import { cloudToGlbPoints, buildTileTree, POINT_PROPERTIES } from '../products/tiles3d.js'
import { buildOctree, rootCube, keyString, childKey, GRID } from './octree.js'

export const tileId = ([l, x, y, z]) => `${l}-${x}-${y}-${z}`

/**
 * The export frame's centre of a cloud's bounds { min, max } (the tileset origin).
 * With a georeference, the transformed centre of the source bounds.
 */
export function exportOrigin(bounds, sim = null) {
  const c = [0, 1, 2].map((k) => (bounds.min[k] + bounds.max[k]) / 2)
  return sim ? applySimilarity(sim, c) : c
}

/**
 * The EPSG code a streamed LAS names (its LASF_Projection records, kept as
 * `lod.file.projection`): from the GeoKey directory (34735), else the OGC WKT (2112,
 * LAS 1.4) — the projected CRS, else the geographic one; null when it names none.
 */
export function lasEpsg(lod) {
  const records = lod?.file?.projection ?? []
  const bytesOf = (v) => Uint8Array.from(atob(v.data), (c) => c.charCodeAt(0))
  const keys = records.find((v) => v.recordId === 34735)
  const fromKeys = keys ? geoKeyEpsg(bytesOf(keys)) : null
  if (fromKeys) return fromKeys
  const wkt = records.find((v) => v.recordId === 2112)
  return wkt ? wktEpsg(new TextDecoder().decode(bytesOf(wkt)).replace(/\0+$/, '')) : null
}

// The EPSG code of a WKT CRS: the authority of its projected CRS, else of its
// geographic one (each is the last EPSG authority inside that CRS's brackets; a
// compound CRS's own authority, after its vertical part, is skipped).
export function wktEpsg(wkt) {
  for (const re of [/\b(PROJCS|PROJCRS|PROJECTEDCRS)\[/, /\b(GEOGCS|GEOGCRS|GEODCRS|GEOGRAPHICCRS)\[/]) {
    const m = re.exec(wkt)
    if (!m) continue
    let depth = 0, end = wkt.length
    for (let i = m.index + m[0].length - 1; i < wkt.length; i++) {
      if (wkt[i] === '[') depth++
      else if (wkt[i] === ']' && --depth === 0) { end = i; break }
    }
    const codes = [...wkt.slice(m.index, end).matchAll(/(?:AUTHORITY|ID)\["EPSG",\s*"?(\d+)"?\]/g)]
    if (codes.length) return Number(codes[codes.length - 1][1])
  }
  return null
}

function geoKeyEpsg(bytes) {
  const dv = new DataView(bytes.buffer)
  const keys = {}
  const n = bytes.length >= 8 ? dv.getUint16(6, true) : 0
  for (let k = 0; k < n && 8 + 8 * k + 8 <= bytes.length; k++) {
    const o = 8 + 8 * k
    if (dv.getUint16(o + 2, true) === 0) keys[dv.getUint16(o, true)] = dv.getUint16(o + 6, true) // value in place
  }
  const code = keys[3072] || keys[2048]
  return code && code !== 32767 ? code : null
}

/**
 * The tiles of an octree. `reader` { nodes: Map keyString → { key, count }, read(node,
 * { as: 'absolute' }) }, `lod` { spacing, layout } (the octree's metadata).
 * opts { sim, origin, color, transform, emit(name, bytes) (awaited), onProgress(done, total) }
 * → { tileset, external: [{ name, json }], tiles, contentTiles, points, bytes }
 */
export async function lodToTiles(reader, lod, { sim = null, origin = [0, 0, 0], color = true, transform = null,
  emit, onProgress } = {}) {
  const unit = sim?.scale ?? 1 // spacing in the octree's units → the export frame's
  const properties = (lod.layout.attributes ?? []).map((a) => a.name).filter((n) => POINT_PROPERTIES[n])
  const tiles = new Map() // keyString → tree node
  let done = 0, bytes = 0, contentTiles = 0
  const total = [...reader.nodes.values()].reduce((s, n) => s + n.count, 0)
  for (const node of reader.nodes.values()) {
    const t = { id: tileId(node.key), key: node.key, content: false, children: [] }
    tiles.set(keyString(node.key), t)
    if (!node.count) continue
    const pts = await reader.read(node, { as: 'absolute' })
    const n = pts.count
    // Into the tile frame, Float64, with the node's bounds.
    const pos = new Float64Array(3 * n)
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    const p = [0, 0, 0]
    for (let i = 0; i < n; i++) {
      p[0] = pts.pos[3 * i]; p[1] = pts.pos[3 * i + 1]; p[2] = pts.pos[3 * i + 2]
      const q = sim ? applySimilarity(sim, p) : p
      for (let k = 0; k < 3; k++) {
        const v = pos[3 * i + k] = q[k] - origin[k]
        if (v < min[k]) min[k] = v
        if (v > max[k]) max[k] = v
      }
    }
    const centre = [0, 1, 2].map((k) => (min[k] + max[k]) / 2)
    const glb = cloudToGlbPoints({ count: n, pos, col: pts.col, attributes: pts.attributes },
      { origin: centre, translation: centre, color, properties })
    await emit(`tiles/${t.id}.glb`, glb)
    Object.assign(t, { content: true, min, max })
    bytes += glb.length
    contentTiles++
    done += n
    onProgress?.(done, total)
  }
  // The tree, and each tile's error: its spacing when it has children to refine into.
  for (const t of tiles.values()) {
    for (let o = 0; o < 8; o++) {
      const c = tiles.get(keyString(childKey(t.key, o)))
      if (c) t.children.push(c)
    }
    t.geometricError = t.children.length ? (lod.spacing / 2 ** t.key[0]) * unit : 0
  }
  const root = tiles.get('0-0-0-0')
  if (!root) throw new Error('the octree has no root node')
  const { tileset, external, tiles: count } = buildTileTree(root, { transform, refine: 'ADD' })
  return { tileset, external, tiles: count, contentTiles, points: done, bytes }
}

/**
 * An in-memory octree of a resident cloud { count, pos (Float64 3n), col?, attributes? },
 * shaped like core/lod/reader.js for lodToTiles: a cloud without an octree of its own
 * (under LOD_MIN_POINTS, or no saved project) is tiled the same way.
 * → { reader, lod: { spacing, layout, bounds } }
 */
export function memoryLodReader(cloud, opts = {}) {
  const n = cloud.count
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = cloud.pos[3 * i + k]
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
  }
  if (!n) { min.fill(0); max.fill(0) }
  const root = rootCube(min, max)
  const built = buildOctree({ pos: cloud.pos, count: n }, root, opts)
  // Parents before children, as the files' hierarchy is.
  const nodes = new Map([...built.entries()].sort(([, a], [, b]) => a.key[0] - b.key[0])
    .map(([s, node]) => [s, { key: node.key, count: node.idx.length, idx: node.idx }]))
  const attributes = Object.entries(cloud.attributes ?? {})
  const reader = {
    nodes,
    async read(node) {
      const { idx } = node, m = idx.length
      const pos = new Float64Array(3 * m), col = cloud.col ? new Uint8Array(3 * m) : null
      for (let j = 0; j < m; j++) {
        const i = idx[j]
        for (let k = 0; k < 3; k++) {
          pos[3 * j + k] = cloud.pos[3 * i + k]
          if (col) col[3 * j + k] = cloud.col[3 * i + k]
        }
      }
      const attrs = {}
      for (const [name, arr] of attributes) {
        const out = new arr.constructor(m)
        for (let j = 0; j < m; j++) out[j] = arr[idx[j]]
        attrs[name] = out
      }
      return { count: m, pos, col, attributes: attrs }
    },
  }
  const layout = { attributes: attributes.map(([name]) => ({ name })) }
  return { reader, lod: { spacing: root.size / (opts.grid ?? GRID), layout, bounds: { min, max } } }
}
