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
