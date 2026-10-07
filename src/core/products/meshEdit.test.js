import { describe, it, expect } from 'vitest'
import {
  meshTopology, compactMesh, removeSmallComponents, removeLongEdges, fillHoles,
  cleanMesh, taubinSmooth, cropMesh, sampleMesh, meshMeasure,
} from './meshEdit.js'

// ── Synthetic meshes ─────────────────────────────────────────────────────────

function makeMesh(verts, tris, { col = null, Pos = Float64Array } = {}) {
  const pos = new Pos(verts.length * 3)
  verts.forEach((v, i) => pos.set(v, i * 3))
  const idx = new Uint32Array(tris.length * 3)
  tris.forEach((t, i) => idx.set(t, i * 3))
  let c = null
  if (col) { c = new Uint8Array(verts.length * 3); verts.forEach((_, i) => c.set(typeof col === 'function' ? col(i) : col, i * 3)) }
  return { nVerts: verts.length, count: tris.length, pos, idx, col: c }
}

// Unit icosphere (outward, CCW seen from outside), `level` midpoint subdivisions.
function icosphere(level = 3, radius = 1) {
  const t = (1 + Math.sqrt(5)) / 2
  const verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(normalize)
  let tris = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6],
    [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
  for (let l = 0; l < level; l++) {
    const cache = new Map()
    const mid = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`
      if (!cache.has(key)) {
        const p = verts[a], q = verts[b]
        verts.push(normalize([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]))
        cache.set(key, verts.length - 1)
      }
      return cache.get(key)
    }
    const next = []
    for (const [a, b, c] of tris) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a)
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca])
    }
    tris = next
  }
  return makeMesh(verts.map((v) => v.map((x) => x * radius)), tris)
}

function normalize(v) {
  const n = Math.hypot(v[0], v[1], v[2])
  return [v[0] / n, v[1] / n, v[2] / n]
}

// n×m cell grid on z = 0 from (ox,oy), CCW seen from +z.
function gridParts(n, m, { step = 1, ox = 0, oy = 0, base = 0, skip = () => false, z = () => 0 } = {}) {
  const verts = [], tris = []
  for (let j = 0; j <= m; j++) for (let i = 0; i <= n; i++) verts.push([ox + i * step, oy + j * step, z(i, j)])
  const at = (i, j) => base + j * (n + 1) + i
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
    if (skip(i, j)) continue
    tris.push([at(i, j), at(i + 1, j), at(i + 1, j + 1)], [at(i, j), at(i + 1, j + 1), at(i, j + 1)])
  }
  return { verts, tris }
}

function grid(n, m, opts = {}) {
  const { verts, tris } = gridParts(n, m, opts)
  return makeMesh(verts, tris, opts)
}

function cube(offset = 0) {
  const verts = []
  for (let i = 0; i < 8; i++) verts.push([(i & 1) + offset, ((i >> 1) & 1) + offset, ((i >> 2) & 1) + offset])
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
  return makeMesh(verts, quads.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]))
}

const vtx = (mesh, v) => [mesh.pos[v * 3], mesh.pos[v * 3 + 1], mesh.pos[v * 3 + 2]]
const faceNormalDotCentroid = (mesh, t) => {
  const [a, b, c] = [0, 1, 2].map((k) => vtx(mesh, mesh.idx[t * 3 + k]))
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  return n[0] * (a[0] + b[0] + c[0]) + n[1] * (a[1] + b[1] + c[1]) + n[2] * (a[2] + b[2] + c[2])
}
function radii(mesh) {
  const r = new Float64Array(mesh.nVerts)
  for (let v = 0; v < mesh.nVerts; v++) r[v] = Math.hypot(...vtx(mesh, v))
  return r
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length
const std = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) }

// Remove every triangle touching vertex v (cuts the vertex's one-ring fan out).
function withoutFan(mesh, v) {
  const tris = []
  for (let t = 0; t < mesh.count; t++) {
    const tri = [mesh.idx[t * 3], mesh.idx[t * 3 + 1], mesh.idx[t * 3 + 2]]
    if (!tri.includes(v)) tris.push(tri)
  }
  return makeMesh(Array.from({ length: mesh.nVerts }, (_, i) => vtx(mesh, i)), tris)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('meshTopology', () => {
  it('a closed cube has 18 manifold, consistently oriented edges', () => {
    const t = meshTopology(cube())
    expect(t.edges).toBe(18)
    expect(t.boundaryEdges).toBe(0)
    expect(t.nonManifoldEdges).toBe(0)
    expect(t.inconsistentEdges).toBe(0)
  })
  it('counts boundary edges of an open grid and a non-manifold fin', () => {
    expect(meshTopology(grid(4, 3)).boundaryEdges).toBe(2 * (4 + 3))
    const fin = makeMesh([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]], [[0, 1, 2], [1, 0, 3], [0, 1, 4]])
    const t = meshTopology(fin)
    expect(t.nonManifoldEdges).toBe(1)
    expect(t.boundaryEdges).toBe(6)
  })
  it('the icosphere fixture is closed and outward-wound', () => {
    const s = icosphere(2)
    const t = meshTopology(s)
    expect(t.boundaryEdges + t.nonManifoldEdges + t.inconsistentEdges).toBe(0)
    for (let i = 0; i < s.count; i++) expect(faceNormalDotCentroid(s, i)).toBeGreaterThan(0)
  })
})

describe('compactMesh', () => {
  it('drops unreferenced vertices and degenerate triangles, remapping indices', () => {
    const verts = [[9, 9, 9], [0, 0, 0], [1, 0, 0], [0, 1, 0], [2, 0, 0], [5, 5, 5]]
    const tris = [[1, 2, 3], [1, 1, 2], [1, 2, 4], [1, 2, 7]] // ok, repeated, collinear, out of range
    const m = makeMesh(verts, tris, { col: (i) => [i, i, i] })
    const out = compactMesh(m)
    expect(out.count).toBe(1)
    expect(out.nVerts).toBe(3)
    expect(Array.from(out.idx)).toEqual([0, 1, 2])
    expect(vtx(out, 1)).toEqual([1, 0, 0])
    expect(Array.from(out.col)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3])
    expect(out.pos).toBeInstanceOf(Float64Array)
    // Input untouched.
    expect(m.count).toBe(4)
    expect(m.idx[3]).toBe(1)
  })
  it('keeps col null when the input has none', () => {
    expect(compactMesh(cube()).col).toBeNull()
  })
})

describe('removeSmallComponents', () => {
  const main = gridParts(10, 10)
  const speck = gridParts(1, 1, { ox: 50, base: main.verts.length })
  const m = makeMesh([...main.verts, ...speck.verts], [...main.tris, ...speck.tris])
  it('drops components below minTriangles', () => {
    const logs = []
    const out = removeSmallComponents(m, { minTriangles: 10 }, (msg) => logs.push(msg))
    expect(out.count).toBe(200)
    expect(meshMeasure(out).components).toBe(1)
    expect(logs[0]).toMatch(/removed 1 components \(2 triangles\)/)
  })
  it('drops components below minFraction of the largest', () => {
    expect(removeSmallComponents(m, { minFraction: 0.05 }).count).toBe(200)
    expect(removeSmallComponents(m, { minFraction: 0.005 }).count).toBe(202)
  })
})

describe('removeLongEdges', () => {
  it('removes a bridging triangle and keeps the grid', () => {
    const g = gridParts(10, 10)
    const far = g.verts.length
    const m = makeMesh([...g.verts, [30, 0, 0]], [...g.tris, [10, far, 120]])
    const out = removeLongEdges(m, { maxEdgeFactor: 4 })
    expect(out.count).toBe(200)
    expect(removeLongEdges(m, { maxEdgeFactor: 1000 }).count).toBe(201)
  })
})

describe('fillHoles', () => {
  it('closes a sphere with a removed fan: watertight, consistent, outward, volume kept', () => {
    const sphere = icosphere(3)
    const full = meshMeasure(sphere)
    const holed = compactMesh(withoutFan(sphere, 0))
    expect(meshMeasure(holed).watertight).toBe(false)
    const r = fillHoles(holed)
    expect(r.filled).toBe(1)
    expect(r.skipped).toBe(0)
    expect(r.addedVertices).toBe(1)
    const meas = meshMeasure(r.mesh)
    expect(meas.watertight).toBe(true)
    expect(meas.boundaryEdges).toBe(0)
    expect(meas.nonManifoldEdges).toBe(0)
    expect(meas.inconsistentEdges).toBe(0)
    expect(meas.volume).toBeGreaterThan(0)
    expect(Math.abs(meas.volume - full.volume) / full.volume).toBeLessThan(0.01)
    for (let t = holed.count; t < r.mesh.count; t++) expect(faceNormalDotCentroid(r.mesh, t)).toBeGreaterThan(0)
  })
  it('closes a 3-edge hole with one triangle', () => {
    const sphere = icosphere(1)
    const tris = []
    for (let t = 1; t < sphere.count; t++) tris.push([sphere.idx[t * 3], sphere.idx[t * 3 + 1], sphere.idx[t * 3 + 2]])
    const holed = makeMesh(Array.from({ length: sphere.nVerts }, (_, i) => vtx(sphere, i)), tris)
    const r = fillHoles(holed)
    expect(r.filled).toBe(1)
    expect(r.addedTriangles).toBe(1)
    expect(r.addedVertices).toBe(0)
    const meas = meshMeasure(r.mesh)
    expect(meas.watertight && meas.inconsistentEdges === 0).toBe(true)
  })
  it('fills interior holes up to maxHoleEdges and leaves the outer rim open', () => {
    // 10×10 grid with a single missing cell (4-loop) and a 2×2 missing block (8-loop).
    const skip = (i, j) => (i === 2 && j === 2) || ((i === 6 || i === 7) && (j === 6 || j === 7))
    const m = grid(10, 10, { skip, col: [10, 20, 30] })
    const r = fillHoles(m, { maxHoleEdges: 10 })
    expect(r.filled).toBe(2)
    expect(r.tooLarge).toBe(1)
    expect(r.addedTriangles).toBe(4 + 8)
    const meas = meshMeasure(r.mesh)
    expect(meas.boundaryEdges).toBe(40)
    expect(meas.inconsistentEdges).toBe(0)
    expect(meas.area).toBeCloseTo(100, 9)
    expect(Array.from(r.mesh.col.slice(-3))).toEqual([10, 20, 30])
    // maxHoleEdges = 0 ⇒ everything, the rim included.
    const all = fillHoles(m, { maxHoleEdges: 0 })
    expect(all.filled).toBe(3)
    expect(meshMeasure(all.mesh).boundaryEdges).toBe(0)
  })
  it('skips chains through a bowtie vertex without throwing', () => {
    const a = gridParts(2, 2)
    const b = gridParts(2, 2, { ox: 2, oy: 2, base: a.verts.length })
    // Weld b's (0,0) corner onto a's (2,2) corner.
    const shared = 8, dup = a.verts.length
    const trisB = b.tris.map((t) => t.map((v) => (v === dup ? shared : v)))
    const m = makeMesh([...a.verts, ...b.verts], [...a.tris, ...trisB])
    const logs = []
    const r = fillHoles(m, { maxHoleEdges: 0 }, (msg, level) => logs.push(level))
    expect(r.filled).toBe(0)
    expect(r.skipped).toBeGreaterThan(0)
    expect(r.mesh.count).toBe(m.count)
    expect(logs).toEqual(['warn'])
  })
})

describe('cleanMesh', () => {
  it('runs components → long edges → holes → compact and reports per-step stats', () => {
    const main = gridParts(10, 10, { skip: (i, j) => i === 4 && j === 4 })
    const speck = gridParts(1, 1, { ox: 50, base: main.verts.length })
    const far = main.verts.length + speck.verts.length
    const m = makeMesh([...main.verts, ...speck.verts, [30, 0, 0]],
      [...main.tris, ...speck.tris, [10, far, 120]])
    const { mesh, stats } = cleanMesh(m, { minTriangles: 10, maxEdgeFactor: 4, maxHoleEdges: 16 })
    expect(stats.components.removedComponents).toBe(1)
    expect(stats.components.removedTriangles).toBe(2)
    expect(stats.longEdges.removedTriangles).toBe(1)
    expect(stats.holes.filled).toBe(1)
    expect(stats.holes.tooLarge).toBe(1)
    expect(stats.compact.removedVertices).toBe(4 + 1) // speck corners + the bridge apex
    expect(mesh.count).toBe(198 + 4)
    expect(stats.outputTriangles).toBe(mesh.count)
    expect(meshMeasure(mesh).components).toBe(1)
  })
  it('honours the methods list and never aliases the input', () => {
    const m = grid(3, 3)
    const { mesh, stats } = cleanMesh(m, { methods: [] })
    expect(mesh).not.toBe(m)
    expect(mesh.idx).not.toBe(m.idx)
    expect(stats.components).toBeUndefined()
    expect(mesh.count).toBe(18)
  })
})

describe('taubinSmooth', () => {
  it('keeps a clean sphere radius within 1% after 10 iterations', () => {
    const s = icosphere(3)
    const out = taubinSmooth(s, { iterations: 10 })
    const r = radii(out)
    expect(Math.abs(mean(r) - 1)).toBeLessThan(0.01)
    expect(out.count).toBe(s.count)
    expect(Array.from(out.idx)).toEqual(Array.from(s.idx))
  })
  it('reduces radial noise on a noisy sphere without shrinking it', () => {
    const s = icosphere(4)
    let seed = 7
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
    const noisy = { ...s, pos: new Float64Array(s.pos) }
    for (let v = 0; v < s.nVerts; v++) {
      const k = 1 + (rnd() - 0.5) * 0.04
      for (let a = 0; a < 3; a++) noisy.pos[v * 3 + a] *= k
    }
    const before = std(radii(noisy))
    const snapshot = Array.from(noisy.pos)
    const out = taubinSmooth(noisy, { iterations: 10 })
    const r = radii(out)
    expect(std(r)).toBeLessThan(before * 0.5)
    expect(Math.abs(mean(r) - 1)).toBeLessThan(0.01)
    expect(Array.from(noisy.pos)).toEqual(snapshot) // input not mutated
  })
  it('fixes boundary vertices of an open grid', () => {
    const m = grid(6, 6, { z: (i, j) => ((i * 7 + j * 3) % 5) * 0.1 })
    const out = taubinSmooth(m, { iterations: 5 })
    const free = taubinSmooth(m, { iterations: 5, fixBoundary: false })
    expect(vtx(out, 0)).toEqual(vtx(m, 0))
    expect(vtx(out, 6)).toEqual(vtx(m, 6))
    expect(vtx(free, 0)).not.toEqual(vtx(m, 0))
    expect(vtx(out, 8)).not.toEqual(vtx(m, 8)) // interior moved
  })
  it('stays exact at survey coordinates', () => {
    const s = icosphere(2)
    const shifted = { ...s, pos: s.pos.map((x, i) => x + (i % 3 === 2 ? 0 : 1e6)) }
    const a = taubinSmooth(s, { iterations: 3 }), b = taubinSmooth(shifted, { iterations: 3 })
    for (let i = 0; i < a.pos.length; i++) expect(Math.abs(b.pos[i] - (i % 3 === 2 ? 0 : 1e6) - a.pos[i])).toBeLessThan(1e-8)
  })
})

describe('cropMesh', () => {
  const m = grid(10, 10)
  it('keeps triangles fully inside, null bounds unbounded', () => {
    const out = cropMesh(m, { min: [null, undefined, NaN], max: [5, null, null] })
    expect(out.count).toBe(100)
    expect(out.nVerts).toBe(6 * 11)
    for (let v = 0; v < out.nVerts; v++) expect(out.pos[v * 3]).toBeLessThanOrEqual(5)
  })
  it('invert keeps triangles with any vertex outside, complementing the crop', () => {
    const inside = cropMesh(m, { min: [2, 2], max: [5, 5] })
    const outside = cropMesh(m, { min: [2, 2], max: [5, 5], invert: true })
    expect(inside.count).toBe(18)
    expect(inside.count + outside.count).toBe(200)
  })
  it('an empty box keeps nothing', () => {
    const out = cropMesh(m, { min: [100, 100, 100] })
    expect(out.count).toBe(0)
    expect(out.nVerts).toBe(0)
  })
})

describe('sampleMesh', () => {
  it('samples the requested count on the surface with unit outward normals', () => {
    const s = icosphere(3)
    const c = sampleMesh(s, { count: 5000, seed: 3 })
    expect(c.count).toBe(5000)
    expect(c.pos).toBeInstanceOf(Float64Array)
    expect(c.nrm).toBeInstanceOf(Float32Array)
    expect(c.col).toBeNull()
    for (let i = 0; i < c.count; i++) {
      const p = [c.pos[i * 3], c.pos[i * 3 + 1], c.pos[i * 3 + 2]]
      const r = Math.hypot(...p)
      expect(Math.abs(r - 1)).toBeLessThan(0.01)
      const n = [c.nrm[i * 3], c.nrm[i * 3 + 1], c.nrm[i * 3 + 2]]
      expect(Math.abs(Math.hypot(...n) - 1)).toBeLessThan(1e-6)
      expect(n[0] * p[0] + n[1] * p[1] + n[2] * p[2]).toBeGreaterThan(0.9)
    }
  })
  it('is deterministic per seed', () => {
    const s = icosphere(2)
    const a = sampleMesh(s, { count: 200, seed: 42 }), b = sampleMesh(s, { count: 200, seed: 42 })
    const c = sampleMesh(s, { count: 200, seed: 43 })
    expect(Array.from(a.pos)).toEqual(Array.from(b.pos))
    expect(Array.from(a.pos)).not.toEqual(Array.from(c.pos))
  })
  it('is area-uniform, stays in the plane and interpolates colour', () => {
    const m = grid(10, 10, { col: [100, 150, 200] })
    const c = sampleMesh(m, { count: 20000, seed: 9 })
    let left = 0
    for (let i = 0; i < c.count; i++) {
      expect(c.pos[i * 3 + 2]).toBe(0)
      expect(c.pos[i * 3]).toBeGreaterThanOrEqual(0)
      expect(c.pos[i * 3]).toBeLessThanOrEqual(10)
      if (c.pos[i * 3] < 5) left++
    }
    expect(Math.abs(left / c.count - 0.5)).toBeLessThan(0.02)
    expect(Array.from(c.col.slice(0, 6))).toEqual([100, 150, 200, 100, 150, 200])
    expect(c.nrm[2]).toBeCloseTo(1, 6)
  })
  it('returns an empty cloud for an empty mesh or count 0', () => {
    expect(sampleMesh(grid(2, 2), { count: 0 }).count).toBe(0)
    expect(sampleMesh({ nVerts: 0, count: 0, pos: new Float64Array(0), idx: new Uint32Array(0), col: null }).count).toBe(0)
  })
})

describe('meshMeasure', () => {
  it('unit cube: area 6, volume 1, watertight', () => {
    const m = meshMeasure(cube())
    expect(m.area).toBeCloseTo(6, 12)
    expect(m.volume).toBeCloseTo(1, 12)
    expect(m.watertight).toBe(true)
    expect(m.components).toBe(1)
    expect(m.triangles).toBe(12)
    expect(m.vertices).toBe(8)
  })
  it('stays accurate at a 1e6 offset', () => {
    const m = meshMeasure(cube(1e6))
    expect(Math.abs(m.area - 6) / 6).toBeLessThan(1e-6)
    expect(Math.abs(m.volume - 1)).toBeLessThan(1e-6)
  })
  it('Float32 positions measure too', () => {
    const c = cube()
    const m = meshMeasure({ ...c, pos: new Float32Array(c.pos) })
    expect(m.volume).toBeCloseTo(1, 6)
  })
  it('reports null volume on an open mesh and counts components', () => {
    const a = gridParts(2, 2)
    const b = gridParts(2, 2, { ox: 10, base: a.verts.length })
    const m = meshMeasure(makeMesh([...a.verts, ...b.verts], [...a.tris, ...b.tris]))
    expect(m.watertight).toBe(false)
    expect(m.volume).toBeNull()
    expect(m.boundaryEdges).toBe(16)
    expect(m.components).toBe(2)
    expect(m.area).toBeCloseTo(8, 12)
  })
  it('sphere volume approaches 4/3π', () => {
    const m = meshMeasure(icosphere(4))
    expect(Math.abs(m.volume - 4 / 3 * Math.PI) / (4 / 3 * Math.PI)).toBeLessThan(0.01)
  })
})

describe('performance smoke', () => {
  it('cleans + smooths a ~200k-triangle grid quickly', () => {
    const n = 316
    const m = grid(n, n, {
      skip: (i, j) => (i % 50 === 25 && j % 50 === 25),
      z: (i, j) => Math.sin(i * 0.1) * Math.cos(j * 0.1) + ((i * 31 + j * 17) % 7) * 0.01,
      col: [128, 128, 128],
    })
    const t0 = performance.now()
    const { mesh, stats } = cleanMesh(m, { minFraction: 0.01, maxEdgeFactor: 4, maxHoleEdges: 64 })
    const t1 = performance.now()
    const smooth = taubinSmooth(mesh, { iterations: 10 })
    const t2 = performance.now()
    const meas = meshMeasure(smooth)
    const t3 = performance.now()
    console.log(`meshEdit perf: ${m.count} tris — clean ${(t1 - t0).toFixed(0)} ms, `
      + `smooth ${(t2 - t1).toFixed(0)} ms, measure ${(t3 - t2).toFixed(0)} ms`)
    expect(m.count).toBeGreaterThan(195000)
    expect(stats.holes.filled).toBe(36)
    expect(meas.boundaryEdges).toBe(4 * n)
    expect(t3 - t0).toBeLessThan(8000)
  })
})
