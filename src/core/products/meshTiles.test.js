import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import initMesh, { PoissonMesher } from '../../wasm/mesh/mesh.js'
import { parseMeshBuffer } from './mesh.js'
import {
  TRIM_DENSITY_BACKOFF,
  cutToCore,
  dropSmallPieces,
  planMeshTiles,
  poissonGrid,
  stitchTiles,
  supportMedian,
  tileInput,
} from './meshTiles.js'

// The real 32-bit solver (crates/mesh), on a smooth synthetic terrain.
beforeAll(async () => {
  const url = new URL('../../wasm/mesh/mesh_bg.wasm', import.meta.url)
  await initMesh({ module_or_path: await readFile(fileURLToPath(url)) })
})

function terrain(n = 12000, seed = 7) {
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32
  const pos = new Float32Array(3 * n),
    nrm = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    const x = rnd() * 40,
      y = rnd() * 30
    const gx = (2 / 6) * Math.cos(x / 6) * Math.cos(y / 8),
      gy = (-2 / 8) * Math.sin(x / 6) * Math.sin(y / 8)
    const m = Math.hypot(gx, gy, 1)
    pos.set([x, y, 2 * Math.sin(x / 6) * Math.cos(y / 8)], 3 * i)
    nrm.set([-gx / m, -gy / m, 1 / m], 3 * i)
  }
  return { pos, nrm, wgt: null }
}

const DEPTH = 7
const solve = (input, grid) => {
  const m = grid
    ? PoissonMesher.build_on_grid(input.pos, input.nrm, input.wgt ?? new Float32Array(0), DEPTH, 4, grid)
    : PoissonMesher.build(input.pos, input.nrm, new Float32Array(0), DEPTH, 4)
  for (let L = m.num_layers(), i = 0; i < L; i++) m.solve_step()
  const bytes = m.finish(0, 0.1, 0.05, 0, 0)
  m.free()
  return parseMeshBuffer(bytes)
}

// Nearest-vertex distance from each of `a`'s vertices to `b` (brute force on a grid).
function nearest(a, b, cell) {
  const grid = new Map()
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
  for (let i = 0; i < b.length; i += 3) {
    const k = key(b[i], b[i + 1], b[i + 2])
    if (!grid.has(k)) grid.set(k, [])
    grid.get(k).push(i)
  }
  const d = []
  for (let i = 0; i < a.length; i += 3) {
    let best = Infinity
    const [cx, cy, cz] = [a[i], a[i + 1], a[i + 2]].map((v) => Math.floor(v / cell))
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? [])
            best = Math.min(best, Math.hypot(a[i] - b[j], a[i + 1] - b[j + 1], a[i + 2] - b[j + 2]))
    d.push(best)
  }
  return d.sort((p, q) => p - q)
}

// Open edges (used by one triangle) among the edges whose two ends lie within a cell of a
// tile's core border, and how many such edges there are.
function openInBand(mesh, plan, grid) {
  const [a, b] = plan.axes
  const borders = [new Set(), new Set()]
  for (const t of plan.tiles) {
    for (const v of [t.core.a0, t.core.a1]) if (Number.isFinite(v)) borders[0].add(v)
    for (const v of [t.core.b0, t.core.b1]) if (Number.isFinite(v)) borders[1].add(v)
  }
  const on = (v) => {
    const c = [a, b].map((k) => Math.round((mesh.pos[3 * v + k] - grid.origin[k]) / grid.leaf))
    return [0, 1].some((i) => [...borders[i]].some((s) => Math.abs(c[i] - s) <= 1))
  }
  const uses = new Map()
  for (let t = 0; t < mesh.idx.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const p = mesh.idx[t + e],
        q = mesh.idx[t + ((e + 1) % 3)]
      if (!on(p) || !on(q)) continue
      const k = p < q ? `${p},${q}` : `${q},${p}`
      uses.set(k, (uses.get(k) ?? 0) + 1)
    }
  let open = 0
  for (const c of uses.values()) if (c === 1) open++
  return [open, uses.size]
}

describe('tiled Poisson', () => {
  it('the grid is the one the crate builds for the samples itself', () => {
    const sub = terrain(3000)
    const grid = poissonGrid(sub.pos, DEPTH)
    const g = [...grid.origin, grid.leaf]
    const a = solve(sub),
      b = solve(sub, g)
    expect(b.nTris).toBe(a.nTris)
    expect(Array.from(b.pos)).toEqual(Array.from(a.pos))
  })

  it('tiles, cut and welded, give the whole solve’s surface with closed seams', () => {
    const sub = terrain()
    const grid = poissonGrid(sub.pos, DEPTH)
    const g = [...grid.origin, grid.leaf]
    // A heap model of one byte a sample: force four tiles.
    const plan = planMeshTiles(sub.pos, DEPTH, grid, {
      heapFor: (n) => n,
      oneSolveBytes: sub.pos.length / 3 - 1,
      heapTarget: Math.ceil(sub.pos.length / 3 / 3),
      overlapCells: 8,
    })
    expect(plan.tiles.length).toBeGreaterThanOrEqual(4)
    expect(plan.axes).toEqual([0, 1])
    const parts = plan.tiles.map((t) => cutToCore(solve(tileInput(sub, plan, t, grid), g), plan, t, grid))
    const tiled = stitchTiles(parts, plan, grid)
    const whole = solve(sub, g)
    expect(tiled.seamEdges).toBeGreaterThan(50)
    // Open edges along the seams, counted the same way in both meshes: the tiles add
    // next to none to what the one-piece solve has there (where the seams meet the
    // scene's own edge). Measured: 28 vs 23 of ~3,340 band edges.
    const [tiledOpen, tiledBand] = openInBand(tiled, plan, grid)
    const [wholeOpen] = openInBand(whole, plan, grid)
    expect(tiledBand).toBeGreaterThan(1000)
    expect(tiledOpen - wholeOpen).toBeLessThan(0.005 * tiledBand)
    // The same surface (measured: median 0.007 leaf, 99th percentile 0.27, as with an
    // overlap of 16 — the tail is not the seams), and about as many triangles.
    const d = nearest(tiled.pos, whole.pos, grid.leaf)
    expect(d[Math.floor(d.length / 2)]).toBeLessThan(0.02 * grid.leaf)
    expect(d[Math.floor(d.length * 0.99)]).toBeLessThan(0.4 * grid.leaf)
    expect(Math.abs(tiled.idx.length / 3 - whole.nTris) / whole.nTris).toBeLessThan(0.02)
  })

  it('the support median is the one the crate trims against', () => {
    const sub = terrain(3000)
    const m = PoissonMesher.build(sub.pos, sub.nrm, new Float32Array(0), DEPTH, 4)
    for (let L = m.num_layers(), i = 0; i < L; i++) m.solve_step()
    m.finish(0, 0.1, 0.05, 0, 0)
    const st = m.stats()
    m.free()
    const js = supportMedian(sub.pos, null, st[10] * 2 ** TRIM_DENSITY_BACKOFF)
    expect(Math.abs(js - st[9]) / st[9]).toBeLessThan(1e-9)
  })

  it('drops a piece by the samples it explains, not by its area', () => {
    // A large triangle pair near one sample, a small triangle near forty: the small one
    // is the surface, the large one the floater.
    const pos = new Float32Array([0, 0, 0, 5, 0, 0, 0, 5, 0, 5, 5, 0, 20, 20, 20, 20.5, 20, 20, 20, 20.5, 20])
    const idx = new Uint32Array([0, 1, 2, 1, 3, 2, 4, 5, 6])
    const samples = new Float32Array([0.1, 0, 0, ...Array.from({ length: 40 }, () => [20.1, 20.1, 20]).flat()])
    const out = dropSmallPieces(pos, idx, 0.1, { samples, reach: 1 })
    expect(out.pieces).toBe(2)
    expect(out.dropped).toBe(1)
    expect(Array.from(out.idx)).toEqual([0, 1, 2])
    expect(out.pos[0]).toBe(20)
  })
})
