import { describe, it, expect } from 'vitest'
import { facePages, regroupByPage } from './carry.js'
import { cropMesh, cleanMesh, taubinSmooth, sampleMesh, weldVertices, UNTEXTURED } from '../meshEdit.js'

// A 2×1 strip of four triangles on two atlas pages (faces 0–1 page 0, 2–3 page 1),
// split at x = 1 as a textured mesh is: the middle column of vertices exists twice,
// once per page, with different UVs.
function texturedStrip() {
  const pos = Float64Array.from([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, // page 0: vertices 0–3
    1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, // page 1: vertices 4–7 (4, 7 coincide with 1, 2)
  ])
  const uv = Float32Array.from([0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 1, 0.5, 1, 1, 0.5, 1])
  const idx = Uint32Array.of(0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7)
  const groups = [{ page: 0, start: 0, count: 2 }, { page: 1, start: 2, count: 2 }]
  return { nVerts: 8, count: 4, pos, idx, col: new Uint8Array(24).fill(100), uv, page: facePages(groups, 4), groups }
}

describe('facePages / regroupByPage', () => {
  it('round-trips groups and refuses a face without a page', () => {
    const m = texturedStrip()
    expect([...m.page]).toEqual([0, 0, 1, 1])
    // Shuffle the faces: regrouping sorts them back by page, stably.
    const idx = Uint32Array.of(4, 5, 6, 0, 1, 2, 4, 6, 7, 0, 2, 3), page = Uint16Array.of(1, 0, 1, 0)
    const r = regroupByPage({ idx, page })
    expect(r.groups).toEqual([{ page: 0, start: 0, count: 2 }, { page: 1, start: 2, count: 2 }])
    expect([...r.idx]).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
    expect(regroupByPage({ idx, page: Uint16Array.of(1, 0, UNTEXTURED, 0) })).toBeNull()
  })
})

describe('mesh tools on a textured mesh', () => {
  it('crop keeps each kept triangle with its page and its vertices with their UVs', () => {
    const out = cropMesh(texturedStrip(), { min: [1, -1, -1] })
    expect(out.count).toBe(2)
    expect([...out.page]).toEqual([1, 1])
    expect(out.uv.length).toBe(2 * out.nVerts)
    // Vertex (2, 1, 0) still has UV (1, 1).
    const v = [...Array(out.nVerts).keys()].find((i) => out.pos[3 * i] === 2 && out.pos[3 * i + 1] === 1)
    expect([out.uv[2 * v], out.uv[2 * v + 1]]).toEqual([1, 1])
  })

  it('weld keeps the copies of a seam vertex apart, joins true duplicates', () => {
    const m = texturedStrip()
    expect(weldVertices(m).merged).toBe(0)
    // A duplicate of vertex 0 with the same UV (as an STL-style export would have).
    const dup = { ...m, nVerts: 9, pos: Float64Array.from([...m.pos, 0, 0, 0]), uv: Float32Array.from([...m.uv, 0, 0]),
      col: new Uint8Array(27).fill(100), idx: Uint32Array.of(8, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7) }
    const r = weldVertices(dup)
    expect(r.merged).toBe(1)
    expect([...r.mesh.page]).toEqual([0, 0, 1, 1])
  })

  it('a clean that fills a hole marks the patch untextured', () => {
    // The page-0 quad alone: its rim is one 4-edge loop, which "close every hole" caps
    // with a fan whose triangles no page covers.
    const m = texturedStrip()
    const quad = { nVerts: 4, count: 2, pos: m.pos.slice(0, 12), uv: m.uv.slice(0, 8), col: m.col.slice(0, 12),
      idx: Uint32Array.of(0, 1, 2, 0, 2, 3), page: Uint16Array.of(0, 0) }
    const { mesh } = cleanMesh(quad, { methods: ['holes'], maxHoleEdges: 0 })
    expect(mesh.count).toBeGreaterThan(2)
    expect(mesh.page[mesh.count - 1]).toBe(UNTEXTURED)
    expect(regroupByPage(mesh)).toBeNull()
  })

  it('smooth keeps topology, UVs and pages', () => {
    const m = texturedStrip()
    const out = taubinSmooth(m, { iterations: 2, fixBoundary: false })
    expect([...out.page]).toEqual([...m.page])
    expect([...out.uv]).toEqual([...m.uv])
  })

  it('sample to points takes its colour from the texture', () => {
    const page = (r, g, b) => ({ width: 4, height: 4, data: new Uint8ClampedArray(64).map((_, i) => [r, g, b, 255][i % 4]) })
    const cloud = sampleMesh(texturedStrip(), { count: 400, texture: { pages: [page(200, 10, 10), page(10, 10, 200)] } })
    for (let i = 0; i < cloud.count; i++) {
      const x = cloud.pos[3 * i], r = cloud.col[3 * i], b = cloud.col[3 * i + 2]
      if (x < 0.99) expect([r, b]).toEqual([200, 10])
      if (x > 1.01) expect([r, b]).toEqual([10, 200])
    }
  })
})
