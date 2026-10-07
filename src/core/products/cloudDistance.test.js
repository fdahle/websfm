import { describe, it, expect } from 'vitest'
import { cloudToCloudDistance, cloudToMeshDistance, distanceStats } from './cloudDistance.js'

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const OX = 512345.5, OY = 4123456.25, OZ = 1500

// Regular grid plane z = OZ + h, optionally with up normals.
function gridPlane(G, h, { normals = false, Type = Float64Array } = {}) {
  const pos = new Type(G * G * 3), nrm = normals ? new Float32Array(G * G * 3) : undefined
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const k = (j * G + i) * 3
    pos[k] = OX + i * 0.5; pos[k + 1] = OY + j * 0.5; pos[k + 2] = OZ + h
    if (nrm) nrm[k + 2] = 1
  }
  return { count: G * G, pos, nrm }
}

// Unit-ish quad [0,10]² at z = OZ as two triangles, wound counter-clockwise from +z.
function quad({ flip = false } = {}) {
  const pos = new Float64Array([OX, OY, OZ, OX + 10, OY, OZ, OX + 10, OY + 10, OZ, OX, OY + 10, OZ])
  const idx = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]
  return { nVerts: 4, count: 2, pos, idx: Uint32Array.from(idx) }
}

// Reference point–triangle distance, deliberately a different algorithm from Ericson's.
function refTriDist(q, a, b, c) {
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]]
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  const n = cross(sub(b, a), sub(c, a)), nn = dot(n, n)
  const h = dot(sub(q, a), n) / nn
  const pr = [q[0] - h * n[0], q[1] - h * n[1], q[2] - h * n[2]]
  const inside = [[a, b], [b, c], [c, a]].every(([u, v]) => dot(cross(sub(v, u), sub(pr, u)), n) >= 0)
  if (inside) return Math.abs(h) * Math.sqrt(nn)
  const seg = (u, v) => {
    const d = sub(v, u), t = Math.max(0, Math.min(1, dot(sub(q, u), d) / dot(d, d)))
    return Math.hypot(q[0] - u[0] - t * d[0], q[1] - u[1] - t * d[1], q[2] - u[2] - t * d[2])
  }
  return Math.min(seg(a, b), seg(b, c), seg(c, a))
}

const pts = (list) => ({ count: list.length, pos: Float64Array.from(list.flat()) })

describe('cloudToCloudDistance', () => {
  it('plane vs plane offset by 0.3: unsigned, signed by normals, and below', () => {
    const ref = gridPlane(30, 0, { normals: true })
    const above = gridPlane(30, 0.3)
    const below = gridPlane(30, -0.3, { Type: Float32Array })
    const u = cloudToCloudDistance(above, { count: ref.count, pos: ref.pos })
    expect(u.signed).toBe(false)
    for (const d of u.distance) expect(d).toBeCloseTo(0.3, 6)
    const s = cloudToCloudDistance(above, ref)
    expect(s.signed).toBe(true)
    for (const d of s.distance) expect(d).toBeCloseTo(0.3, 6)
    const b = cloudToCloudDistance(below, ref)
    // Float32 source at OY ~4e6 quantizes y to 0.25 m — the nearest point is then up to
    // 0.25 m off in y, so only the sign is exact here; z is what this case checks.
    for (const d of b.distance) expect(d).toBeLessThan(0)
    expect(b.stats.validCount).toBe(900)
    expect(s.stats.mean).toBeCloseTo(0.3, 6)
    expect(s.stats.p95).toBeCloseTo(0.3, 6)
  })

  it('maxDistance → NaN; explicit signed without normals stays unsigned with a warning', () => {
    const ref = gridPlane(10, 0)
    const src = pts([[OX + 1, OY + 1, OZ + 0.2], [OX + 1, OY + 1, OZ + 5]])
    const logs = []
    const r = cloudToCloudDistance(src, ref, { maxDistance: 1, signed: true }, (m, l) => logs.push([m, l]))
    expect(r.distance[0]).toBeCloseTo(0.2, 6)
    expect(Number.isNaN(r.distance[1])).toBe(true)
    expect(r.stats.validCount).toBe(1)
    expect(r.signed).toBe(false)
    expect(logs.some(([m, l]) => l === 'warn' && /no normals/.test(m))).toBe(true)
  })

  it('k ≥ 3 measures to the local plane, removing the spacing floor', () => {
    // A sparse 2 m grid; the query sits between points, 0.1 above the plane.
    const G = 10, pos = new Float64Array(G * G * 3), nrm = new Float32Array(G * G * 3)
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const k = (j * G + i) * 3
      pos[k] = OX + 2 * i; pos[k + 1] = OY + 2 * j; pos[k + 2] = OZ; nrm[k + 2] = 1
    }
    const ref = { count: G * G, pos, nrm }
    const src = pts([[OX + 9, OY + 9, OZ + 0.1], [OX + 9, OY + 9, OZ - 0.1]])
    const nn = cloudToCloudDistance(src, ref)
    expect(nn.distance[0]).toBeCloseTo(Math.hypot(1, 1, 0.1), 5)
    const pl = cloudToCloudDistance(src, ref, { k: 8 })
    expect(pl.distance[0]).toBeCloseTo(0.1, 6)
    expect(pl.distance[1]).toBeCloseTo(-0.1, 6)
  })

  it('empty inputs give all-NaN', () => {
    const r = cloudToCloudDistance(pts([[0, 0, 0]]), { count: 0, pos: new Float64Array(0) })
    expect(Number.isNaN(r.distance[0])).toBe(true)
    expect(r.stats.validCount).toBe(0)
  })
})

describe('cloudToMeshDistance', () => {
  it('points over the quad get their height, signed by winding', () => {
    const src = pts([[OX + 2, OY + 7, OZ + 1.5], [OX + 8, OY + 1, OZ + 0.25], [OX + 5, OY + 5, OZ - 2]])
    const r = cloudToMeshDistance(src, quad())
    expect(r.distance[0]).toBeCloseTo(1.5, 6)
    expect(r.distance[1]).toBeCloseTo(0.25, 6)
    expect(r.distance[2]).toBeCloseTo(-2, 6)
    const f = cloudToMeshDistance(src, quad({ flip: true }))
    expect(f.distance[0]).toBeCloseTo(-1.5, 6)
    expect(f.distance[2]).toBeCloseTo(2, 6)
    const u = cloudToMeshDistance(src, quad(), { signed: false })
    expect(u.distance[2]).toBeCloseTo(2, 6)
  })

  it('points beyond an edge or corner get the Euclidean distance to it', () => {
    const src = pts([
      [OX + 13, OY + 4, OZ + 4], // beyond x = 10 edge: hypot(3, 4) = 5
      [OX - 1, OY + 5, OZ], // beyond x = 0 edge, in-plane: 1
      [OX + 12, OY + 12, OZ + 1], // beyond the corner: hypot(2, 2, 1) = 3
    ])
    const r = cloudToMeshDistance(src, quad())
    expect(r.distance[0]).toBeCloseTo(5, 6)
    expect(r.distance[1]).toBeCloseTo(1, 6)
    expect(r.distance[2]).toBeCloseTo(3, 6)
  })

  it('maxDistance → NaN', () => {
    const r = cloudToMeshDistance(pts([[OX + 5, OY + 5, OZ + 0.5], [OX + 5, OY + 5, OZ + 50]]), quad(), { maxDistance: 1 })
    expect(r.distance[0]).toBeCloseTo(0.5, 6)
    expect(Number.isNaN(r.distance[1])).toBe(true)
  })

  it('matches brute force on a curved mesh with mixed triangle sizes', () => {
    // Bumpy grid plus one huge sliver triangle far off — exercises the radius tiers.
    const G = 30, pos = [], idx = []
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) pos.push(OX + i, OY + j, OZ + Math.sin(i / 3) * Math.cos(j / 4) * 2)
    for (let j = 0; j < G - 1; j++) for (let i = 0; i < G - 1; i++) {
      const a = j * G + i
      idx.push(a, a + 1, a + G + 1, a, a + G + 1, a + G)
    }
    const v0 = pos.length / 3
    pos.push(OX - 200, OY - 50, OZ + 30, OX + 200, OY - 50, OZ + 30, OX, OY - 40, OZ + 31)
    idx.push(v0, v0 + 1, v0 + 2)
    const mesh = { nVerts: pos.length / 3, count: idx.length / 3, pos: Float64Array.from(pos), idx: Uint32Array.from(idx) }
    const r = rng(9), list = []
    for (let i = 0; i < 400; i++) list.push([OX - 20 + 70 * r(), OY - 60 + 100 * r(), OZ - 10 + 50 * r()])
    const src = pts(list)
    const got = cloudToMeshDistance(src, mesh, { signed: false })
    // Brute force with an independent method: plane projection when it falls inside
    // the triangle, else the nearest of the three edges.
    for (let p = 0; p < list.length; p++) {
      let best = Infinity
      for (let f = 0; f < mesh.count; f++) {
        const [a, b, c] = [0, 1, 2].map((k) => [...mesh.pos.subarray(mesh.idx[f * 3 + k] * 3, mesh.idx[f * 3 + k] * 3 + 3)])
        best = Math.min(best, refTriDist(list[p], a, b, c))
      }
      expect(got.distance[p]).toBeCloseTo(best, 4)
    }
  })

  it('single-triangle distances agree with a dense sampling of the triangle', () => {
    const tri = { nVerts: 3, count: 1, pos: new Float64Array([0, 0, 0, 4, 0, 0, 1, 3, 0.5]), idx: Uint32Array.from([0, 1, 2]) }
    const r = rng(4)
    for (let k = 0; k < 50; k++) {
      const q = [-3 + 10 * r(), -3 + 9 * r(), -3 + 6 * r()]
      const d = cloudToMeshDistance(pts([q]), tri, { signed: false }).distance[0]
      let best = Infinity
      const S = 300
      for (let a = 0; a <= S; a++) for (let b = 0; a + b <= S; b++) {
        const u = a / S, v = b / S, w = 1 - u - v
        const x = 4 * v + 1 * w, y = 3 * w, z = 0.5 * w
        best = Math.min(best, Math.hypot(q[0] - x, q[1] - y, q[2] - z))
      }
      expect(d).toBeLessThanOrEqual(best + 1e-6) // Float32 output
      expect(best - d).toBeLessThan(0.03)
    }
  })
})

describe('distanceStats', () => {
  it('ignores NaN and reports signed + magnitude stats', () => {
    const s = distanceStats(new Float32Array([1, -1, 2, NaN, -2, 0]))
    expect(s.validCount).toBe(5)
    expect(s.mean).toBeCloseTo(0, 12)
    expect(s.median).toBe(0)
    expect(s.min).toBe(-2); expect(s.max).toBe(2)
    expect(s.rms).toBeCloseTo(Math.sqrt(10 / 5), 12)
    expect(s.meanAbs).toBeCloseTo(6 / 5, 12)
    expect(s.p95).toBeCloseTo(1.8, 6) // type-7 between 1 and 2
    const e = distanceStats(new Float32Array([NaN]))
    expect(e.validCount).toBe(0)
    expect(Number.isNaN(e.mean)).toBe(true)
  })
})

describe.skipIf(!process.env.BENCH)('bench', () => {
  it('C2C 1M vs 1M', () => {
    const r = rng(1), n = 1_000_000
    const mk = (seed) => {
      const rr = rng(seed), pos = new Float64Array(n * 3)
      for (let i = 0; i < n; i++) {
        const x = 1000 * rr(), y = 1000 * rr()
        pos[i * 3] = OX + x; pos[i * 3 + 1] = OY + y; pos[i * 3 + 2] = OZ + 10 * Math.sin(x / 50) * Math.cos(y / 70) + 0.05 * (r() - 0.5)
      }
      return { count: n, pos }
    }
    const a = mk(2), b = mk(3)
    const t0 = performance.now()
    const res = cloudToCloudDistance(a, b)
    const t1 = performance.now()
    console.log(`BENCH C2C 1M vs 1M: ${((t1 - t0) / 1000).toFixed(2)} s (mean ${res.stats.mean.toFixed(3)})`)
  }, 120000)

  it('C2M 1M points vs 500k triangles', () => {
    const G = 501 // 500×500 quads = 500k triangles
    const pos = new Float64Array(G * G * 3)
    const h = (x, y) => 10 * Math.sin(x / 50) * Math.cos(y / 70)
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const k = (j * G + i) * 3
      pos[k] = OX + 2 * i; pos[k + 1] = OY + 2 * j; pos[k + 2] = OZ + h(2 * i, 2 * j)
    }
    const idx = new Uint32Array((G - 1) * (G - 1) * 6)
    let f = 0
    for (let j = 0; j < G - 1; j++) for (let i = 0; i < G - 1; i++) {
      const a = j * G + i
      idx[f++] = a; idx[f++] = a + 1; idx[f++] = a + G + 1; idx[f++] = a; idx[f++] = a + G + 1; idx[f++] = a + G
    }
    const mesh = { nVerts: G * G, count: idx.length / 3, pos, idx }
    const n = 1_000_000, r = rng(5), sp = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) {
      const x = 1000 * r(), y = 1000 * r()
      sp[i * 3] = OX + x; sp[i * 3 + 1] = OY + y; sp[i * 3 + 2] = OZ + h(x, y) + (r() - 0.5)
    }
    const t0 = performance.now()
    const res = cloudToMeshDistance({ count: n, pos: sp }, mesh)
    const t1 = performance.now()
    console.log(`BENCH C2M 1M vs ${mesh.count} tris: ${((t1 - t0) / 1000).toFixed(2)} s (meanAbs ${res.stats.meanAbs.toFixed(3)})`)
  }, 120000)
})
