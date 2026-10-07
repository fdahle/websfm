import { describe, it, expect } from 'vitest'
import {
  parseMeshBuffer,
  transferVertexColors,
  generateMesh,
  meshInputCell,
  subsampleForMesh,
  recommendMeshDepth,
  resolveMeshDepth,
  robustBox,
  estimatePointSpacing,
  parseMeshStats,
} from './mesh.js'
import { MESH_TUNING } from '../tuning.js'
import { MESH_DEFAULTS } from '../defaults.user.js'

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
  const empty = () => ({ bytes: new Uint8Array(8), stats: null })

  it('throws a clear error when normals are missing', () => {
    const noNrm = { count: 2, pos: dense.pos, col: dense.col }
    expect(() => generateMesh(noNrm, empty)).toThrow(/normals/i)
  })

  it('parses the injected solver output and colours vertices', () => {
    // The solver works relative to the input's bbox centre (0.5, 0, 0) and answers in
    // that frame; generateMesh adds the origin back.
    const pos = Float32Array.from([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0])
    const idx = Uint32Array.from([0, 1, 2])
    const poissonFn = () => ({ bytes: encodeMesh(pos, idx), stats: null })
    const m = generateMesh(dense, poissonFn, { mergeCell: 1, colorize: true }, () => {})
    expect(m.nVerts).toBe(3)
    expect(m.count).toBe(1) // triangles
    expect(Array.from(m.pos.slice(0, 6))).toEqual([0, 0, 0, 1, 0, 0])
    expect(m.col.length).toBe(9)
    // First vertex sits on the red dense point.
    expect(Array.from(m.col.slice(0, 3))).toEqual([255, 0, 0])
  })

  it('returns an empty mesh (with a run summary) when the solver yields nothing', () => {
    const m = generateMesh(dense, empty, { mergeCell: 1 }, () => {})
    expect(m.nVerts).toBe(0)
    expect(m.count).toBe(0)
    expect(m.col).toBeNull()
    expect(m.summary.depth).toBeGreaterThan(0)
  })

  it('maps the cleanup settings onto the solver options', () => {
    let seen = null
    const fn = (input) => { seen = input; return empty() }
    generateMesh(dense, fn, { mergeCell: 0.5 }, () => {})
    // Defaults: gentle trim, hole refill, floaters removed, no distance trim.
    expect(seen.densityRatio).toBe(MESH_TUNING.trimRatio.gentle)
    expect(seen.holeAreaRatio).toBe(MESH_TUNING.holeAreaRatio)
    expect(seen.minComponentShare).toBeCloseTo(MESH_DEFAULTS.minPiecePct / 100)
    expect(seen.trimDist).toBe(0)

    generateMesh(dense, fn, { mergeCell: 0.5, trim: 'strong', fillHoles: false, removeFloaters: false }, () => {})
    expect(seen.densityRatio).toBe(MESH_TUNING.trimRatio.strong)
    expect(seen.holeAreaRatio).toBe(0)
    expect(seen.minComponentShare).toBe(0)

    // Hole refill only means something after a trim.
    generateMesh(dense, fn, { mergeCell: 0.5, trim: 'off', fillHoles: true }, () => {})
    expect(seen.densityRatio).toBe(0)
    expect(seen.holeAreaRatio).toBe(0)
  })

  it('ignores the retired trimFactor key (a saved workflow recipe still carries 6)', () => {
    let seen = null
    generateMesh(dense, (i) => { seen = i; return empty() }, { mergeCell: 0.5, trimFactor: 6, fillHoles: false }, () => {})
    expect(seen.trimDist).toBe(0)
  })

  // A clustered cloud with one far point: depth 1 over extent 10 ⇒ leaf 5. The robust
  // box and stray filter are switched off where the test is about something else.
  const clustered = () => ({
    count: 5,
    pos: Float32Array.from([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0, 0.01, 0.01, 0, 10, 0, 0]),
    nrm: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    col: null,
  })
  const plain = { robustMargin: Infinity, isolatedCellLeaves: 0, colorize: false }

  it('subsamples to ~one point per leaf and carries each sample\'s point count as support', () => {
    let seen = null
    generateMesh(clustered(), (i) => { seen = i; return empty() }, { depth: 1, mergeCell: 0.001, ...plain }, () => {})
    expect(seen.pos.length / 3).toBe(2) // the four clustered points collapse to one
    expect([...seen.wgt].sort()).toEqual([1, 4])
  })

  it('scales the distance trim with the subsampled input spacing, not the dense GSD', () => {
    // Input cell 5 ≫ mergeCell 0.001: a GSD-sized radius against samples 5 apart would
    // delete nearly every vertex of the surface.
    const d = clustered()
    let seen = null
    generateMesh(d, (i) => { seen = i; return empty() },
      { depth: 1, mergeCell: 0.001, distanceTrim: 6, ...plain }, () => {})
    expect(seen.trimDist).toBeCloseTo(6 * meshInputCell(d.pos, 1, MESH_TUNING.inputLeafCellsPerPoint), 9)
  })

  it('lowers a depth the input spacing cannot use, and logs why', () => {
    let seen = null
    const logs = []
    // Extent 1, spacing 0.1 ⇒ depth ceil(log2(10)) = 4 is all the spacing supports.
    const d = { count: 2, pos: Float32Array.from([0, 0, 0, 1, 0, 0]), nrm: Float32Array.from([0, 0, 1, 0, 0, 1]) }
    generateMesh(d, (i) => { seen = i; return empty() }, { depth: 10, mergeCell: 0.1, ...plain, minDepth: 2 },
      (m) => logs.push(m))
    expect(seen.depth).toBe(4)
    expect(logs.some((l) => /depth 10 → 4/.test(l))).toBe(true)
  })

  it('leaves far stragglers out of the solve', () => {
    // 200 points on a unit square plus 2 points 1000 units away.
    const n = 202
    const pos = new Float32Array(n * 3)
    const nrm = new Float32Array(n * 3)
    for (let i = 0; i < 200; i++) { pos[i * 3] = (i % 20) / 20; pos[i * 3 + 1] = Math.floor(i / 20) / 10; nrm[i * 3 + 2] = 1 }
    pos[200 * 3] = 1000; pos[201 * 3 + 1] = -1000
    nrm[200 * 3 + 2] = 1; nrm[201 * 3 + 2] = 1
    let seen = null
    generateMesh({ count: n, pos, nrm }, (i) => { seen = i; return empty() },
      { depth: 4, mergeCell: 0.1, isolatedCellLeaves: 0, colorize: false }, () => {}) // leaf 1/16 < spacing: no subsample
    expect(seen.pos.length / 3).toBe(200)
  })

  it('meshes a far-from-origin Float64 cloud in local coordinates and restores them exactly', () => {
    // Projected coordinates (UTM-like): f32 would round these to ~0.5 m.
    const E = 512345.123, N = 6123456.789
    const pos = Float64Array.from([E, N, 10, E + 1, N, 10, E, N + 1, 10, E + 1, N + 1, 10])
    const nrm = Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])
    let seen = null
    const fn = (i) => {
      seen = i
      // Echo the first three input samples back as one triangle.
      return { bytes: encodeMesh(i.pos.slice(0, 9), Uint32Array.from([0, 1, 2])), stats: null }
    }
    const m = generateMesh({ count: 4, pos, nrm }, fn, { depth: 2, mergeCell: 0.25, ...plain }, () => {})
    for (const v of seen.pos) expect(Math.abs(v)).toBeLessThan(2)
    expect(m.pos).toBeInstanceOf(Float64Array)
    const want = [[E, N, 10], [E + 1, N, 10], [E, N + 1, 10], [E + 1, N + 1, 10]]
    for (let v = 0; v < 3; v++) {
      const got = [m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]]
      expect(want.some((w) => w.every((c, k) => Math.abs(c - got[k]) < 1e-6))).toBe(true)
    }
  })

  it('estimates the spacing when the cloud has no merge cell, and records it', () => {
    const n = 400
    const pos = new Float32Array(n * 3)
    const nrm = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) { pos[i * 3] = (i % 20) * 0.3; pos[i * 3 + 1] = Math.floor(i / 20) * 0.3; nrm[i * 3 + 2] = 1 }
    const m = generateMesh({ count: n, pos, nrm }, empty, { depth: 6, ...plain }, () => {})
    expect(m.summary.spacingSource).toBe('estimated')
    expect(m.summary.spacing).toBeCloseTo(0.3, 5)
  })
})

describe('resolveMeshDepth', () => {
  it('keeps the requested depth while the spacing supports it', () => {
    expect(resolveMeshDepth(8, 100, 0.01).depth).toBe(8) // supports 14
  })
  it('lowers it to what the spacing supports, never below minDepth', () => {
    expect(resolveMeshDepth(10, 100, 1)).toEqual({ depth: 7, needed: 7 }) // ceil(log2 100)
    expect(resolveMeshDepth(10, 4, 1, { minDepth: 5 }).depth).toBe(5)
    expect(resolveMeshDepth(3, 4, 1, { minDepth: 5 }).depth).toBe(3) // floor is the request when it is below minDepth
  })
})

describe('robustBox', () => {
  it('excludes far stragglers but keeps a margin around the bulk', () => {
    const pos = new Float64Array(1000 * 3)
    for (let i = 0; i < 998; i++) { pos[i * 3] = i / 998; pos[i * 3 + 1] = (i % 7) / 7 }
    pos[998 * 3] = 500; pos[999 * 3 + 2] = -500
    const b = robustBox(pos)
    expect(b.max[0]).toBeLessThan(2)
    expect(b.min[2]).toBeGreaterThan(-2)
    expect(b.max[0]).toBeGreaterThan(1) // the real extent survives with margin
  })
  it('gives a thin axis the margin of the largest one', () => {
    // Near-planar: z noise of ±0.001 across a 10 × 10 extent.
    const pos = new Float64Array(500 * 3)
    for (let i = 0; i < 500; i++) { pos[i * 3] = (i % 25) / 2.5; pos[i * 3 + 1] = Math.floor(i / 25) / 2; pos[i * 3 + 2] = ((i * 37) % 11 - 5) * 2e-4 }
    const b = robustBox(pos)
    expect(b.max[2] - b.min[2]).toBeGreaterThan(4)
  })
})

describe('estimatePointSpacing', () => {
  it('returns the median nearest-neighbour distance of a regular grid', () => {
    const pos = new Float32Array(30 * 30 * 3)
    for (let i = 0; i < 900; i++) { pos[i * 3] = (i % 30) * 0.02; pos[i * 3 + 1] = Math.floor(i / 30) * 0.02 }
    expect(estimatePointSpacing(pos)).toBeCloseTo(0.02, 6)
  })
  it('returns 0 for fewer than two points', () => {
    expect(estimatePointSpacing(new Float32Array(3))).toBe(0)
  })
})

describe('parseMeshStats', () => {
  it('names the crate stats vector, and passes null through', () => {
    const s = parseMeshStats(Float64Array.from([10, 1, 2, 3, 4, 5, 6, 7, 8, 9.5, 0.25]))
    expect(s).toMatchObject({ extractedTris: 10, holesFilled: 3, components: 5, keptTris: 8, leafWidth: 0.25 })
    expect(parseMeshStats(null)).toBeNull()
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
  it('averages points + renormalises normals within a cell, and counts them', () => {
    // Two points in one cell (cell=1), one in another; opposing-ish normals average.
    const pos = Float32Array.from([0.2, 0, 0, 0.8, 0, 0, 5, 0, 0])
    const nrm = Float32Array.from([0, 0, 1, 0, 1, 0, 1, 0, 0])
    const { pos: outPos, nrm: outNrm, wgt } = subsampleForMesh(pos, nrm, 1)
    expect(outPos.length / 3).toBe(2)
    const mi = Math.abs(outPos[0] - 0.5) < 1e-4 ? 0 : 1
    expect(outPos[mi * 3]).toBeCloseTo(0.5)
    expect(wgt[mi]).toBe(2)
    expect(wgt[1 - mi]).toBe(1)
    // Every emitted normal is unit length.
    for (let i = 0; i < outNrm.length / 3; i++) {
      const mag = Math.hypot(outNrm[i * 3], outNrm[i * 3 + 1], outNrm[i * 3 + 2])
      expect(mag).toBeCloseTo(1)
    }
  })

  it('keeps every point when cell <= 0, relative to the origin, with unit support', () => {
    const pos = Float64Array.from([100.5, 200.25, 3])
    const nrm = Float32Array.from([0, 0, 1])
    const r = subsampleForMesh(pos, nrm, 0, [100, 200, 0])
    expect([...r.pos]).toEqual([0.5, 0.25, 3])
    expect(r.nrm).toBe(nrm)
    expect([...r.wgt]).toEqual([1])
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
