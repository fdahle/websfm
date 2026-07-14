import { describe, it, expect } from 'vitest'
import { parseMeshBuffer, transferVertexColors, generateMesh } from './mesh.js'

// Encode a mesh into the wasm wire format (mirror of crates/mesh encode_mesh) so the
// parser can be round-tripped without the actual wasm.
function encodeMesh(pos, idx) {
  const nVerts = pos.length / 3
  const nTris = idx.length / 3
  const buf = new ArrayBuffer(8 + nVerts * 12 + nTris * 12)
  const dv = new DataView(buf)
  dv.setUint32(0, nVerts, true)
  dv.setUint32(4, nTris, true)
  let o = 8
  for (let i = 0; i < pos.length; i++) { dv.setFloat32(o, pos[i], true); o += 4 }
  for (let i = 0; i < idx.length; i++) { dv.setUint32(o, idx[i], true); o += 4 }
  return new Uint8Array(buf)
}

describe('parseMeshBuffer', () => {
  it('round-trips positions and indices', () => {
    const pos = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])
    const idx = Uint32Array.from([0, 1, 2, 1, 3, 2])
    const bytes = encodeMesh(pos, idx)
    const m = parseMeshBuffer(bytes)
    expect(m.nVerts).toBe(4)
    expect(m.nTris).toBe(2)
    expect(Array.from(m.pos)).toEqual(Array.from(pos))
    expect(Array.from(m.idx)).toEqual(Array.from(idx))
  })

  it('handles an empty mesh (header of zeros)', () => {
    const bytes = new Uint8Array(8) // nVerts=0, nTris=0
    const m = parseMeshBuffer(bytes)
    expect(m.nVerts).toBe(0)
    expect(m.nTris).toBe(0)
    expect(m.pos.length).toBe(0)
    expect(m.idx.length).toBe(0)
  })

  it('parses at a non-zero byteOffset (subarray view)', () => {
    const pos = Float32Array.from([2, 3, 4])
    const idx = Uint32Array.from([0, 0, 0])
    const inner = encodeMesh(pos, idx)
    const padded = new Uint8Array(inner.length + 16)
    padded.set(inner, 16)
    const m = parseMeshBuffer(padded.subarray(16))
    expect(m.nVerts).toBe(1)
    expect(Array.from(m.pos)).toEqual([2, 3, 4])
  })
})

describe('transferVertexColors', () => {
  it('colours each vertex from the nearest dense point in-cell', () => {
    // Two dense points in distinct cells (cell=1): red at origin, blue at (5,0,0).
    const dense = {
      pos: Float32Array.from([0.1, 0.1, 0.1, 5.1, 0.0, 0.0]),
      col: Uint8Array.from([255, 0, 0, 0, 0, 255]),
    }
    // Vertices sitting in each cell.
    const meshPos = Float32Array.from([0.2, 0.2, 0.2, 5.0, 0.1, 0.0])
    const { col, misses } = transferVertexColors(meshPos, dense, 1.0, { searchRadius: 1 })
    expect(misses).toBe(0)
    expect(Array.from(col.slice(0, 3))).toEqual([255, 0, 0])
    expect(Array.from(col.slice(3, 6))).toEqual([0, 0, 255])
  })

  it('falls back to gray and counts a vertex with no dense point in range', () => {
    const dense = { pos: Float32Array.from([0, 0, 0]), col: Uint8Array.from([10, 20, 30]) }
    // Vertex far away (many cells off) with searchRadius 1 ⇒ miss.
    const meshPos = Float32Array.from([100, 100, 100])
    const { col, misses } = transferVertexColors(meshPos, dense, 1.0, { searchRadius: 1, grayFallback: [7, 8, 9] })
    expect(misses).toBe(1)
    expect(Array.from(col)).toEqual([7, 8, 9])
  })
})

describe('generateMesh', () => {
  const dense = {
    count: 2,
    pos: Float32Array.from([0, 0, 0, 1, 0, 0]),
    col: Uint8Array.from([255, 0, 0, 0, 255, 0]),
    nrm: Float32Array.from([0, 0, 1, 0, 0, 1]),
  }

  it('throws a clear error when normals are missing', () => {
    const noNrm = { count: 2, pos: dense.pos, col: dense.col }
    expect(() => generateMesh(noNrm, () => new Uint8Array(8))).toThrow(/normals/i)
  })

  it('parses the injected solver output and colours vertices', () => {
    const pos = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const idx = Uint32Array.from([0, 1, 2])
    const poissonFn = () => encodeMesh(pos, idx)
    const m = generateMesh(dense, poissonFn, { mergeCell: 1, colorize: true }, () => {})
    expect(m.nVerts).toBe(3)
    expect(m.count).toBe(1) // triangles
    expect(m.col).not.toBeNull()
    expect(m.col.length).toBe(9)
    // First vertex sits on the red dense point.
    expect(Array.from(m.col.slice(0, 3))).toEqual([255, 0, 0])
  })

  it('returns an empty mesh when the solver yields nothing', () => {
    const m = generateMesh(dense, () => new Uint8Array(8), { mergeCell: 1 }, () => {})
    expect(m.nVerts).toBe(0)
    expect(m.count).toBe(0)
    expect(m.col).toBeNull()
  })
})
