import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { filterTracks, completeTracks, mergeSplitTracks } from './tracks.js'
import { keypointSetFrom } from './keypointSet.js'
import { tracksFrom, pointsOf } from './trackStore.testutil.js'

// The track operations against their contracts (tracks.js), on scenes whose truth is
// computed here with this file's own projection: which observations a gate must remove
// and which it must keep, and what the counts must be.

const K = { fx: 500, fy: 500, cx: 320, cy: 240 }
const rotY = (a) => [
  [Math.cos(a), 0, Math.sin(a)],
  [0, 1, 0],
  [-Math.sin(a), 0, Math.cos(a)],
]
// A camera at C, turned by `yaw` about y; t = −R·C.
const camAt = (C, yaw = 0) => {
  const R = rotY(yaw)
  return { R, t: R.map((r) => -(r[0] * C[0] + r[1] * C[1] + r[2] * C[2])), K }
}
// This file's own projection: { u, v, z } with z the camera-frame depth.
function proj(cam, P) {
  const c = cam.R.map((r, i) => r[0] * P[0] + r[1] * P[1] + r[2] * P[2] + cam.t[i])
  return { u: (K.fx * c[0]) / c[2] + K.cx, v: (K.fy * c[1]) / c[2] + K.cy, z: c[2] }
}
const centre = (cam) =>
  [0, 1, 2].map((j) => -(cam.R[0][j] * cam.t[0] + cam.R[1][j] * cam.t[1] + cam.R[2][j] * cam.t[2]))
function angleDeg(A, B, P) {
  const a = P.map((v, i) => v - A[i]),
    b = P.map((v, i) => v - B[i])
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b))
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI
}

// A scene: cameras, and points each seen by some of them with a keypoint `err` px off
// its true projection (keypoint k of image i belongs to point k).
function scene({ cams, points }) {
  const uuids = cams.map((_, i) => `c${i}`)
  const n = points.length
  const xy = cams.map(() => Array.from({ length: n }, () => ({ x: -1e6, y: -1e6 })))
  for (let k = 0; k < n; k++)
    for (const { img, err, dir } of points[k].views) {
      const p = proj(cams[img], points[k].X)
      xy[img][k] = { x: p.u + err * Math.cos(dir), y: p.v + err * Math.sin(dir) }
    }
  const sets = xy.map((kps) => keypointSetFrom(kps))
  const store = tracksFrom(
    points.map((pt, k) => ({
      x: pt.X[0],
      y: pt.X[1],
      z: pt.X[2],
      views: new Map(pt.views.map((v) => [uuids[v.img], k])),
    })),
    uuids,
    { kpCount: n },
  )
  return { ...store, uuids, sets, keypointsAt: (img) => sets[img] ?? null }
}

describe('filterTracks', () => {
  // Five cameras along x, a little turned toward the middle, 4–6 m apart at 10 m depth.
  const CAMS = [-2, -1, 0, 1, 2].map((x) => camAt([x, 0, 0], -0.05 * x))
  const view = fc.record({
    img: fc.integer({ min: 0, max: 4 }),
    err: fc.oneof(
      fc.constant(0),
      fc.double({ min: 0, max: 1.9, noNaN: true }),
      fc.double({ min: 2.1, max: 50, noNaN: true }),
    ),
    dir: fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
  })
  const point = fc.record({
    X: fc.tuple(
      fc.double({ min: -3, max: 3, noNaN: true }),
      fc.double({ min: -2, max: 2, noNaN: true }),
      // Mostly in front; some behind every camera (z < 0), which no gate may keep.
      fc.oneof(fc.double({ min: 6, max: 14, noNaN: true }), fc.double({ min: -14, max: -1, noNaN: true })),
    ),
    views: fc.uniqueArray(view, { minLength: 1, maxLength: 5, selector: (v) => v.img }),
  })

  it('keeps exactly the observations within the gates, and the points they still support', () => {
    fc.assert(
      fc.property(
        fc.array(point, { minLength: 1, maxLength: 25 }),
        fc.constantFrom(0, 1, 5, 30),
        fc.boolean(),
        (points, minTri, dropCam) => {
          // Optionally one image without a camera (not registered): its views must go.
          const cameras = new Map(CAMS.map((c, i) => [`c${i}`, c]))
          if (dropCam) cameras.delete('c3')
          const s = scene({ cams: CAMS, points })
          const gate = 2
          // The truth: an observation survives when its camera exists, the point is in
          // front of it and its keypoint is within the gate; a point survives with two
          // such views at least one pair of which clears minTri.
          const good = (k, v) => {
            const cam = cameras.get(`c${v.img}`)
            if (!cam) return false
            const p = proj(cam, points[k].X)
            return p.z > 0 && Math.hypot(p.u - s.sets[v.img].xy[2 * k], p.v - s.sets[v.img].xy[2 * k + 1]) <= gate
          }
          let badViews = 0,
            deadPoints = 0
          const expected = []
          points.forEach((pt, k) => {
            const keep = pt.views.filter((v) => good(k, v))
            badViews += pt.views.length - keep.length
            const cs = keep.map((v) => centre(CAMS[v.img]))
            let clears = false
            for (let i = 0; i < cs.length; i++)
              for (let j = i + 1; j < cs.length; j++) if (angleDeg(cs[i], cs[j], pt.X) >= minTri) clears = true
            if (keep.length >= 2 && clears) expected.push(new Set(keep.map((v) => `c${v.img}`)))
            else deadPoints++
          })
          const res = filterTracks({
            tracks: s.tracks,
            ids: s.ids,
            cameras,
            keypointsAt: s.keypointsAt,
            maxReprojPx: gate,
            minTriAngleDeg: minTri,
          })
          const after = pointsOf(s.tracks, s.ids)
          expect(after.map((p) => new Set(p.views.keys()))).toEqual(expected)
          expect(res.obsRemoved).toBe(badViews)
          expect(res.ptsRemoved).toBe(deadPoints)
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('completeTracks and mergeSplitTracks gates', () => {
  const CAMS = [camAt([-1, 0, 0], 0.05), camAt([0, 0, 0]), camAt([1, 0, 0], -0.05)]
  const cameras = new Map(CAMS.map((c, i) => [`c${i}`, c]))
  const X = [0.3, -0.2, 10]

  it('completes a track only with a keypoint within the gate', () => {
    for (const [err, joins] of [
      [1.5, true],
      [2.5, false],
    ]) {
      // A point seen by c0 and c1; c2's keypoint err px off, matched to c1's.
      const s = scene({
        cams: CAMS,
        points: [
          {
            X,
            views: [
              { img: 0, err: 0, dir: 0 },
              { img: 1, err: 0, dir: 0 },
            ],
          },
        ],
      })
      const p = proj(CAMS[2], X)
      s.sets[2].xy[0] = p.u + err
      s.sets[2].xy[1] = p.v
      const res = completeTracks({
        tracks: s.tracks,
        ids: s.ids,
        cameras,
        pairs: [{ idA: 'c1', idB: 'c2', matches: [[0, 0]] }],
        keypointsAt: s.keypointsAt,
        maxReprojPx: 2,
      })
      expect(res.added).toBe(joins ? 1 : 0)
      expect([...pointsOf(s.tracks, s.ids)[0].views.keys()].sort()).toEqual(joins ? ['c0', 'c1', 'c2'] : ['c0', 'c1'])
    }
  })

  it('merges two points of one feature only when every view fits the winner', () => {
    for (const [err, merges] of [
      [1.5, true],
      [2.5, false],
    ]) {
      // Point 0 seen by c0, c1 (keypoint 0); point 1 the same feature seen by c1
      // (keypoint 1, exact) and c2 (keypoint 1, err px off). The match c1:0 ↔ c1… is
      // across images: c0:0 ↔ c2:1.
      const s = scene({
        cams: CAMS,
        points: [
          {
            X,
            views: [
              { img: 0, err: 0, dir: 0 },
              { img: 1, err: 0, dir: 0 },
            ],
          },
          { X: [X[0], X[1], X[2] + 0.01], views: [{ img: 2, err, dir: 0 }] },
        ],
      })
      // Point 1's c2 keypoint is err px off point 0's projection into c2.
      const p = proj(CAMS[2], X)
      s.sets[2].xy[2] = p.u + err
      s.sets[2].xy[3] = p.v
      const res = mergeSplitTracks({
        tracks: s.tracks,
        ids: s.ids,
        cameras,
        pairs: [{ idA: 'c0', idB: 'c2', matches: [[0, 1]] }],
        keypointsAt: s.keypointsAt,
        maxReprojPx: 2,
      })
      expect(res.merged).toBe(merges ? 1 : 0)
      const after = pointsOf(s.tracks, s.ids)
      expect(after).toHaveLength(merges ? 1 : 2)
      if (merges) expect([...after[0].views.keys()].sort()).toEqual(['c0', 'c1', 'c2'])
    }
  })
})
