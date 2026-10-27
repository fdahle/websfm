import { describe, it, expect } from 'vitest'
import { planMeshBlocks, blockMesh, joinBlocks, BLOCK_HEADROOM } from './meshBlocks.js'
import { decimateMesh } from './meshDecimate.js'
import { cloudToMeshDistance } from './cloudDistance.js'

// A W×W rolling terrain grid, 2 triangles per cell.
function terrain(W) {
  const pos = new Float64Array(3 * W * W)
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const j = y * W + x
      pos[3 * j] = x
      pos[3 * j + 1] = y
      pos[3 * j + 2] = 3 * Math.sin(x / 9) * Math.cos(y / 7) + 0.3 * Math.sin(x / 2 + y / 3)
    }
  const idx = new Uint32Array(6 * (W - 1) * (W - 1))
  let k = 0
  for (let y = 0; y < W - 1; y++)
    for (let x = 0; x < W - 1; x++) {
      const a = y * W + x
      idx.set([a, a + 1, a + W, a + 1, a + W + 1, a + W], k)
      k += 6
    }
  return { nVerts: W * W, count: idx.length / 3, pos, idx, col: null }
}

// Decimate as the store's pool path does it, one block after another.
function decimateInBlocks(mesh, blocks, target) {
  const { parts, shared } = planMeshBlocks(mesh, blocks)
  const ratio = (target / mesh.count) * (1 + BLOCK_HEADROOM)
  const done = parts.map((p) => {
    const b = blockMesh(mesh, p.tris, shared)
    const r = decimateMesh(b.mesh, { targetTriangles: Math.round(p.tris.length * ratio), locked: b.locked })
    return { mesh: r.mesh, vertex: Uint32Array.from(r.sourceVertex, (v) => b.vertex[v]) }
  })
  const joined = joinBlocks(done, shared)
  return { parts, shared, joined, mesh: decimateMesh(joined, { targetTriangles: target }).mesh }
}

// Edges of one triangle only.
function openEdges(mesh) {
  const n = new Map()
  for (let t = 0; t < mesh.count; t++)
    for (let c = 0; c < 3; c++) {
      const a = mesh.idx[3 * t + c],
        b = mesh.idx[3 * t + ((c + 1) % 3)]
      const k = a < b ? `${a},${b}` : `${b},${a}`
      n.set(k, (n.get(k) ?? 0) + 1)
    }
  let open = 0
  for (const v of n.values()) if (v === 1) open++
  return open
}

const rms = (mesh, ref) => {
  const d = cloudToMeshDistance({ count: ref.nVerts, pos: ref.pos }, mesh, { signed: false }).distance
  let s = 0
  for (const v of d) s += v * v
  return Math.sqrt(s / d.length)
}

describe('Decimate in blocks', () => {
  it('cuts the triangles into even blocks and finds the vertices they share', () => {
    const m = terrain(60)
    const { parts, shared } = planMeshBlocks(m, 4)
    expect(parts.reduce((a, p) => a + p.tris.length, 0)).toBe(m.count)
    for (const p of parts) expect(Math.abs(p.tris.length - m.count / 4)).toBeLessThan(m.count * 0.03)
    // A shared vertex is one whose triangles lie in two blocks.
    const blockOfTri = new Int32Array(m.count)
    parts.forEach((p, b) => p.tris.forEach((t) => (blockOfTri[t] = b)))
    const seen = Array.from({ length: m.nVerts }, () => new Set())
    for (let t = 0; t < m.count; t++) for (let c = 0; c < 3; c++) seen[m.idx[3 * t + c]].add(blockOfTri[t])
    for (let v = 0; v < m.nVerts; v++) expect(shared[v]).toBe(seen[v].size > 1 ? 1 : 0)
  })

  it('joins undecimated blocks back into the same mesh', () => {
    const m = terrain(30)
    const { parts, shared } = planMeshBlocks(m, 3)
    const blocks = parts.map((p) => {
      const b = blockMesh(m, p.tris, shared)
      return { mesh: b.mesh, vertex: b.vertex }
    })
    const j = joinBlocks(blocks, shared)
    expect(j.nVerts).toBe(m.nVerts)
    expect(j.count).toBe(m.count)
    // Every joined triangle is an input triangle (the same three positions).
    const key = (p, i, t) =>
      [0, 1, 2]
        .map((c) => Array.from(p.subarray(3 * i[3 * t + c], 3 * i[3 * t + c] + 3)).join(','))
        .sort()
        .join('|')
    const input = new Set(Array.from({ length: m.count }, (_, t) => key(m.pos, m.idx, t)))
    for (let t = 0; t < j.count; t++) expect(input.has(key(j.pos, j.idx, t))).toBe(true)
  })

  it('reaches the target with the error of one pass over the whole mesh', () => {
    const m = terrain(120)
    const target = Math.round(m.count * 0.25)
    const whole = decimateMesh(m, { targetTriangles: target }).mesh
    const r = decimateInBlocks(m, 4, target)
    // A collapse takes two triangles, so the count may land one short.
    expect(Math.abs(r.mesh.count - target)).toBeLessThanOrEqual(1)
    expect(r.joined.count).toBeGreaterThan(target)
    // The locked seams met (no crack, which would be an open edge inside the mesh): the
    // open edges are the grid's outline, about as finely cut as one pass leaves it.
    expect(openEdges(r.mesh)).toBeLessThan(openEdges(whole) * 1.3)
    expect(rms(r.mesh, m)).toBeLessThan(rms(whole, m) * 1.1)
  }, 60_000)
})
