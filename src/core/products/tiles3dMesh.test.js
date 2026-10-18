import { describe, it, expect } from 'vitest'
import { meshToTiles, splitMesh } from './tiles3dMesh.js'

// A tile's glTF JSON and its positions back in the tile frame (Z-up, node translation added).
function glbPositions(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const jsonLen = dv.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)))
  const bin = bytes.subarray(28 + jsonLen)
  const acc = json.accessors[json.meshes[0].primitives[0].attributes.POSITION]
  const view = json.bufferViews[acc.bufferView]
  const f = new Float32Array(bin.slice(view.byteOffset, view.byteOffset + 12 * acc.count).buffer)
  const t = json.nodes[0].translation ?? [0, 0, 0]
  const out = []
  for (let i = 0; i < acc.count; i++) out.push([f[3 * i] + t[0], -(f[3 * i + 2] + t[2]), f[3 * i + 1] + t[1]])
  return { json, out }
}

// A wavy n × n terrain grid (2n² triangles), coloured; `textured` splits it into two
// atlas pieces (left / right half), each with its own vertex copies and UVs.
function terrain(n, { textured = false } = {}) {
  const nV = (n + 1) * (n + 1)
  const pos = new Float64Array(3 * nV), col = new Uint8Array(3 * nV)
  for (let y = 0; y <= n; y++) {
    for (let x = 0; x <= n; x++) {
      const v = y * (n + 1) + x
      pos[3 * v] = 300000 + x; pos[3 * v + 1] = 5000000 + y; pos[3 * v + 2] = 100 + 4 * Math.sin(x / 9) * Math.cos(y / 7)
      col[3 * v] = x & 255; col[3 * v + 1] = y & 255; col[3 * v + 2] = 99
    }
  }
  const idx = new Uint32Array(6 * n * n)
  let o = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1
      idx[o++] = a; idx[o++] = b; idx[o++] = d; idx[o++] = a; idx[o++] = d; idx[o++] = c
    }
  }
  const mesh = { nVerts: nV, count: 2 * n * n, pos, idx, col }
  if (!textured) return { mesh, texture: null }
  // Right half's triangles on page 1 with their own copies; triangles reordered so
  // each page is one run, as the texture stage writes them.
  const P = Array.from(pos), U = [], copy = new Map()
  for (let v = 0; v < nV; v++) U.push(pos[3 * v] / 1e6, pos[3 * v + 1] / 1e7)
  const left = [], right = []
  for (let t = 0; t < mesh.count; t++) {
    const tri = [idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]]
    const isRight = tri.every((v) => pos[3 * v] - 300000 >= n / 2)
    if (!isRight) { left.push(tri); continue }
    right.push(tri.map((v) => {
      if (!copy.has(v)) { copy.set(v, P.length / 3); P.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]); U.push(0.5, 0.5) }
      return copy.get(v)
    }))
  }
  const all = [...left, ...right].flat()
  const m = P.length / 3
  const C = new Uint8Array(3 * m)
  for (let v = 0; v < m; v++) C.set([1, 2, 3], 3 * v)
  return {
    mesh: { nVerts: m, count: all.length / 3, pos: Float64Array.from(P), idx: Uint32Array.from(all), col: C, uv: Float32Array.from(U) },
    texture: {
      pages: [{ type: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 1]) }, { type: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 2]) }],
      groups: [{ page: 0, start: 0, count: left.length }, { page: 1, start: left.length, count: right.length }],
    },
  }
}

async function tile(mesh, texture, opts) {
  const files = new Map()
  const origin = [300000, 5000000, 100]
  const res = await meshToTiles(mesh, texture, { origin, tileTriangles: 1500, ...opts, emit: async (name, bytes) => { files.set(name, bytes) } })
  return { files, origin, ...res }
}

// Every tile of the (single-file) tileset with its parent.
function tilesOf(tileset) {
  const out = []
  const walk = (t, parent) => { out.push({ t, parent }); for (const c of t.children ?? []) walk(c, t) }
  walk(tileset.root, null)
  return out
}
const key = (p) => `${Math.round(p[0])},${Math.round(p[1])}`

describe('meshToTiles', () => {
  it('splits a terrain as a quadtree, REPLACE-refined, with the leaves holding every triangle once', async () => {
    const { mesh } = terrain(60)
    const { files, tileset, levels } = await tile(mesh, null)
    expect(tileset.root.refine).toBe('REPLACE')
    expect(levels).toBeGreaterThan(2)
    const all = tilesOf(tileset)
    let leafTris = 0
    for (const { t, parent } of all) {
      const { json } = glbPositions(files.get(t.content.uri))
      const prim = json.meshes[0].primitives[0]
      expect(prim.mode).toBe(4)
      const tris = json.accessors[prim.indices].count / 3
      if (!t.children) { leafTris += tris; expect(t.geometricError).toBe(0) } else {
        expect(tris).toBeLessThanOrEqual(1500 * 1.5)
        expect(t.geometricError).toBeGreaterThan(0)
        // Flat terrain splits in x and y only: four children at most.
        expect(t.children.length).toBeLessThanOrEqual(4)
      }
      if (parent) expect(t.geometricError).toBeLessThanOrEqual(parent.geometricError)
    }
    expect(leafTris).toBe(mesh.count)
  })

  it('locks tile borders: a tile has every vertex its cell shares with the rest, unmoved', async () => {
    const { mesh } = terrain(60)
    const { files, tileset } = await tile(mesh, null)
    const all = tilesOf(tileset)
    // The leaves' vertices, per leaf id: what the cells are made of.
    // Grid vertices sit on whole x, y: keyed by those, with their height (Float32
    // around different tile centres rounds a little differently per tile).
    const heights = (uri) => new Map(glbPositions(files.get(uri)).out.map((p) => [key(p), p[2]]))
    const leafVerts = new Map()
    for (const { t } of all) if (!t.children) leafVerts.set(t.content.uri, heights(t.content.uri))
    let checked = 0, missing = 0
    for (const { t } of all) {
      if (!t.children) continue
      const id = t.content.uri.slice('tiles/'.length, -'.glb'.length)
      const inside = new Map(), outside = new Set()
      for (const [uri, verts] of leafVerts) {
        const leafId = uri.slice('tiles/'.length, -'.glb'.length)
        for (const [v, z] of verts) if (leafId.startsWith(id)) inside.set(v, z); else outside.add(v)
      }
      const own = heights(t.content.uri)
      for (const [v, z] of inside) {
        if (!outside.has(v)) continue
        checked++
        if (!(Math.abs(own.get(v) - z) < 1e-4)) missing++
      }
    }
    expect(checked).toBeGreaterThan(100)
    expect(missing).toBe(0)
  })

  it('keeps the texture on the leaves, with the pages written once beside them', async () => {
    const { mesh, texture } = terrain(40, { textured: true })
    const { files, tileset, textured } = await tile(mesh, texture)
    expect(textured).toBe(true)
    expect(files.get('tiles/atlas-0.jpg')).toEqual(texture.pages[0].bytes)
    expect(files.get('tiles/atlas-1.jpg')).toEqual(texture.pages[1].bytes)
    let leaves = 0
    for (const { t } of tilesOf(tileset)) {
      const { json } = glbPositions(files.get(t.content.uri))
      if (t.children) {
        expect(json.images).toBeUndefined()
        expect(json.meshes[0].primitives[0].attributes.COLOR_0).toBeDefined()
        continue
      }
      leaves++
      expect(json.images.every((im) => /^atlas-[01]\.jpg$/.test(im.uri))).toBe(true)
      expect(json.meshes[0].primitives.every((p) => p.attributes.TEXCOORD_0 !== undefined)).toBe(true)
      expect(json.meshes[0].primitives.length).toBe(json.images.length)
    }
    expect(leaves).toBeGreaterThan(1)
  })
})

describe('splitMesh', () => {
  it('splits an object in all three axes and a flat one in two', () => {
    const n = 4000
    const cube = new Float64Array(3 * n), flat = new Float64Array(3 * n)
    for (let t = 0; t < n; t++) {
      for (let k = 0; k < 3; k++) cube[3 * t + k] = ((t * [7, 13, 29][k]) % 101) / 101
      flat[3 * t] = (t * 7 % 101) / 101; flat[3 * t + 1] = (t * 13 % 101) / 101; flat[3 * t + 2] = 0.001 * (t % 3)
    }
    const all = Uint32Array.from({ length: n }, (_, t) => t)
    const box = { min: [0, 0, 0], max: [1, 1, 1] }
    expect(splitMesh(cube, all, box, { tileTriangles: 1000 }).children.length).toBe(8)
    expect(splitMesh(flat, all, { min: [0, 0, 0], max: [1, 1, 0.002] }, { tileTriangles: 1000 }).children.length).toBe(4)
  })
})
