import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { captureSeconds, cameraVelocities, attachRollingShutter, readoutSummary } from './rollingShutter.js'
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
