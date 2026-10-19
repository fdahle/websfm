import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import init, { LazDecoder, decompress_points } from '../../wasm/lazcodec/lazcodec.js'
import {
  readCopcInfo, readCopcMeta, openCopcSource, parseHierarchyPage, crsFromWkt, crsFromGeoKeys, copcReadsInPlace,
} from './copc.js'
import { openCloudSource, lodFileNames, isCopcLod } from './cloudSource.js'
import { planExtract, extractPoints } from './extract.js'
import { lodToLas } from './exportStream.js'
import { lodToTiles, lasEpsg } from './tiles3d.js'
import { readLasHeader, parseLas } from '../io/las.js'
import { parseLaz } from '../io/laz.js'

// tiny.copc.laz: 24 000 points written by PDAL 2.10 writers.copc (scripts/fixtures/
// make-copc.py tiny): LAS 1.4 point format 7, EPSG:25832 as a WKT VLR, a root node and
// four children; ground (2), a building (6) and trees (5) with intensity and returns.
const bytes = new Uint8Array(readFileSync(new URL('./fixtures/tiny.copc.laz', import.meta.url)))
const source = { size: bytes.length, read: async (a, b) => bytes.slice(a, b) }
const createChunkDecoder = (vlr) => {
  const d = LazDecoder.forChunks(vlr)
  return { decode: (b, n) => d.decode_chunk(b, n), free: () => d.free() }
}

beforeAll(async () => {
  await init({ module_or_path: readFileSync(new URL('../../wasm/lazcodec/lazcodec_bg.wasm', import.meta.url)) })
})

describe('COPC file', () => {
  it('reads the info VLR and tells a COPC file from a plain LAS', () => {
    const info = readCopcInfo(readLasHeader(bytes.subarray(0, 1375)))
    expect(info.halfsize).toBeCloseTo(59.989, 2)
    expect(info.rootPage.length).toBe(5 * 32)
    expect(copcReadsInPlace(bytes.subarray(0, 1375))).toBe(true)
    expect(copcReadsInPlace(bytes.subarray(0, 1375), { minPoints: 30_000 })).toBe(false)
    const las = new Uint8Array(bytes.subarray(0, 1375))
    las.set(new TextEncoder().encode('xxxx'), 375 + 2) // the first VLR is no longer "copc"
    expect(copcReadsInPlace(las)).toBe(false)
    expect(copcReadsInPlace(new Uint8Array(10))).toBe(null)
  })

  it('makes the cloud metadata: octree, layout, CRS, statistics', async () => {
    const lod = await readCopcMeta(source, { createChunkDecoder })
    expect(isCopcLod(lod)).toBe(true)
    expect(lod).toMatchObject({ points: 24_000, nodeCount: 5, levels: 2, dataBytes: bytes.length })
    expect(lod.layout.colour).toBe(true)
    expect(lod.layout.attributes.map((a) => a.name)).toEqual(['intensity', 'classification', 'returnNumber', 'numberOfReturns'])
    expect(lod.layout.scale).toEqual([0.01, 0.01, 0.01])
    expect(lod.copc).toMatchObject({ pointFormat: 7, recordLength: 36, rgbBits: 16 })
    expect(lod.file).toMatchObject({ version: '1.4', format: 7, laz: true, copc: true, crs: 'EPSG:25832', crsName: 'ETRS89 / UTM zone 32N' })
    expect(lod.file.projection.map((v) => v.recordId)).toEqual([2112])
    // Every point is in the top two levels, so the statistics are exact.
    expect(lod.stats.sampled).toBeUndefined()
    expect(Object.keys(lod.stats.classes).sort()).toEqual(['2', '5', '6'])
    expect(Object.values(lod.stats.classes).reduce((a, b) => a + b)).toBe(24_000)
    expect(lod.stats.ranges.classification).toEqual({ min: 2, max: 6 })
    expect(lod.stats.ranges.numberOfReturns).toEqual({ min: 1, max: 2 })
    // The offset the cloud is drawn relative to: whole steps of the scale from the file's.
    const h = readLasHeader(bytes.subarray(0, 1375))
    for (let k = 0; k < 3; k++) {
      const steps = (lod.layout.offset[k] - h.offset[k]) / 0.01
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6)
    }
    expect(lodFileNames({ ...lod, dataFile: 'a.copc.laz', hierarchyFile: null })).toEqual(['a.copc.laz'])
  })

  it('reads every node: the same points as the whole file, each inside its cube', async () => {
    const lod = await readCopcMeta(source, { createChunkDecoder })
    const reader = await openCopcSource(lod, source, { createChunkDecoder })
    const whole = parseLaz(bytes, { decompress: decompress_points })
    expect(whole.count).toBe(24_000)
    const key = (x, y, z) => `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`
    const all = new Map()
    for (let i = 0; i < whole.count; i++) {
      const k = key(whole.pos[3 * i], whole.pos[3 * i + 1], whole.pos[3 * i + 2])
      all.set(k, (all.get(k) ?? 0) + 1)
    }
    let n = 0
    const classes = {}
    for (const node of reader.nodes.values()) {
      const pts = await reader.read(node, { as: 'absolute' })
      const render = await reader.read(node)
      const cube = reader.cube(node)
      for (let i = 0; i < pts.count; i++) {
        const [x, y, z] = [pts.pos[3 * i], pts.pos[3 * i + 1], pts.pos[3 * i + 2]]
        for (let a = 0; a < 3; a++) {
          expect(pts.pos[3 * i + a]).toBeGreaterThanOrEqual(cube.min[a] - 0.01)
          expect(pts.pos[3 * i + a]).toBeLessThanOrEqual(cube.min[a] + cube.size + 0.01)
          expect(render.pos[3 * i + a]).toBeCloseTo(pts.pos[3 * i + a] - lod.layout.offset[a], 3)
        }
        const k = key(x, y, z)
        expect(all.get(k)).toBeGreaterThan(0)
        all.set(k, all.get(k) - 1)
        classes[pts.attributes.classification[i]] = (classes[pts.attributes.classification[i]] ?? 0) + 1
      }
      expect(pts.col.length).toBe(3 * pts.count)
      n += pts.count
    }
    expect(n).toBe(24_000)
    expect(classes).toEqual(lod.stats.classes)
    reader.close()
  }, 30_000)

  it('serves box reads and a LAS export as a cloud source', async () => {
    const lod = { ...await readCopcMeta(source, { createChunkDecoder }), dataFile: 'x.copc.laz', hierarchyFile: null }
    const reader = await openCloudSource(JSON.parse(JSON.stringify(lod)), { data: new Blob([bytes]) }, { createChunkDecoder })
    const box = { min: [480040, 5200020, null], max: [480070, 5200050, null] }
    const plan = planExtract(reader.nodes, lod, { box })
    const cloud = await extractPoints(reader, plan, lod, { box, classes: new Set([6]) })
    // The building is 30 m × 30 m of the 120 m × 80 m survey: about 9 % of the points.
    expect(cloud.count).toBeGreaterThan(1500)
    expect(cloud.count).toBeLessThan(2700)
    for (let i = 0; i < cloud.count; i++) expect(cloud.pos[3 * i + 2]).toBeGreaterThan(9)

    const las = lodToLas(reader, lod)
    const parts = []
    for await (const p of las.parts) parts.push(p)
    const out = new Uint8Array(await new Blob([las.header(), ...parts]).arrayBuffer())
    const back = parseLas(out)
    expect(back.count).toBe(24_000)
    expect(back.col).toBeTruthy()
    // The projection record goes along.
    expect(readLasHeader(out).vlrs.some((v) => v.userId === 'LASF_Projection' && v.recordId === 2112)).toBe(true)
    reader.close()
  })
})

describe('COPC hierarchy pages', () => {
  // A root page whose child (1,0,0,0) lives in a second page, read when the root is.
  function pagedFile() {
    const entry = (key, offset, length, count) => {
      const b = new Uint8Array(32), dv = new DataView(b.buffer)
      key.forEach((v, k) => dv.setInt32(4 * k, v, true))
      dv.setBigUint64(16, BigInt(offset), true); dv.setInt32(24, length, true); dv.setInt32(28, count, true)
      return b
    }
    const file = new Uint8Array(200)
    file.set(entry([0, 0, 0, 0], 0, 0, 10), 0)
    file.set(entry([1, 0, 0, 0], 100, 64, -1), 32)
    file.set(entry([1, 1, 0, 0], 0, 0, 3), 64)
    file.set(entry([1, 0, 0, 0], 0, 0, 5), 100)
    file.set(entry([2, 0, 0, 0], 0, 0, 2), 132)
    return { size: file.length, read: async (a, b) => file.slice(a, b) }
  }
  const lod = { root: { min: [0, 0, 0], size: 8 }, spacing: 1, layout: { offset: [0, 0, 0], scale: [1, 1, 1], colour: false, attributes: [] },
    copc: { rootPage: { offset: 0, length: 96 }, lazVlr: '' } }
  const readNode = async (node) => ({ count: node.count, pos: new Float32Array(3 * node.count), col: null, attributes: {} })

  it('parses entries, with -1 for a page', () => {
    const src = pagedFile()
    return src.read(0, 96).then((b) => {
      expect(parseHierarchyPage(b).map((e) => [e.key.join(), e.count])).toEqual([['0,0,0,0', 10], ['1,0,0,0', -1], ['1,1,0,0', 3]])
    })
  })

  it('reads a page when the view reaches the node above it', async () => {
    const reader = await openCopcSource(lod, pagedFile(), { readNode, hierarchy: 'lazy' })
    expect(reader.complete).toBe(false)
    expect([...reader.nodes.keys()]).toEqual(['0-0-0-0', '1-1-0-0'])
    expect(reader.children(reader.root).map((n) => n.key.join())).toEqual(['1,1,0,0'])
    await reader.read(reader.root)
    expect(reader.complete).toBe(true)
    expect(reader.children(reader.root).map((n) => n.key.join())).toEqual(['1,0,0,0', '1,1,0,0'])
    expect(reader.children(reader.nodes.get('1-0-0-0'))[0].count).toBe(2)
  })

  it('reads every page up front for the tools', async () => {
    const reader = await openCopcSource(lod, pagedFile(), { readNode })
    expect(reader.complete).toBe(true)
    expect([...reader.nodes.values()].reduce((s, n) => s + n.count, 0)).toBe(20)
  })
})

describe('CRS from the projection records', () => {
  it('reads EPSG codes from WKT 1, WKT 2 and compound CRSs', () => {
    expect(crsFromWkt('PROJCS["ETRS89 / UTM zone 32N",GEOGCS["ETRS89",AUTHORITY["EPSG","4258"]],UNIT["metre",1],AUTHORITY["EPSG","25832"]]'))
      .toEqual({ name: 'ETRS89 / UTM zone 32N', epsg: 'EPSG:25832' })
    expect(crsFromWkt('COMPD_CS["RD New + NAP",PROJCS["Amersfoort / RD New",GEOGCS["Amersfoort",AUTHORITY["EPSG","4289"]],AUTHORITY["EPSG","28992"]],'
      + 'VERT_CS["NAP height",AUTHORITY["EPSG","5709"]],AUTHORITY["EPSG","7415"]]')).toEqual({ name: 'Amersfoort / RD New', epsg: 'EPSG:28992' })
    expect(crsFromWkt('PROJCRS["WGS 84 / UTM zone 33N",BASEGEOGCRS["WGS 84",ID["EPSG",4326]],CONVERSION["UTM zone 33N",ID["EPSG",16033]],ID["EPSG",32633]]'))
      .toEqual({ name: 'WGS 84 / UTM zone 33N', epsg: 'EPSG:32633' })
    expect(crsFromWkt('LOCAL_CS["site"]')).toBe(null)
    expect(crsFromWkt('not wkt')).toBe(null)
  })

  it('reads the horizontal code from a GeoKey directory', () => {
    const keys = new Uint16Array([1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, 32632])
    expect(crsFromGeoKeys(new Uint8Array(keys.buffer))).toEqual({ name: null, epsg: 'EPSG:32632' })
  })
})

describe('COPC as a 3D Tiles source', () => {
  it('writes one tile per non-empty node with every point, placed by its WKT record', async () => {
    const lod = { ...await readCopcMeta(source, { createChunkDecoder }), dataFile: 'x.copc.laz', hierarchyFile: null }
    const blob = new Blob([bytes])
    const reader = await openCloudSource(lod, { data: blob }, { createChunkDecoder, hierarchy: 'all' })
    const names = []
    const res = await lodToTiles(reader, lod, { origin: [0, 0, 0], emit: (name) => names.push(name) })
    const nonEmpty = [...reader.nodes.values()].filter((n) => n.count > 0).length
    expect(res.points).toBe(24_000)
    expect(res.contentTiles).toBe(nonEmpty)
    expect(names.filter((n) => n.endsWith('.glb'))).toHaveLength(nonEmpty)
    expect(lasEpsg(lod)).toBe(25832)
  })
})
