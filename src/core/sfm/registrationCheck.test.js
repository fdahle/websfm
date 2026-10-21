import { describe, it, expect } from 'vitest'
import { registrationOutliers, deregisterCamera, fundamentalFromPoses } from './registrationCheck.js'
import { createTrackStore } from './trackStore.js'

// A ring of cameras looking at a cloud of points; every pair matches every shared point.
function scene(perturb = null) {
  const K = { fx: 800, fy: 800, cx: 500, cy: 400 }
  const pts = []
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < 300; i++) pts.push([rnd() * 4 - 2, rnd() * 3 - 1.5, 8 + rnd() * 3])
  const cams = new Map()
  for (let c = 0; c < 6; c++) {
    const a = (c - 2.5) * 0.08,
      R = [
        [Math.cos(a), 0, Math.sin(a)],
        [0, 1, 0],
        [-Math.sin(a), 0, Math.cos(a)],
      ]
    const C = [c * 0.6 - 1.5, 0, 0]
    cams.set(`c${c}`, { R, t: R.map((r) => -(r[0] * C[0] + r[1] * C[1] + r[2] * C[2])), K })
  }
  const kp = new Map()
  for (const [u, cam] of cams) {
    const xy = new Float64Array(2 * pts.length)
    pts.forEach((X, i) => {
      const p = cam.R.map((r, k) => r[0] * X[0] + r[1] * X[1] + r[2] * X[2] + cam.t[k])
      xy[2 * i] = (K.fx * p[0]) / p[2] + K.cx
      xy[2 * i + 1] = (K.fy * p[1]) / p[2] + K.cy
    })
    kp.set(u, { n: pts.length, xy })
  }
  if (perturb) {
    const c = cams.get(perturb)
    cams.set(perturb, { ...c, t: [c.t[0] + 0.8, c.t[1] - 0.4, c.t[2]] })
  }
  const ids = [...cams.keys()]
  const pairs = []
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      pairs.push({
        idA: ids[i],
        idB: ids[j],
        inlierCount: 300,
        matches: Uint32Array.from(pts.flatMap((_, k) => [k, k])),
      })
    }
  const index = new Map(ids.map((u, i) => [u, i]))
  return { cams, kp, pairs, ids: { img: (u) => index.get(u) }, keypointsAt: (i) => kp.get(ids[i]), order: ids }
}

describe('registrationCheck', () => {
  it('implied F is satisfied by the true matches', () => {
    const s = scene()
    const F = fundamentalFromPoses(s.cams.get('c0'), s.cams.get('c3'))
    const a = s.kp.get('c0').xy,
      b = s.kp.get('c3').xy
    const l = [0, 1, 2].map((r) => F[r][0] * a[0] + F[r][1] * a[1] + F[r][2])
    expect(Math.abs(b[0] * l[0] + b[1] * l[1] + l[2]) / Math.hypot(l[0], l[1])).toBeLessThan(1e-6)
  })

  it('flags exactly the misplaced camera', () => {
    const s = scene('c4')
    const r = registrationOutliers({ cameras: s.cams, pairs: s.pairs, keypointsAt: s.keypointsAt, ids: s.ids })
    expect(r.flagged.map((f) => f.uuid)).toEqual(['c4'])
    expect(r.median).toBeLessThan(1e-3)
  })

  it('flags nothing in a consistent model', () => {
    const s = scene()
    expect(
      registrationOutliers({ cameras: s.cams, pairs: s.pairs, keypointsAt: s.keypointsAt, ids: s.ids }).flagged,
    ).toEqual([])
  })

  it('deregistering drops the camera, its views and points left under two views', () => {
    const tracks = createTrackStore([300, 300, 300])
    const p2 = tracks.addPoint(0, 0, 0)
    tracks.addView(p2, 0, 1)
    tracks.addView(p2, 2, 1)
    const p3 = tracks.addPoint(0, 0, 0)
    tracks.addView(p3, 0, 2)
    tracks.addView(p3, 1, 2)
    tracks.addView(p3, 2, 2)
    const cameras = new Map([
        ['c0', {}],
        ['c1', {}],
        ['c2', {}],
      ]),
      reg = new Set(['c0', 'c1', 'c2'])
    const gone = deregisterCamera({
      uuid: 'c2',
      cameras,
      registeredUuids: reg,
      tracks,
      ids: { img: (u) => Number(u[1]) },
    })
    expect(gone).toBe(1)
    expect(tracks.isLive(p2)).toBe(false)
    expect(tracks.viewCount(p3)).toBe(2)
    expect(cameras.has('c2')).toBe(false)
    expect(reg.has('c2')).toBe(false)
  })
})
