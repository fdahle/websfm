import { describe, it, expect } from 'vitest'
import { decimateMesh } from './meshDecimate.js'

// ── Synthetic meshes ─────────────────────────────────────────────────────────

// Icosphere: icosahedron + `level` midpoint subdivisions, projected to radius r.
// Closed, manifold, outward-oriented (CCW seen from outside); 20·4^level triangles.
function icosphere(level, r = 1, center = [0, 0, 0]) {
  const t = (1 + Math.sqrt(5)) / 2
  const verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(normalize)
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]
  for (let l = 0; l < level; l++) {
    const cache = new Map()
    const mid = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`
      let m = cache.get(key)
      if (m === undefined) {
        const va = verts[a], vb = verts[b]
        m = verts.length
        verts.push(normalize([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]))
        cache.set(key, m)
      }
      return m
    }
    const nf = []
    for (const [a, b, c] of faces) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a)
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca])
    }
    faces = nf
  }
  const pos = new Float64Array(verts.length * 3)
  verts.forEach((v, i) => { for (let k = 0; k < 3; k++) pos[i * 3 + k] = v[k] * r + center[k] })
  const idx = new Uint32Array(faces.length * 3)
  faces.forEach((f, i) => { idx[i * 3] = f[0]; idx[i * 3 + 1] = f[1]; idx[i * 3 + 2] = f[2] })
  const col = new Uint8Array(verts.length * 3)
  for (let i = 0; i < verts.length; i++) {
    col[i * 3] = Math.round((verts[i][0] + 1) * 127.5)
    col[i * 3 + 1] = Math.round((verts[i][1] + 1) * 127.5)
    col[i * 3 + 2] = Math.round((verts[i][2] + 1) * 127.5)
  }
  return { nVerts: verts.length, count: faces.length, pos, idx, col }
}

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}

// UV sphere with single-vertex poles: closed manifold, 2·nLon·(nLat−1) triangles.
// Typed arrays throughout so a ~2 M triangle bench mesh builds quickly.
function uvSphere(nLat, nLon, r = 1) {
  const ring = (nLat - 1) * nLon
  const nV = ring + 2
  const pos = new Float64Array(nV * 3)
  for (let i = 1; i < nLat; i++) {
    const th = Math.PI * i / nLat
    for (let j = 0; j < nLon; j++) {
      const ph = 2 * Math.PI * j / nLon
      const v = (i - 1) * nLon + j
      pos[v * 3] = r * Math.sin(th) * Math.cos(ph)
      pos[v * 3 + 1] = r * Math.sin(th) * Math.sin(ph)
      pos[v * 3 + 2] = r * Math.cos(th)
    }
  }
  const N = ring, S = ring + 1
  pos[N * 3 + 2] = r; pos[S * 3 + 2] = -r
  const nT = 2 * nLon * (nLat - 1)
  const idx = new Uint32Array(nT * 3)
  let o = 0
  const at = (i, j) => (i - 1) * nLon + (j % nLon)
  for (let j = 0; j < nLon; j++) { idx[o++] = N; idx[o++] = at(1, j); idx[o++] = at(1, j + 1) }
  for (let i = 1; i < nLat - 1; i++) {
    for (let j = 0; j < nLon; j++) {
      const a = at(i, j), b = at(i, j + 1), c = at(i + 1, j), d = at(i + 1, j + 1)
      idx[o++] = a; idx[o++] = c; idx[o++] = b
      idx[o++] = b; idx[o++] = c; idx[o++] = d
    }
  }
  for (let j = 0; j < nLon; j++) { idx[o++] = S; idx[o++] = at(nLat - 1, j + 1); idx[o++] = at(nLat - 1, j) }
  return { nVerts: nV, count: nT, pos, idx, col: null }
}

// Flat n×n-cell grid in z = 0 (integer spacing so an offset copy is bit-comparable),
// normals +z, open square boundary [0,n]².
function grid(n, offset = 0) {
  const nV = (n + 1) * (n + 1)
  const pos = new Float64Array(nV * 3)
  const col = new Uint8Array(nV * 3)
  for (let y = 0; y <= n; y++) {
    for (let x = 0; x <= n; x++) {
      const v = y * (n + 1) + x
      pos[v * 3] = x + offset; pos[v * 3 + 1] = y + offset; pos[v * 3 + 2] = offset
      col[v * 3] = (x * 7) & 255; col[v * 3 + 1] = (y * 5) & 255; col[v * 3 + 2] = 128
    }
  }
  const idx = new Uint32Array(n * n * 6)
  let o = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1
      idx[o++] = a; idx[o++] = b; idx[o++] = d
      idx[o++] = a; idx[o++] = d; idx[o++] = c
    }
  }
  return { nVerts: nV, count: n * n * 2, pos, idx, col }
}

// ── Analysis helpers ─────────────────────────────────────────────────────────

function edgeUse(mesh) {
  const m = new Map()
  const { idx, count, nVerts } = mesh
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k], b = idx[t * 3 + ((k + 1) % 3)]
      const key = a < b ? a * nVerts + b : b * nVerts + a
      m.set(key, (m.get(key) || 0) + 1)
    }
  }
  return m
}

function triNormal(mesh, t) {
  const { pos, idx } = mesh
  const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3
  const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2]
  const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2]
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
}

function checkShape(mesh) {
  expect(mesh.pos).toBeInstanceOf(Float64Array)
  expect(mesh.idx).toBeInstanceOf(Uint32Array)
  expect(mesh.pos.length).toBe(mesh.nVerts * 3)
  expect(mesh.idx.length).toBe(mesh.count * 3)
  if (mesh.col) expect(mesh.col.length).toBe(mesh.nVerts * 3)
  // Compacted: every vertex referenced, no repeated-index or zero-area triangle.
  const used = new Uint8Array(mesh.nVerts)
  let degenerate = 0
  for (let t = 0; t < mesh.count; t++) {
    const a = mesh.idx[t * 3], b = mesh.idx[t * 3 + 1], c = mesh.idx[t * 3 + 2]
    expect(Math.max(a, b, c)).toBeLessThan(mesh.nVerts)
    used[a] = used[b] = used[c] = 1
    const n = triNormal(mesh, t)
    if (a === b || b === c || a === c || Math.hypot(n[0], n[1], n[2]) === 0) degenerate++
  }
  expect(degenerate).toBe(0)
  expect(used.every((u) => u === 1)).toBe(true)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('decimateMesh — sphere', () => {
  const sphere = icosphere(5) // 20480 triangles
  const snapshot = { pos: sphere.pos.slice(), idx: sphere.idx.slice(), col: sphere.col.slice() }
  const { mesh: out, stats } = decimateMesh(sphere, { targetRatio: 0.1 })

  it('reaches the target count', () => {
    expect(stats.before).toBe(20480)
    expect(stats.after).toBe(out.count)
    expect(out.count).toBeLessThanOrEqual(2048)
    expect(out.count).toBeGreaterThanOrEqual(2048 - 2)
    expect(stats.collapses).toBeGreaterThan(0)
    expect(stats.maxError).toBeGreaterThan(0)
    checkShape(out)
  })

  it('does not mutate its input', () => {
    expect(sphere.pos).toEqual(snapshot.pos)
    expect(sphere.idx).toEqual(snapshot.idx)
    expect(sphere.col).toEqual(snapshot.col)
  })

  it('keeps every vertex within 2% of the radius', () => {
    let worst = 0
    for (let v = 0; v < out.nVerts; v++) {
      const r = Math.hypot(out.pos[v * 3], out.pos[v * 3 + 1], out.pos[v * 3 + 2])
      worst = Math.max(worst, Math.abs(r - 1))
    }
    expect(worst).toBeLessThan(0.02)
  })

  it('stays closed and 2-manifold', () => {
    const use = edgeUse(out)
    for (const n of use.values()) expect(n).toBe(2)
    // Euler characteristic of a sphere.
    expect(out.nVerts - use.size + out.count).toBe(2)
  })

  it('flips no triangle against the outward normal', () => {
    for (let t = 0; t < out.count; t++) {
      const n = triNormal(out, t)
      const a = out.idx[t * 3] * 3
      const dot = n[0] * out.pos[a] + n[1] * out.pos[a + 1] + n[2] * out.pos[a + 2]
      expect(dot).toBeGreaterThan(0)
    }
  })

  it('carries a colour per output vertex', () => {
    expect(out.col).toBeInstanceOf(Uint8Array)
    expect(out.col.length).toBe(out.nVerts * 3)
    // Colour encodes the direction; it must still roughly match the vertex position.
    let worst = 0
    for (let v = 0; v < out.nVerts; v++) {
      const p = normalize([out.pos[v * 3], out.pos[v * 3 + 1], out.pos[v * 3 + 2]])
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out.col[v * 3 + k] / 127.5 - 1 - p[k]))
    }
    expect(worst).toBeLessThan(0.25)
  })

  it('is deterministic', () => {
    const again = decimateMesh(sphere, { targetRatio: 0.1 }).mesh
    expect(again.count).toBe(out.count)
    expect(again.pos).toEqual(out.pos)
    expect(again.idx).toEqual(out.idx)
    expect(again.col).toEqual(out.col)
  })

  it('honours targetTriangles and a Float32 input', () => {
    const f32 = { ...sphere, pos: Float32Array.from(sphere.pos), col: null }
    const { mesh } = decimateMesh(f32, { targetTriangles: 5000 })
    expect(mesh.count).toBeLessThanOrEqual(5000)
    expect(mesh.count).toBeGreaterThanOrEqual(4998)
    expect(mesh.col).toBeNull()
    checkShape(mesh)
  })

  it('stops at maxError before the target', () => {
    const { mesh, stats } = decimateMesh(sphere, { targetRatio: 0.01, maxError: 1e-3 })
    expect(mesh.count).toBeGreaterThan(205)
    expect(stats.maxError).toBeLessThanOrEqual(1e-3)
  })

  it('rejects ambiguous targets', () => {
    expect(() => decimateMesh(sphere, {})).toThrow()
    expect(() => decimateMesh(sphere, { targetRatio: 0.5, targetTriangles: 10 })).toThrow()
  })

  it('returns an unchanged copy when the target is not below the count', () => {
    const { mesh, stats } = decimateMesh(sphere, { targetRatio: 1 })
    expect(stats.collapses).toBe(0)
    expect(mesh.count).toBe(sphere.count)
    expect(mesh.pos).toEqual(sphere.pos)
  })
})

describe('decimateMesh — planar grid', () => {
  const N = 40
  const L = N
  const plane = grid(N) // 3200 triangles
  const logs = []
  const { mesh: out } = decimateMesh(plane, { targetRatio: 0.1 }, (m, level, source) => logs.push({ m, level, source }))

  // Boundary vertices of the output (endpoints of edges used once).
  function boundaryVerts(mesh) {
    const use = edgeUse(mesh)
    const set = new Set()
    for (const [key, n] of use) {
      if (n !== 1) continue
      set.add(Math.floor(key / mesh.nVerts)); set.add(key % mesh.nVerts)
    }
    return set
  }

  it('reaches the target and stays a clean mesh', () => {
    expect(out.count).toBeLessThanOrEqual(320)
    expect(out.count).toBeGreaterThanOrEqual(318)
    checkShape(out)
    for (const n of edgeUse(out).values()) expect(n).toBeLessThanOrEqual(2)
    expect(logs.some((l) => l.level === 'success' && l.source === 'Products')).toBe(true)
  })

  it('stays exactly planar', () => {
    for (let v = 0; v < out.nVerts; v++) expect(Math.abs(out.pos[v * 3 + 2])).toBeLessThan(1e-9)
  })

  it('keeps the outer outline', () => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let v = 0; v < out.nVerts; v++) {
      minX = Math.min(minX, out.pos[v * 3]); maxX = Math.max(maxX, out.pos[v * 3])
      minY = Math.min(minY, out.pos[v * 3 + 1]); maxY = Math.max(maxY, out.pos[v * 3 + 1])
    }
    expect([minX, minY, maxX, maxY]).toEqual([0, 0, L, L])
    const onLine = (x, y) => Math.min(Math.abs(x), Math.abs(x - L), Math.abs(y), Math.abs(y - L)) < 1e-9
    const bv = boundaryVerts(out)
    expect(bv.size).toBeGreaterThanOrEqual(4)
    for (const v of bv) expect(onLine(out.pos[v * 3], out.pos[v * 3 + 1])).toBe(true)
    // All four corners survive.
    for (const [cx, cy] of [[0, 0], [L, 0], [0, L], [L, L]]) {
      let found = false
      for (let v = 0; v < out.nVerts; v++) if (out.pos[v * 3] === cx && out.pos[v * 3 + 1] === cy) found = true
      expect(found).toBe(true)
    }
    // Area is preserved exactly (the square is still tiled).
    let area = 0
    for (let t = 0; t < out.count; t++) area += triNormal(out, t)[2] / 2
    expect(area).toBeCloseTo(L * L, 6)
  })

  it('flips no triangle (all normals stay +z)', () => {
    for (let t = 0; t < out.count; t++) expect(triNormal(out, t)[2]).toBeGreaterThan(0)
  })

  it('behaves the same 1e6 away from the origin', () => {
    const OFF = 1e6
    const far = decimateMesh(grid(N, OFF), { targetRatio: 0.1 }).mesh
    expect(far.count).toBe(out.count)
    expect(far.nVerts).toBe(out.nVerts)
    expect(far.idx).toEqual(out.idx)
    for (let i = 0; i < far.pos.length; i++) expect(Math.abs(far.pos[i] - OFF - out.pos[i])).toBeLessThan(1e-6)
    for (let v = 0; v < far.nVerts; v++) expect(Math.abs(far.pos[v * 3 + 2] - OFF)).toBeLessThan(1e-9)
  })

  it('erodes the border without the boundary constraint only where it is free to', () => {
    // Without the constraint the result is still a valid planar mesh.
    const { mesh } = decimateMesh(plane, { targetRatio: 0.1, preserveBoundary: false })
    checkShape(mesh)
    for (let v = 0; v < mesh.nVerts; v++) expect(Math.abs(mesh.pos[v * 3 + 2])).toBeLessThan(1e-9)
  })
})

describe('decimateMesh — performance', () => {
  it('decimates a ~200k-triangle grid in reasonable time', () => {
    const g = grid(316) // 199,712 triangles
    const t0 = performance.now()
    const { mesh, stats } = decimateMesh(g, { targetRatio: 0.1 })
    const ms = performance.now() - t0
    expect(mesh.count).toBeLessThanOrEqual(Math.round(g.count * 0.1))
    expect(stats.after).toBe(mesh.count)
    expect(ms).toBeLessThan(30000)
  }, 60000)

  it.skipIf(!process.env.BENCH)('bench: ~2M-triangle sphere → 10%', () => {
    for (const [label, m] of [['grid 200k', grid(316)], ['icosphere 327k', icosphere(7)], ['uv sphere 2M', uvSphere(708, 1414)]]) {
      const t0 = performance.now()
      const { stats } = decimateMesh(m, { targetRatio: 0.1 })
      const ms = performance.now() - t0
      console.log(`[bench] ${label}: ${stats.before} → ${stats.after} tris, ${stats.collapses} collapses, `
        + `max error ${stats.maxError.toExponential(2)}, ${Math.round(ms)} ms`)
    }
  }, 600000)
})
