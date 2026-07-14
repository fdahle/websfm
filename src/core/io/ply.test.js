import { describe, it, expect } from 'vitest'
import { parsePly } from './ply.js'
import { cloudToPly, meshToPly } from '../products/exporters.js'

describe('parsePly — self-consistency with our writers', () => {
  const sparse = [
    { x: 1.5, y: -2.25, z: 3.125, color: [10, 20, 30] },
    { x: 500000.5, y: 7100000.25, z: 812, color: [255, 0, 128] },
  ]

  it('round-trips a binary PLY cloud (cloudToPly → parsePly)', () => {
    const out = parsePly(cloudToPly(sparse, { binary: true }))
    expect(out.count).toBe(2)
    expect(out.pos[0]).toBeCloseTo(1.5, 4)
    expect(out.pos[3]).toBeCloseTo(500000.5, 1)
    expect([...out.col]).toEqual([10, 20, 30, 255, 0, 128])
    expect(out.idx).toBeUndefined()
  })

  it('round-trips an ASCII PLY cloud', () => {
    const out = parsePly(cloudToPly(sparse, { binary: false }))
    expect(out.count).toBe(2)
    expect(out.pos[1]).toBeCloseTo(-2.25, 5)
    expect([...out.col.slice(3)]).toEqual([255, 0, 128])
  })

  it('reads normals when present', () => {
    const flat = {
      count: 1,
      pos: Float32Array.from([1, 2, 3]),
      col: Uint8Array.from([9, 8, 7]),
      nrm: Float32Array.from([0, 0, 1]),
    }
    const out = parsePly(cloudToPly(flat, { binary: true }))
    expect(out.nrm).toBeInstanceOf(Float32Array)
    expect([...out.nrm]).toEqual([0, 0, 1])
  })

  it('round-trips a mesh with faces (meshToPly → parsePly)', () => {
    const mesh = {
      nVerts: 4, count: 2,
      pos: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      idx: Uint32Array.from([0, 1, 2, 1, 3, 2]),
      col: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128]),
    }
    const out = parsePly(meshToPly(mesh, { binary: true }))
    expect(out.nVerts).toBe(4)
    expect(out.count).toBe(2)
    expect([...out.idx]).toEqual([0, 1, 2, 1, 3, 2])
    expect([...out.col.slice(0, 3)]).toEqual([255, 0, 0])
  })

  it('round-trips an ASCII mesh with faces', () => {
    const mesh = {
      nVerts: 3, count: 1,
      pos: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      idx: Uint32Array.from([0, 1, 2]),
      col: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    }
    const out = parsePly(meshToPly(mesh, { binary: false }))
    expect(out.count).toBe(1)
    expect([...out.idx]).toEqual([0, 1, 2])
  })
})

describe('parsePly — spec edge cases', () => {
  it('skips unknown vertex properties via computed stride (binary)', () => {
    // element vertex with x,y,z (float) + an extra "quality" float + rgb (uchar).
    const header =
      'ply\nformat binary_little_endian 1.0\nelement vertex 1\n' +
      'property float x\nproperty float y\nproperty float z\n' +
      'property float quality\n' +
      'property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n'
    const hb = new TextEncoder().encode(header)
    const stride = 4 * 4 + 3 // 4 floats + 3 uchar
    const out = new Uint8Array(hb.length + stride)
    out.set(hb, 0)
    const dv = new DataView(out.buffer, hb.length)
    dv.setFloat32(0, 7, true); dv.setFloat32(4, 8, true); dv.setFloat32(8, 9, true)
    dv.setFloat32(12, 42.5, true) // quality — must be skipped
    out[hb.length + 16] = 100; out[hb.length + 17] = 110; out[hb.length + 18] = 120
    const parsed = parsePly(out)
    expect([parsed.pos[0], parsed.pos[1], parsed.pos[2]]).toEqual([7, 8, 9])
    expect([...parsed.col]).toEqual([100, 110, 120])
  })

  it('fans a quad face into two triangles (ascii)', () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\n' +
      'element face 1\nproperty list uchar int vertex_indices\nend_header\n' +
      '0 0 0\n1 0 0\n1 1 0\n0 1 0\n4 0 1 2 3\n'
    const out = parsePly(text)
    expect(out.count).toBe(2) // quad → 2 triangles
    expect([...out.idx]).toEqual([0, 1, 2, 0, 2, 3])
  })

  it('rejects big-endian binary with a clear error', () => {
    const text = 'ply\nformat binary_big_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n'
    expect(() => parsePly(new TextEncoder().encode(text + '\0\0\0\0\0\0\0\0\0\0\0\0'))).toThrow(/big-endian/)
  })

  it('rejects non-PLY bytes', () => {
    expect(() => parsePly(new TextEncoder().encode('LASF and some padding here for length'))).toThrow(/PLY/)
  })
})
