import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildLod } from '../../core/lod/build.js'
import { openLodReader } from '../../core/lod/reader.js'
import { createLodLayer } from './lodLayer.js'

// A real octree (out-of-core build into memory) of a 1 km terrain, read through Blobs.
async function terrainLod(n) {
  let s = 2
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const pos = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) { pos[3 * i] = 1000 + rnd() * 1000; pos[3 * i + 1] = 2000 + rnd() * 1000; pos[3 * i + 2] = rnd() * 5 }
  const files = new Map(), data = []
  let size = 0
  const tmp = {
    async append(name, u8) { (files.get(name) ?? files.set(name, []).get(name)).push(u8) },
    async size(name) { return (files.get(name) ?? []).reduce((a, b) => a + b.length, 0) },
    async read(name, offset, length) {
      let o = 0
      for (const b of files.get(name)) { if (offset < o + b.length) return b.subarray(offset - o, offset - o + length); o += b.length }
      return new Uint8Array(0)
    },
    async remove(name) { files.delete(name) },
  }
  const out = { async write(u8) { const at = size; data.push(u8); size += u8.length; return at } }
  const res = await buildLod({
    count: n, bounds: { min: [1000, 2000, 0], max: [2000, 3000, 5] }, colour: false, attributes: [],
    async *batches() { yield { count: n, pos } },
  }, tmp, out, { leafMax: 5000 })
  const { hierarchy, ...lod } = res
  const blobs = { data: new Blob(data), hierarchy: new Blob([hierarchy]) }
  return { lod, open: () => openLodReader(lod, blobs) }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('level-of-detail layer', () => {
  it('shows coarse to fine within the budget, nearest nodes first', async () => {
    const { lod, open } = await terrainLod(300000)
    let changes = 0
    const layer = createLodLayer({ id: 'c', count: 300000, lod, style: null }, {
      open, material: new THREE.PointsMaterial(), onChange: () => changes++,
    })
    layer.restyle({ id: 'c', count: 300000, lod, style: { field: 'elevation' } }, null)
    const camera = new THREE.PerspectiveCamera(60, 1, 1, 1e5)
    camera.position.set(1500, 1500, 300) // above the near edge, looking across
    camera.lookAt(1500, 2300, 0)
    const walk = async (budget) => {
      for (let k = 0; k < 40; k++) { layer.update(camera, 1000, budget); await settle() }
    }
    while (!layer.ready) await settle()
    await walk(150000)
    expect(layer.visiblePoints).toBeGreaterThan(20000)
    expect(layer.visiblePoints).toBeLessThanOrEqual(150000)
    const shown = layer.object.children.filter((o) => o.visible)
    expect(shown.some((o) => o.userData.level >= 2)).toBe(true)
    // Colours from the whole cloud's elevation range.
    expect(shown[0].geometry.getAttribute('color').count).toBe(shown[0].geometry.getAttribute('position').count)
    // A larger budget shows more; loaded nodes beyond the cache are evicted, never the root.
    await walk(250000)
    expect(layer.visiblePoints).toBeGreaterThan(150000)
    expect(layer.visiblePoints).toBeLessThanOrEqual(250000)
    expect(changes).toBeGreaterThan(5)
    // Picking finds a drawn point, in the cloud's own coordinates.
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    const hit = layer.pick({ viewProj: vp, x: 0, y: 0, tolX: 0.03, tolY: 0.03 })
    expect(hit.pos[0]).toBeGreaterThan(1000)
    expect(hit.pos[1]).toBeGreaterThan(2000)
    layer.dispose()
    expect(layer.object.children.length).toBe(0)
  })
})

// A COPC file (core/lod/copc.js) behind the same layer: the PDAL-written fixture with
// its (1,0,0,0) entry moved into a second hierarchy page, read when the walk reaches
// the root.
describe('level-of-detail layer over a COPC file', () => {
  it('draws every node and reads the deeper hierarchy page on the way', async () => {
    const wasm = await import('../../wasm/lazcodec/lazcodec.js')
    const { readFileSync } = await import('node:fs')
    await wasm.default({ module_or_path: readFileSync(new URL('../../wasm/lazcodec/lazcodec_bg.wasm', import.meta.url)) })
    const { readCopcMeta } = await import('../../core/lod/copc.js')
    const { openCloudSource } = await import('../../core/lod/cloudSource.js')
    const orig = new Uint8Array(readFileSync(new URL('../../core/lod/fixtures/tiny.copc.laz', import.meta.url)))
    const createChunkDecoder = (vlr) => {
      const d = wasm.LazDecoder.forChunks(vlr)
      return { decode: (b, n) => d.decode_chunk(b, n), free: () => d.free() }
    }
    const lod = await readCopcMeta({ size: orig.length, read: async (a, b) => orig.slice(a, b) }, { createChunkDecoder })
    const bytes = new Uint8Array(orig.length + 32)
    bytes.set(orig)
    const dv = new DataView(bytes.buffer)
    const root = lod.copc.rootPage.offset
    let moved = -1
    for (let o = root; o < root + lod.copc.rootPage.length; o += 32) {
      if (dv.getInt32(o, true) === 1 && dv.getInt32(o + 4, true) === 0 && dv.getInt32(o + 8, true) === 0 && dv.getInt32(o + 12, true) === 0) moved = o
    }
    bytes.copyWithin(orig.length, moved, moved + 32)
    dv.setBigUint64(moved + 16, BigInt(orig.length), true); dv.setInt32(moved + 24, 32, true); dv.setInt32(moved + 28, -1, true)

    let reader = null
    const open = async () => (reader = await openCloudSource(lod, { data: new Blob([bytes]) }, { createChunkDecoder, hierarchy: 'lazy' }))
    const cloud = { id: 'k', count: lod.points, lod, style: null }
    const layer = createLodLayer(cloud, { open, material: new THREE.PointsMaterial(), onChange: () => {} })
    layer.restyle({ ...cloud, style: { field: 'attribute:classification' } }, null)
    while (!layer.ready) await settle()
    expect(reader.complete).toBe(false)
    expect(reader.nodes.size).toBe(4)
    const camera = new THREE.PerspectiveCamera(60, 1, 1, 1e5)
    const c = lod.root.min.map((m) => m + lod.root.size / 2)
    camera.position.set(c[0], c[1] - 30, c[2] + 60)
    camera.lookAt(c[0], c[1], c[2])
    for (let k = 0; k < 20; k++) { layer.update(camera, 1000, 1e6); await settle() }
    expect(reader.complete).toBe(true)
    expect(layer.visiblePoints).toBe(24_000)
    layer.dispose()
  })
})
