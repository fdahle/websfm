import { describe, it, expect } from 'vitest'
import { fuseDepthMaps, fuseDepthMapsStreamed } from './fusion.js'

// Fusion against a scene whose answer is known: a tilted plane seen by cameras with full
// rotations (aimed at it, rolled), depth maps rendered exactly from their poses. What
// fusion must do follows from its contract (fusion.js ▸ fuseDepthMaps): a pixel's point
// is kept when at least `minViews` other maps see a depth within `depthTolRel` near where
// it reprojects, with enough parallax and not at a grazing angle; every kept point keeps
// its pixel's colour and gets a camera-facing normal. Nothing here is a value copied from
// a run. Both runners are held to it: the resident one and the streamed one the app uses.

const PLANE_N = norm([0.25, -0.15, -1]) // faces the cameras (−z)
const PLANE_P = [0.3, -0.2, 10]
const PLANE_D = dot(PLANE_N, PLANE_P)
const W = 48,
  H = 36
const K = { fx: 40, fy: 40, cx: 23.5, cy: 17.5 }
const RGB = [10, 128, 250] // distinct channels: a shifted read shows

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
function norm(a) {
  const l = Math.hypot(...a)
  return a.map((v) => v / l)
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
const mul = (R, v) => R.map((r) => dot(r, v))
const mulT = (R, v) => [0, 1, 2].map((j) => R[0][j] * v[0] + R[1][j] * v[1] + R[2][j] * v[2])

// A camera at `C` looking at `target`, rolled by `roll` (rows: camera x, y, z in world).
function lookAt(C, target, roll) {
  const z = norm(target.map((v, i) => v - C[i]))
  const x0 = norm(cross([Math.sin(roll), Math.cos(roll), 0.1], z))
  const y0 = cross(z, x0)
  return [x0, y0, z]
}

// One depth map of `plane` ({ n, d }: n·X = d) from a camera at C. `depthOf(u, v, d)`
// lets a test disturb the exact depth; `normals: false` leaves them out (a stale cache).
function render(
  C,
  {
    plane = { n: PLANE_N, d: PLANE_D },
    roll = 0.3,
    depthOf = (u, v, d) => d,
    normals = true,
    normalSign = 1,
    cost = 0.1,
  } = {},
) {
  const R = lookAt(C, PLANE_P, roll)
  const t = mul(R, C).map((v) => -v)
  const depth = new Float32Array(W * H),
    nrm = new Float32Array(W * H * 3),
    rgb = new Uint8Array(W * H * 3)
  const nc = mul(R, plane.n) // the plane normal in the camera frame
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const ray = [(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1] // camera frame, z = 1
      const d = (plane.d - dot(plane.n, C)) / dot(plane.n, mulT(R, ray))
      const i = v * W + u
      depth[i] = d > 0 ? depthOf(u, v, d) : 0
      // Camera-facing, as the kernels keep it (normalSign −1: the other way).
      const s = (nc[2] < 0 ? 1 : -1) * normalSign
      nrm.set([s * nc[0], s * nc[1], s * nc[2]], i * 3)
      rgb.set(RGB, i * 3)
    }
  return {
    uuid: `cam${C.join(',')}`,
    width: W,
    height: H,
    K,
    R,
    t,
    depth,
    cost: new Float32Array(W * H).fill(cost),
    rgb,
    ...(normals ? { normals: nrm } : {}),
  }
}

const row = (xs, y = 0.4, z = 0.2) => xs.map((x) => [x, y, z])
const WIDE = row([-1.5, -0.5, 0.5, 1.5]) // ~5.7° between neighbours at 10 m
const RUNNERS = {
  resident: async (maps, opts) => fuseDepthMaps(maps, opts),
  streamed: (maps, opts) => fuseDepthMapsStreamed(maps, (i) => maps[i], opts),
}
const points = (out) => Array.from({ length: out.count }, (_, i) => Array.from(out.subarray(i * 6, i * 6 + 6)))
const offPlane = (p, plane = { n: PLANE_N, d: PLANE_D }) => Math.abs(dot(plane.n, p) - plane.d)
const centreOf = (m) => mulT(m.R, m.t).map((v) => -v)

describe.each(Object.keys(RUNNERS))('fusion on a known plane (%s)', (runner) => {
  const fuse = (maps, opts = {}) => RUNNERS[runner](maps, { removeIsolated: false, ...opts })
  it('keeps the plane: every point on it, in its colour, with its camera-facing normal', async () => {
    const maps = WIDE.map((C) => render(C))
    const out = await fuse(maps)
    expect(out.count).toBeGreaterThan(500)
    for (const p of points(out)) {
      expect(offPlane(p)).toBeLessThan(1e-4)
      expect(p.slice(3)).toEqual(RGB)
    }
    for (let i = 0; i < out.count; i++) {
      const n = Array.from(out.nrm.subarray(i * 3, i * 3 + 3))
      // The plane's normal, facing the cameras (all four sit on its −n side).
      expect(dot(n, PLANE_N)).toBeGreaterThan(1 - 1e-5)
    }
    // Every candidate pixel either kept or culled for a reason: the shares add up.
    const s = out.summary
    const culled = Object.values(s.cullBreakdown).reduce((a, b) => a + b, 0)
    expect(s.keptPct + culled).toBeCloseTo(100, 6)
  })

  it('without normal planes, points face the camera that saw them', async () => {
    // Cameras well above the plane's centre, so a view direction is far from the axis.
    const maps = row([-1.5, -0.5, 0.5, 1.5], 4).map((C) => render(C, { normals: false }))
    const out = await fuse(maps)
    expect(out.count).toBeGreaterThan(500)
    const centres = maps.map(centreOf)
    points(out).forEach((p, i) => {
      const n = Array.from(out.nrm.subarray(i * 3, i * 3 + 3))
      expect(Math.hypot(...n)).toBeCloseTo(1, 4)
      // Averaged view directions of the cameras that saw it.
      const toRow = norm([0, 1, 2].map((k) => centres.reduce((a, C) => a + C[k], 0) / centres.length - p[k]))
      expect(dot(n, toRow)).toBeGreaterThan(Math.cos((10 * Math.PI) / 180)) // a wrong sign: ~45°
      for (const C of centres)
        expect(
          dot(
            n,
            C.map((v, k) => v - p[k]),
          ),
        ).toBeGreaterThan(0)
    })
  })

  it('averages the agreeing views: a fused point is nearer the surface than one map', async () => {
    // Each map with its own ±0.3 % depth noise (a different pattern per map), within the
    // 1 % tolerance. A point at the mean of its own depth and its agreeing views' has less
    // of it than any single map's pixel (about 1/√(views + 1) of it).
    const rnd = (u, v, k) => {
      const x = Math.sin(12.9898 * u + 78.233 * v + 37.719 * k) * 43758.5453
      return 2 * (x - Math.floor(x)) - 1
    }
    const maps = WIDE.map((C, k) => render(C, { depthOf: (u, v, d) => d * (1 + 0.003 * rnd(u, v, k)) }))
    // The scatter of one map's own pixels about the plane.
    const one = maps[1],
      Ci = centreOf(one)
    let raw = 0,
      n = 0
    for (let v = 0; v < H; v++)
      for (let u = 0; u < W; u++) {
        const d = one.depth[v * W + u]
        if (!(d > 0)) continue
        const X = mulT(one.R, [((u - K.cx) / K.fx) * d, ((v - K.cy) / K.fy) * d, d]).map((x, i) => x + Ci[i])
        raw += offPlane(X) ** 2
        n++
      }
    raw = Math.sqrt(raw / n)
    const out = await fuse(maps, { minViews: 3 })
    expect(out.count).toBeGreaterThan(500)
    const fused = Math.sqrt(points(out).reduce((a, p) => a + offPlane(p) ** 2, 0) / out.count)
    // Own depth + three agreeing views: about ½ of one map's scatter (0.40 here, the voxel
    // merge adds a little). Each pixel at its own depth, merged by voxel alone: 0.71.
    expect(fused).toBeLessThan(0.55 * raw)
    // Point position 'own' (Auto for an object capture): each point keeps its map's noise.
    const own = await fuse(maps, { minViews: 3, position: 'auto', sceneType: 'object' })
    const ownRms = Math.sqrt(points(own).reduce((a, p) => a + offPlane(p) ** 2, 0) / own.count)
    expect(ownRms).toBeGreaterThan(0.6 * raw)
  })

  it('removes a lone speck two maps agree on, only with removeIsolated', async () => {
    // A point well in front of the plane that maps 0 and 1 both see (a fusion speck: a
    // consistent pair with nothing around it). It passes the consistency check, so only
    // the isolated-cell removal (voxelAccumulator filterIsolated) can take it out.
    const maps = WIDE.map((C) => render(C))
    const [m0, m1] = maps
    const [u0, v0] = [10, 10]
    const dS = 0.6 * m0.depth[v0 * W + u0]
    const C0 = centreOf(m0)
    const S = mulT(m0.R, [(u0 - K.cx) / K.fx, (v0 - K.cy) / K.fy, 1]).map((v, k) => C0[k] + dS * v)
    m0.depth[v0 * W + u0] = dS
    const pc = mul(m1.R, S).map((v, k) => v + m1.t[k])
    m1.depth[Math.round((K.fy * pc[1]) / pc[2] + K.cy) * W + Math.round((K.fx * pc[0]) / pc[2] + K.cx)] = pc[2]
    const kept = await fuse(maps, { minViews: 1, removeIsolated: false })
    const speck = (out) => points(out).filter((p) => offPlane(p) > 0.5)
    expect(speck(kept)).toHaveLength(1)
    expect(
      Math.hypot(
        ...speck(kept)[0]
          .slice(0, 3)
          .map((v, k) => v - S[k]),
      ),
    ).toBeLessThan(0.1)
    const cleaned = await fuse(maps, { minViews: 1, removeIsolated: true })
    expect(speck(cleaned)).toHaveLength(0)
    // The plane stays: at most the few cells along its border go with the speck.
    expect(cleaned.count).toBeGreaterThan(0.99 * kept.count)
  })

  it('keeps depths that agree within the tolerance', async () => {
    // ±0.4 % noise against a 1 % tolerance: still the same surface.
    const noisy = (u, v, d) => d * (1 + 0.004 * Math.sin(12.9898 * u + 78.233 * v))
    const clean = await fuse(WIDE.map((C) => render(C)))
    const out = await fuse(
      WIDE.map((C) => render(C, { depthOf: noisy })),
      { depthTolRel: 0.01 },
    )
    expect(out.summary.keptPct).toBeGreaterThan(0.9 * clean.summary.keptPct)
    for (const p of points(out)) expect(offPlane(p)).toBeLessThan(0.004 * 12)
  })

  it('drops a map whose depths no other map confirms', async () => {
    // One map 5 % too deep (a wrong scale, a bad match): outside the 1 % tolerance, so
    // none of its points is confirmed, and it confirms nothing; the other three still
    // confirm each other.
    const maps = WIDE.map((C, i) => render(C, i === 2 ? { depthOf: (u, v, d) => 1.05 * d } : {}))
    const out = await fuse(maps, { depthTolRel: 0.01, minViews: 2 })
    expect(out.count).toBeGreaterThan(300)
    for (const p of points(out)) expect(offPlane(p)).toBeLessThan(1e-4)
  })

  it('needs minViews other maps to agree', async () => {
    const maps = row([-1, 0, 1]).map((C) => render(C))
    // Two other maps per pixel at most: two agree, three cannot.
    const two = await fuse(maps, { minViews: 2 })
    expect(two.count).toBeGreaterThan(300)
    const three = await fuse(maps, { minViews: 3 })
    expect(three.count).toBe(0)
    expect(three.summary.keptPct).toBe(0)
    expect(three.summary.cullBreakdown.lowViewsPct).toBeGreaterThan(90)
  })

  it('culls pixels that agree only at too little parallax', async () => {
    // Cameras 2 cm apart at 10 m: ~0.1° between rays, under the 2° gate.
    const maps = row([-0.02, 0, 0.02]).map((C) => render(C))
    const gated = await fuse(maps, { minTriAngleDeg: 2, minViews: 1 })
    expect(gated.count).toBe(0)
    expect(gated.summary.cullBreakdown.lowParallaxPct).toBeGreaterThan(90)
    // The same maps without the gate: the surface is there.
    const open = await fuse(maps, { minTriAngleDeg: 0, minViews: 1 })
    expect(open.count).toBeGreaterThan(300)
    expect(open.summary.cullBreakdown.lowParallaxPct).toBe(0)
  })

  it('culls a surface seen edge-on, and only when the gate is on', async () => {
    // A steep plane: every ray meets it at more than 55° incidence (checked below).
    const n = norm([0, -1, -0.1])
    const steep = { n, d: dot(n, PLANE_P) }
    const maps = WIDE.map((C) => render(C, { plane: steep, roll: 0 }))
    let minInc = 90
    for (const m of maps) {
      for (let v = 0; v < H; v++)
        for (let u = 0; u < W; u++) {
          if (!(m.depth[v * W + u] > 0)) continue
          const ray = norm(mulT(m.R, [(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1]))
          minInc = Math.min(minInc, (Math.acos(Math.abs(dot(ray, n))) * 180) / Math.PI)
        }
    }
    expect(minInc).toBeGreaterThan(55)
    const open = await fuse(maps, { maxIncidenceDeg: 0, minTriAngleDeg: 0 })
    expect(open.count).toBeGreaterThan(30)
    expect(open.summary.cullBreakdown.grazingPct).toBe(0)
    for (const p of points(open)) expect(offPlane(p, steep)).toBeLessThan(1e-3)
    // At a 50° gate, every pixel the open run kept is culled as grazing, and only those.
    const gated = await fuse(maps, { maxIncidenceDeg: 50, minTriAngleDeg: 0 })
    expect(gated.count).toBe(0)
    expect(gated.summary.cullBreakdown.grazingPct).toBeCloseTo(open.summary.keptPct, 9)
    // At 89°, the gate keeps what meets the plane at up to 89°: most of it here.
    const loose = await fuse(maps, { maxIncidenceDeg: 89, minTriAngleDeg: 0 })
    expect(loose.summary.keptPct).toBeGreaterThan(0.5 * open.summary.keptPct)
    expect(loose.summary.keptPct + loose.summary.cullBreakdown.grazingPct).toBeCloseTo(open.summary.keptPct, 9)
  })

  it('keeps only points inside the region', async () => {
    const maps = WIDE.map((C) => render(C))
    const all = await fuse(maps)
    const region = { min: [-100, -100, 0], max: [PLANE_P[0], 100, 100] } // x ≤ 0.3: about half
    const out = await fuse(maps, { region })
    expect(out.count).toBeGreaterThan(0.2 * all.count)
    expect(out.count).toBeLessThan(0.8 * all.count)
    for (const p of points(out)) expect(p[0]).toBeLessThanOrEqual(PLANE_P[0])
    expect(out.summary.cullBreakdown.outsideRegionPct).toBeGreaterThan(10)
  })

  it('culls pixels whose matching cost is above maxCost', async () => {
    const maps = WIDE.map((C, i) => render(C, { cost: i === 0 ? 0.9 : 0.1 }))
    const out = await fuse(maps, { maxCost: 0.8 })
    // Map 0 contributes none of its own pixels (a quarter of the candidates).
    expect(out.summary.cullBreakdown.highCostPct).toBeCloseTo(25, 6)
    expect(out.count).toBeGreaterThan(300)
  })

  it('turns normals that face away from the camera toward it', async () => {
    // An oblique plane can come out of the kernels as −n (same homography).
    const out = await fuse(WIDE.map((C) => render(C, { normalSign: -1 })))
    expect(out.count).toBeGreaterThan(500)
    for (let i = 0; i < out.count; i++) {
      const n = Array.from(out.nrm.subarray(i * 3, i * 3 + 3))
      expect(dot(n, PLANE_N)).toBeGreaterThan(1 - 1e-5)
    }
  })

  it('treats a depth hole as no evidence', async () => {
    // Every other map holds no depth where u is odd: its pixels are no-depth, and a hole
    // never confirms a point (a zero depth is not "within the tolerance").
    const holey = (u, v, d) => (u % 2 ? 0 : d)
    const maps = WIDE.map((C, i) => render(C, i % 2 ? { depthOf: holey } : {}))
    const out = await fuse(maps, { consistencyPx: 0, minViews: 3 })
    for (const p of points(out)) expect(offPlane(p)).toBeLessThan(1e-4)
    expect(out.summary.cullBreakdown.noDepthPct).toBeGreaterThan(20)
    // All-hole maps confirm nothing: with three of four empty, no pixel has 3 others.
    const empty = WIDE.map((C, i) => render(C, i ? { depthOf: () => 0 } : {}))
    const none = await fuse(empty, { minViews: 1, minTriAngleDeg: 0 })
    expect(none.count).toBe(0)
  })
})
