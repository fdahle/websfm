import { describe, it, expect } from 'vitest'
import { lodToTiles, memoryLodReader, exportOrigin, lasEpsg, wktEpsg } from './tiles3d.js'
import { buildLod } from './build.js'
import { openLodReader } from './reader.js'
import { buildTileTree, tilesSubject, defaultTiling } from '../products/tiles3d.js'
import { geoKeysForEpsg } from '../products/geotiff.js'

// A .glb's JSON and BIN chunks.
function parseGlb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const jsonLen = dv.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)))
  const binLen = dv.getUint32(20 + jsonLen, true)
  const bin = bytes.subarray(28 + jsonLen, 28 + jsonLen + binLen)
  return { json, bin }
}
// The positions of a glTF POINTS/TRIANGLES tile back in the tile frame (Z-up, with the
// node translation): [[x, y, z], …].
function glbPositions(bytes) {
  const { json, bin } = parseGlb(bytes)
  const acc = json.accessors[json.meshes[0].primitives[0].attributes.POSITION]
  const view = json.bufferViews[acc.bufferView]
  const f = new Float32Array(
    bin.buffer.slice(bin.byteOffset + view.byteOffset, bin.byteOffset + view.byteOffset + 12 * acc.count),
  )
  const t = json.nodes[0].translation ?? [0, 0, 0]
  const out = []
  for (let i = 0; i < acc.count; i++) {
    const x = f[3 * i] + t[0],
      y = f[3 * i + 1] + t[1],
      z = f[3 * i + 2] + t[2]
    out.push([x, -z, y]) // glTF Y-up → tile Z-up
  }
  return { json, bin, out }
}

function terrain(n) {
  let s = 7
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const pos = new Float64Array(3 * n),
    col = new Uint8Array(3 * n),
    cls = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const x = 500000 + rnd() * 400,
      y = 6000000 + rnd() * 300
    pos[3 * i] = x
    pos[3 * i + 1] = y
    pos[3 * i + 2] = 40 + 5 * Math.sin(x / 30) + rnd() * 0.05
    col[3 * i] = i & 255
    col[3 * i + 1] = (i >> 8) & 255
    col[3 * i + 2] = (i >> 16) & 255
    cls[i] = i % 3 ? 2 : 6
  }
  return { count: n, pos, col, attributes: { classification: cls } }
}

async function collect(reader, lod, opts) {
  const files = new Map()
  const res = await lodToTiles(reader, lod, {
    ...opts,
    emit: async (name, bytes) => {
      files.set(name, bytes)
    },
  })
  return { files, ...res }
}

// Every tile of a tileset JSON (and its external tilesets), with its depth and parent.
function walk(tile, files, visit, parent = null, depth = 0, dir = '') {
  const uri = tile.content?.uri
  if (uri?.endsWith('.json')) {
    const ext = JSON.parse(files.get(`${dir}${uri}`))
    walk(ext.root, files, visit, parent, depth, `${dir}${uri.slice(0, uri.lastIndexOf('/') + 1)}`)
    return
  }
  visit(tile, parent, depth, dir)
  for (const c of tile.children ?? []) walk(c, files, visit, tile, depth + 1, dir)
}
const boxMinMax = (b) => ({
  min: [b[0] - b[3], b[1] - b[7], b[2] - b[11]],
  max: [b[0] + b[3], b[1] + b[7], b[2] + b[11]],
})

describe('lodToTiles', () => {
  it('writes every point once, ADD-refined, with halving errors and nested boxes', async () => {
    const cloud = terrain(60000)
    const { reader, lod } = memoryLodReader(cloud, { leafMax: 4000 })
    const origin = exportOrigin(lod.bounds)
    const { files, tileset, external, contentTiles, points } = await collect(reader, lod, { origin, color: true })
    expect(points).toBe(60000)
    expect(external).toEqual([])
    expect(tileset.asset.version).toBe('1.1')
    expect(tileset.root.refine).toBe('ADD')
    files.set('tileset.json', JSON.stringify(tileset))
    const seen = new Uint8Array(60000)
    let tiles = 0,
      classes = 0,
      misplaced = 0,
      outside = 0
    walk(tileset.root, files, (tile, parent) => {
      tiles++
      if (parent) {
        expect(tile.geometricError).toBeLessThanOrEqual(parent.geometricError)
        const a = boxMinMax(tile.boundingVolume.box),
          b = boxMinMax(parent.boundingVolume.box)
        for (let k = 0; k < 3; k++) {
          expect(a.min[k]).toBeGreaterThanOrEqual(b.min[k] - 1e-6)
          expect(a.max[k]).toBeLessThanOrEqual(b.max[k] + 1e-6)
        }
      }
      if (!tile.children) expect(tile.geometricError).toBe(0)
      else expect(tile.geometricError).toBeGreaterThan(0)
      if (!tile.content) return
      const { json, bin, out } = glbPositions(files.get(tile.content.uri))
      const prim = json.meshes[0].primitives[0]
      expect(prim.mode).toBe(0)
      const box = boxMinMax(tile.boundingVolume.box)
      const colView = json.bufferViews[json.accessors[prim.attributes.COLOR_0].bufferView]
      const clsView = json.bufferViews[json.accessors[prim.attributes._CLASSIFICATION].bufferView]
      out.forEach((p, k) => {
        const c = bin.subarray(colView.byteOffset + 4 * k, colView.byteOffset + 4 * k + 3)
        const i = c[0] | (c[1] << 8) | (c[2] << 16)
        seen[i]++
        for (let a = 0; a < 3; a++) {
          if (!(Math.abs(p[a] + origin[a] - cloud.pos[3 * i + a]) < 1e-3)) misplaced++
          if (p[a] < box.min[a] - 1e-3 || p[a] > box.max[a] + 1e-3) outside++
        }
        if (bin[clsView.byteOffset + 4 * k] === cloud.attributes.classification[i]) classes++
      })
      expect(json.extensionsUsed).toEqual(['EXT_structural_metadata'])
      expect(prim.extensions.EXT_structural_metadata.propertyAttributes).toEqual([0])
    })
    expect(tiles).toBe(reader.nodes.size)
    expect(contentTiles).toBeGreaterThan(4)
    expect(seen.every((v) => v === 1)).toBe(true)
    expect(classes).toBe(60000)
    expect(misplaced).toBe(0)
    expect(outside).toBe(0)
    // Spacing halves per level: a child's error is half its parent's.
    const child = tileset.root.children.find((c) => c.children)
    expect(child.geometricError).toBeCloseTo(tileset.root.geometricError / 2, 9)
  })

  it('reads an octree from its files and applies the georeference', async () => {
    const cloud = terrain(30000)
    const n = cloud.count
    const source = {
      count: n,
      colour: true,
      attributes: [{ name: 'classification', type: 'uint8' }],
      bounds: (() => {
        const r = memoryLodReader({ count: n, pos: cloud.pos })
        return r.lod.bounds
      })(),
      async *batches() {
        yield { count: n, pos: cloud.pos, col: cloud.col, attributes: cloud.attributes }
      },
    }
    const chunks = []
    let size = 0
    const tmpFiles = new Map()
    const tmp = {
      async append(name, u8) {
        ;(tmpFiles.get(name) ?? tmpFiles.set(name, []).get(name)).push(u8)
      },
      async size(name) {
        return (tmpFiles.get(name) ?? []).reduce((a, b) => a + b.length, 0)
      },
      async read(name, offset, length) {
        let o = 0
        for (const b of tmpFiles.get(name)) {
          if (offset < o + b.length) return b.subarray(offset - o, offset - o + length)
          o += b.length
        }
        return new Uint8Array(0)
      },
      async remove(name) {
        tmpFiles.delete(name)
      },
    }
    const out = {
      async write(u8) {
        const at = size
        chunks.push(u8)
        size += u8.length
        return at
      },
    }
    const meta = await buildLod(source, tmp, out, { leafMax: 3000 })
    const reader = await openLodReader(meta, { data: new Blob(chunks), hierarchy: new Blob([meta.hierarchy]) })
    // A quarter turn and ×2: the tile frame's x is the source's −y.
    const sim = {
      scale: 2,
      R: [
        [0, -1, 0],
        [1, 0, 0],
        [0, 0, 1],
      ],
      t: [10, 20, 30],
    }
    const origin = exportOrigin(meta.bounds, sim)
    const { files, tileset, points } = await collect(reader, meta, { sim, origin })
    expect(points).toBe(n)
    const root = boxMinMax(tileset.root.boundingVolume.box)
    expect(root.max[0] - root.min[0]).toBeCloseTo(2 * (meta.bounds.max[1] - meta.bounds.min[1]), 0)
    expect(root.max[1] - root.min[1]).toBeCloseTo(2 * (meta.bounds.max[0] - meta.bounds.min[0]), 0)
    expect(tileset.root.geometricError).toBeCloseTo(2 * meta.spacing, 9)
    const first = glbPositions(files.get(tileset.root.content.uri)).out[0]
    expect(Math.abs(first[0])).toBeLessThan(root.max[0] - root.min[0])
  })
})

describe('lasEpsg', () => {
  const vlr = (keys) => {
    const dir = [1, 1, 0, keys.length, ...keys.flat()]
    const b = new Uint8Array(2 * dir.length)
    dir.forEach((v, i) => new DataView(b.buffer).setUint16(2 * i, v, true))
    return { userId: 'LASF_Projection', recordId: 34735, data: btoa(String.fromCharCode(...b)) }
  }
  it('reads the projected, else the geographic CRS from the GeoKey directory', () => {
    expect(lasEpsg({ file: { projection: [vlr(geoKeysForEpsg(2056, false))] } })).toBe(2056)
    expect(lasEpsg({ file: { projection: [vlr(geoKeysForEpsg(4326, true))] } })).toBe(4326)
    expect(lasEpsg({ file: { projection: [vlr(geoKeysForEpsg(null))] } })).toBe(null)
    expect(lasEpsg({ file: { projection: [] } })).toBe(null)
    expect(lasEpsg({})).toBe(null)
  })
  it('reads a LAS 1.4 WKT record: the projected CRS, not its datum or a compound CRS', () => {
    const utm =
      'PROJCS["WGS 84 / UTM zone 18N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,' +
      'AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],AUTHORITY["EPSG","4326"]],PROJECTION["Transverse_Mercator"],' +
      'UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","32618"]]'
    const rec = (s) => ({ userId: 'LASF_Projection', recordId: 2112, data: btoa(s + '\0') })
    expect(lasEpsg({ file: { projection: [rec(utm)] } })).toBe(32618)
    expect(
      lasEpsg({
        file: {
          projection: [rec(`COMPD_CS["x",${utm},VERT_CS["h",AUTHORITY["EPSG","5703"]],AUTHORITY["EPSG","9999"]]`)],
        },
      }),
    ).toBe(32618)
    expect(wktEpsg('GEOGCRS["WGS 84",DATUM["x"],ID["EPSG",4326]]')).toBe(4326)
    expect(wktEpsg('LOCAL_CS["x"]')).toBe(null)
  })
})

describe('tilesSubject / defaultTiling', () => {
  const dense = (count, extra = {}) => ({ kind: 'dense', count, pos: new Float32Array(0), ...extra })
  it('takes the selected mesh, else the selected cloud, else the first with points', () => {
    const mesh = { kind: 'mesh', count: 300000 }
    const a = dense(10),
      b = dense(0)
    expect(tilesSubject(mesh, [a]).cloud).toBe(mesh)
    expect(tilesSubject(b, [b, a]).cloud).toBe(a)
    expect(tilesSubject(null, [])).toBe(null)
  })
  it('defaults to a hierarchy for big models and whatever one tile cannot hold', () => {
    expect(defaultTiling(tilesSubject(dense(500_000), []))).toBe('single')
    expect(defaultTiling(tilesSubject(dense(5_000_000), []))).toBe('lod')
    expect(defaultTiling(tilesSubject(dense(500, { pos: null, lod: {} }), []))).toBe('lod') // streamed
    expect(defaultTiling(tilesSubject({ kind: 'mesh', count: 100_000 }, []))).toBe('single')
    expect(defaultTiling(tilesSubject({ kind: 'mesh', count: 400_000 }, []))).toBe('lod')
  })
})

describe('buildTileTree', () => {
  // A full 4-ary tree of `depth` levels below the root.
  const tree = (depth, id = 'r', d = 0) => ({
    id,
    content: true,
    min: [0, 0, 0],
    max: [1, 1, 1],
    geometricError: depth - d,
    children: d < depth ? [0, 1, 2, 3].map((c) => tree(depth, `${id}${c}`, d + 1)) : [],
  })

  it('splits a large hierarchy into external tilesets every few levels', () => {
    const { tileset, external, tiles } = buildTileTree(tree(6), {
      externalEvery: 3,
      externalAbove: 100,
      refine: 'REPLACE',
    })
    expect(tiles).toBe((4 ** 7 - 1) / 3)
    expect(external.length).toBe(4 ** 3) // level 3 starts files; level 6's tiles are leaves, not split off
    const ref = tileset.root.children[0].children[0].children[0]
    expect(ref.content.uri).toBe('tiles/r000.json')
    expect(ref.children).toBeUndefined()
    const ext = external.find((e) => e.name === 'tiles/r000.json').json
    expect(ext.root.refine).toBe('REPLACE')
    expect(ext.root.content.uri).toBe('r000.glb')
    expect(ext.root.children[0].content.uri).toBe('r0000.glb')
  })

  it('keeps a small hierarchy in one file', () => {
    const { external, tileset } = buildTileTree(tree(2))
    expect(external).toEqual([])
    expect(tileset.root.children[1].children[2].content.uri).toBe('tiles/r12.glb')
    expect(tileset.geometricError).toBeGreaterThanOrEqual(tileset.root.geometricError)
  })
})
