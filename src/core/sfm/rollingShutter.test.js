import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import {
  captureSeconds,
  cameraVelocities,
  attachRollingShutter,
  readoutSummary,
  rollingShutterWarps,
  rollingShutterPixel,
} from './rollingShutter.js'
import { SparsePoints } from './sparsePoints.js'
import { makeSampleMap } from './displayFrame.js'
import { bundleAdjust } from './reconstruction.js'
import { projectPoint } from './geometry.js'
import { projectFullXYZ } from './baAcceptance.js'

describe('captureSeconds', () => {
  it('reads EXIF and ISO times, a Date, and the sub-seconds', () => {
    const a = captureSeconds({ dateTime: '2026:09:23 14:05:10' })
    expect(captureSeconds({ dateTime: '2026:09:23 14:05:12' }) - a).toBe(2)
    expect(captureSeconds({ dateTime: '2026-09-23T14:05:10.000Z' })).toBe(Date.parse('2026-09-23T14:05:10Z') / 1000)
    expect(captureSeconds({ dateTime: new Date(5000) })).toBe(5)
    expect(captureSeconds({ dateTime: new Date(5000), subSecTime: '25' })).toBe(5.25)
    expect(captureSeconds({ dateTime: null })).toBeNull()
    expect(captureSeconds({ dateTime: 'not a date' })).toBeNull()
  })
})

describe('cameraVelocities', () => {
  it('fits each camera a velocity over its neighbours, and starts afresh after a pause', () => {
    // 10 m/s along x, a photo every 2 s; then a second flight 60 s later going back.
    const items = []
    for (let i = 0; i < 6; i++) items.push({ key: `a${i}`, t: 2 * i, C: [20 * i, 5, 50] })
    for (let i = 0; i < 4; i++) items.push({ key: `b${i}`, t: 100 + 2 * i, C: [100 - 16 * i, 40, 50] })
    const v = cameraVelocities(items)
    for (let i = 0; i < 6; i++) expect(v.get(`a${i}`)).toEqual([10, 0, 0])
    for (let i = 0; i < 4; i++) expect(v.get(`b${i}`)).toEqual([-8, 0, 0])
  })

  it('averages whole-second times over the window', () => {
    // True 10 m/s every 1.5 s, times truncated to whole seconds.
    const items = Array.from({ length: 9 }, (_, i) => ({ key: i, t: Math.floor(1.5 * i), C: [15 * i, 0, 0] }))
    const v = cameraVelocities(items)
    expect(v.get(4)[0]).toBeCloseTo(10, 0)
  })

  it('leaves out a photo with no neighbour', () => {
    expect(cameraVelocities([{ key: 'x', t: 0, C: [0, 0, 0] }]).size).toBe(0)
  })
})

describe('attachRollingShutter', () => {
  const nadir = [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ]
  const cam = (x) => ({ R: nadir, t: [-x, 0, 50], K: { fx: 1000, fy: 1000, cx: 500, cy: 375 } })

  it('gives timed cameras their velocity, frame height and group readout time', () => {
    const cameras = new Map([0, 1, 2, 3].map((i) => [`c${i}`, cam(20 * i)]))
    cameras.set('c1', { ...cameras.get('c1'), rs: { v: [0, 0, 0], h: 750, tau: 0.02 } })
    cameras.set('film', cam(200))
    const frame = (u) =>
      u === 'film'
        ? { t: 8, h: 750, group: 1, film: true }
        : { t: 2 * Number(u.slice(1)), h: 750, group: 1, film: false }
    const out = attachRollingShutter(cameras, frame)
    expect(out.cameras).toBe(4)
    expect(cameras.get('c0').rs).toEqual({ v: [10, 0, 0], h: 750, tau: 0.02 })
    expect(cameras.get('film').rs).toBeUndefined()
    expect(readoutSummary(cameras, () => 1).get(1)).toEqual({ tau: 0.02, cameras: 4 })
  })
})

describe('bundle adjustment with a rolling shutter', () => {
  // Node cannot fetch the .wasm; hand init() the bytes (as reconstruction.test.js does).
  beforeAll(async () => {
    const url = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
    await initRecon({ module_or_path: await readFile(fileURLToPath(url)) })
  })

  // Two nadir strips at 10 m/s, 50 m up, 30 ms readout (bundle.rs rolling_shutter_tests).
  const F = 1000,
    W = 1000,
    H = 750,
    V = [10, 0, 0],
    TAU = 0.03
  const nadir = [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ]
  const K = { fx: F, fy: F, cx: W / 2, cy: H / 2 }
  // Camera centres C, t = −R·C with R = diag(1, −1, −1).
  const cams = []
  for (let strip = 0; strip < 2; strip++)
    for (let k = 0; k < 7; k++) {
      const C = [8 * k, 18 * strip, 50 + 0.5 * k]
      cams.push({ R: nadir, t: [-C[0], C[1], C[2]], K })
    }
  const pts = []
  for (let ix = 0; ix < 16; ix++)
    for (let iy = 0; iy < 10; iy++) {
      const x = -10 + 4.5 * ix,
        y = -12 + 4.2 * iy
      pts.push({ x, y, z: 1.5 * Math.sin(0.2 * x) * Math.cos(0.3 * y) })
    }
  const rsCams = cams.map((c) => ({ ...c, rs: { v: V, h: H, tau: TAU } }))
  const observations = []
  rsCams.forEach((c, ci) =>
    pts.forEach((p, pi) => {
      const q = projectPoint(c, p.x, p.y, p.z)
      if (q && q.u >= 0 && q.u <= W && q.v >= 0 && q.v <= H)
        observations.push({ camIdx: ci, ptIdx: pi, x: q.u, y: q.v })
    }),
  )

  it('projects through the rolling shutter the way the solver does', async () => {
    const res = await bundleAdjust(
      rsCams,
      cams.map(() => K),
      pts,
      observations,
      { maxIters: 5 },
    )
    expect(res.costBefore).toBeLessThan(1e-3)
    expect(res.readout.every((t) => Math.abs(t - TAU) < 1e-7)).toBe(true)
    expect(res.cameras[0].rs.tau).toBeCloseTo(TAU, 7)
    // projectFullXYZ (the acceptance check's) agrees with projectPoint.
    const p = pts[40]
    const a = projectPoint(rsCams[3], p.x, p.y, p.z)
    const b = projectFullXYZ(rsCams[3], K, p.x, p.y, p.z)
    expect(b.x).toBeCloseTo(a.u, 9)
    expect(b.y).toBeCloseTo(a.v, 9)
  })

  it('recovers the readout time from zero', async () => {
    const start = cams.map((c) => ({ ...c, rs: { v: V, h: H, tau: 0 } }))
    const res = await bundleAdjust(
      start,
      cams.map(() => K),
      pts,
      observations,
      {
        maxIters: 60,
        refineReadout: true,
        sensorOfCam: cams.map(() => 0),
      },
    )
    expect(res.readout[0]).toBeCloseTo(TAU, 3)
    expect(res.costAfter).toBeLessThan(0.02)
  })

  it('is plain bundle adjustment without a rolling-shutter camera', async () => {
    const res = await bundleAdjust(
      cams,
      cams.map(() => K),
      pts,
      observations,
      { maxIters: 5 },
    )
    expect(res.readout).toBeUndefined()
    expect(res.cameras[0].rs).toBeUndefined()
  })
})

describe("the photo on the principal row's pose", () => {
  // A nadir camera 50 m over flat ground, flying 10 m/s along x, read over 30 ms.
  const R = [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ]
  const K = { fx: 1000, fy: 1000, cx: 500, cy: 375 }
  const rs = { v: [10, 0, 0], h: 750, tau: 0.03 }
  const cam = { R, t: [0, 0, 50], K, rs }
  const global = { R, t: [0, 0, 50], K }
  const ground = [
    [-12, 9, 0],
    [3, -15, 0],
    [14, 14, 0],
    [0, 0, 0],
  ]
  const points = new SparsePoints({
    pos: Float64Array.from(ground.flat()),
    viewUuids: ['a'],
    vcount: Uint32Array.from(ground.map(() => 1)),
    vcam: new Uint32Array(ground.length),
    vkp: new Uint32Array(ground.length),
  })

  it('gives a moving camera its velocity in its own frame and its scene depth', () => {
    const warps = rollingShutterWarps(
      new Map([
        ['a', cam],
        ['still', { ...global, rs: { v: [0, 0, 0], h: 750, tau: 0.03 } }],
        ['global', global],
      ]),
      points,
    )
    expect([...warps.keys()]).toEqual(['a'])
    const w = warps.get('a')
    expect(w.w).toEqual([10, 0, 0])
    expect(w.depth).toBeCloseTo(50, 9)
    expect(w).toMatchObject({ tau: 0.03, h: 750, plane: null })
  })

  it("takes an oblique photo's rays to the plane of its points", () => {
    // Tilted 35° forward, over a grid of ground points.
    const a = (35 * Math.PI) / 180
    const Rx = [
      [1, 0, 0],
      [0, Math.cos(a), -Math.sin(a)],
      [0, Math.sin(a), Math.cos(a)],
    ]
    const Ro = Rx.map((row) => [0, 1, 2].map((j) => row.reduce((s, x, k) => s + x * R[k][j], 0)))
    const C = [0, 0, 50]
    const t = Ro.map((row) => -(row[0] * C[0] + row[1] * C[1] + row[2] * C[2]))
    const oblique = { R: Ro, t, K, rs: { v: [0, 10, 0], h: 750, tau: 0.03 } }
    const grid = []
    for (let gx = -30; gx <= 30; gx += 6) for (let gy = -90; gy <= -5; gy += 5) grid.push([gx, gy, 0])
    const seen = grid.filter(([x, y]) => {
      const p = projectPoint({ R: Ro, t, K }, x, y, 0)
      return p && p.u >= 0 && p.u < 1000 && p.v >= 0 && p.v < 750
    })
    const pts = new SparsePoints({
      pos: Float64Array.from(seen.flat()),
      viewUuids: ['o'],
      vcount: Uint32Array.from(seen.map(() => 1)),
      vcam: new Uint32Array(seen.length),
      vkp: new Uint32Array(seen.length),
    })
    const warp = rollingShutterWarps(new Map([['o', oblique]]), pts).get('o')
    expect(warp.plane).not.toBeNull()
    const flat = { ...warp, plane: null }
    let worstPlane = 0,
      worstFlat = 0
    for (const [x, y] of seen) {
      const p = projectPoint({ R: Ro, t, K }, x, y, 0),
        q = projectPoint(oblique, x, y, 0)
      const r = rollingShutterPixel(warp, K, p.u, p.v),
        f = rollingShutterPixel(flat, K, p.u, p.v)
      worstPlane = Math.max(worstPlane, Math.hypot(r.x - q.u, r.y - q.v))
      worstFlat = Math.max(worstFlat, Math.hypot(f.x - q.u, f.y - q.v))
    }
    expect(worstPlane).toBeLessThan(1e-6)
    expect(worstFlat).toBeGreaterThan(0.1)
  })

  it("sends a pixel of the principal row's pose to where the photo recorded it", () => {
    const warp = rollingShutterWarps(new Map([['a', cam]]), points).get('a')
    let most = 0
    for (const [x, y] of ground) {
      const p = projectPoint(global, x, y, 0)
      const q = projectPoint(cam, x, y, 0)
      most = Math.max(most, Math.hypot(q.u - p.u, q.v - p.v))
      const r = rollingShutterPixel(warp, K, p.u, p.v)
      expect(r.x).toBeCloseTo(q.u, 6)
      expect(r.y).toBeCloseTo(q.v, 6)
    }
    // The shift the warp undoes is several pixels at the frame's edge rows.
    expect(most).toBeGreaterThan(2)
    // A point 5 m above the plane is off by about a tenth of its shift.
    const p = projectPoint(global, 3, -15, 5),
      q = projectPoint(cam, 3, -15, 5)
    const r = rollingShutterPixel(warp, K, p.u, p.v)
    expect(Math.hypot(r.x - q.u, r.y - q.v)).toBeLessThan(0.15 * Math.hypot(q.u - p.u, q.v - p.v))
  })

  it('is applied by the sample map, before any lens', () => {
    const warp = rollingShutterWarps(new Map([['a', cam]]), points).get('a')
    const map = makeSampleMap({ K, rs: warp })
    const p = projectPoint(global, 14, 14, 0),
      q = projectPoint(cam, 14, 14, 0)
    const s = map(p.u, p.v)
    expect(s.x).toBeCloseTo(q.u, 6)
    expect(s.y).toBeCloseTo(q.v, 6)
    expect(makeSampleMap({ K })).toBeNull()
  })
})
