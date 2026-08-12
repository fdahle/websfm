import { describe, it, expect } from 'vitest'
import {
  parseMeshBuffer,
  transferVertexColors,
  generateMesh,
  meshInputCell,
  subsampleForMesh,
  recommendMeshDepth,
} from './mesh.js'

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

  it('does not alias an out-of-bounds vertex onto another cell', () => {
    // Cell keys are packed as (dix·ny+diy)·nz+diz, so an out-of-range offset on one
    // axis lands on a *valid* key of the next. Poisson extrapolates past the cloud, so
    // mesh vertices outside it are routine — without a per-axis bounds check this
    // vertex would silently take the blue point's colour instead of missing.
    // Cloud spans cells x=0..1, y=z=0 ⇒ bx=by=bz=-1, nx=4, ny=nz=3.
    const dense = {
      pos: Float32Array.from([0.5, 0.5, 0.5, 1.5, 0.5, 0.5]),
      col: Uint8Array.from([255, 0, 0, 0, 0, 255]),
    }
    // (dix=1, diy=4, diz=1) packs to (1·3+4)·3+1 = 22, the same key as the blue point
    // at (dix=2, diy=1, diz=1). It is 3 cells away in y, so the honest answer is a miss.
    const meshPos = Float32Array.from([0.5, 3.5, 0.5])
    const { col, misses } = transferVertexColors(meshPos, dense, 1.0, { searchRadius: 1, grayFallback: [7, 8, 9] })
    expect(misses).toBe(1)
    expect(Array.from(col)).toEqual([7, 8, 9])
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

  it('keeps the Poisson surface untrimmed when gap filling is enabled', () => {
    let trim = -1
    const poissonFn = (_pos, _nrm, _depth, _screening, trimDist) => {
      trim = trimDist
      return new Uint8Array(8)
    }
    generateMesh(dense, poissonFn, { mergeCell: 0.5, trimFactor: 6, fillHoles: true }, () => {})
    expect(trim).toBe(0)
    generateMesh(dense, poissonFn, { mergeCell: 0.5, trimFactor: 6, fillHoles: false }, () => {})
    expect(trim).toBe(3)
  })

  it('subsamples the Poisson input when the cloud is denser than a leaf cell', () => {
    // 4 near-coincident points inside one tiny region + normals; a coarse input cell
    // collapses them, so the solver sees fewer points than the full cloud.
    const pos = Float32Array.from([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0, 0.01, 0.01, 0, 10, 0, 0])
    const nrm = Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])
    const d = { count: 5, pos, nrm, col: null }
    let sawPoints = -1
    // depth 1 over extent 10 ⇒ leaf 5, input cell 5 (> mergeCell 0.001) ⇒ the four
    // clustered points collapse to one, plus the far point ⇒ 2 input points.
    const poissonFn = (p) => { sawPoints = p.length / 3; return new Uint8Array(8) }
    generateMesh(d, poissonFn, { depth: 1, mergeCell: 0.001, colorize: false }, () => {})
    expect(sawPoints).toBe(2)
  })
})

describe('meshInputCell', () => {
  it('ties the input cell to the octree leaf width (extent / 2^depth)', () => {
    const pos = Float32Array.from([0, 0, 0, 8, 0, 0]) // extent 8
    expect(meshInputCell(pos, 3, 1)).toBeCloseTo(1) // 8 / 2^3
    expect(meshInputCell(pos, 3, 2)).toBeCloseTo(2) // ×2 leaf cells per point
  })

  it('returns 0 for a degenerate cloud or non-positive depth', () => {
    expect(meshInputCell(new Float32Array(0), 8)).toBe(0)
    expect(meshInputCell(Float32Array.from([1, 1, 1, 1, 1, 1]), 8)).toBe(0) // no extent
    expect(meshInputCell(Float32Array.from([0, 0, 0, 1, 0, 0]), 0)).toBe(0)
  })
})

describe('subsampleForMesh', () => {
  it('averages points + renormalises normals within a cell', () => {
    // Two points in one cell (cell=1), one in another; opposing-ish normals average.
    const pos = Float32Array.from([0.2, 0, 0, 0.8, 0, 0, 5, 0, 0])
    const nrm = Float32Array.from([0, 0, 1, 0, 1, 0, 1, 0, 0])
    const { pos: outPos, nrm: outNrm } = subsampleForMesh(pos, nrm, 1)
    expect(outPos.length / 3).toBe(2)
    // The merged cell's position is the mean of its two points.
    const merged = [outPos[0], outPos[1], outPos[2]]
    const other = [outPos[3], outPos[4], outPos[5]]
    // Order isn't guaranteed; find the merged (x≈0.5) one.
    const m = Math.abs(merged[0] - 0.5) < 1e-4 ? merged : other
    expect(m[0]).toBeCloseTo(0.5)
    // Every emitted normal is unit length.
    for (let i = 0; i < outNrm.length / 3; i++) {
      const mag = Math.hypot(outNrm[i * 3], outNrm[i * 3 + 1], outNrm[i * 3 + 2])
      expect(mag).toBeCloseTo(1)
    }
  })

  it('passes the input through unchanged when cell <= 0', () => {
    const pos = Float32Array.from([0, 0, 0])
    const nrm = Float32Array.from([0, 0, 1])
    const r = subsampleForMesh(pos, nrm, 0)
    expect(r.pos).toBe(pos)
    expect(r.nrm).toBe(nrm)
  })
})

describe('recommendMeshDepth', () => {
  it('grows ~½·log2(N) and clamps to [6, 12]', () => {
    expect(recommendMeshDepth(0)).toBe(8)      // fallback
    expect(recommendMeshDepth(100)).toBe(6)    // clamp low
    expect(recommendMeshDepth(1_000_000)).toBe(10) // round(0.5·~19.9)
    expect(recommendMeshDepth(1e12)).toBe(12)  // clamp high
  })
})
