// Bundle-adjustment observation lists (pure).
//
// One observation = one point seen by one camera at one keypoint. Every SfM bundle
// adjustment used to build an object per observation (`{camIdx, ptIdx, x, y}`) and
// bundleAdjust then flattened them again; at millions of observations those objects
// were a large share of the worker heap. An `ObservationList` is the same data as
// parallel typed arrays:
//   { n, cam: Int32Array, pt: Int32Array, x: Float64Array, y: Float64Array,
//     wx: Float64Array | null, wy: Float64Array | null }
// x/y stay Float64: the acceptance check (baAcceptance.js) and the diagnostics read
// them at full precision; only the wasm hand-off rounds to Float32, as before.
// Weights are null when every observation has weight 1 (the SIFT tracks).

import { hasKp } from './keypointSet.js'

export function isObservationList(o) {
  return !!o && !Array.isArray(o) && o.cam instanceof Int32Array
}

/**
 * Observations of every live point of `tracks` (trackStore.js) in every camera of
 * `camIdxOf`, in point order and, within a point, in the order of its views. Point
 * index in the list = the point's rank among the live points, which is its index in
 * the matching flat position array (`trackPositions`).
 * @param {object} tracks
 * @param {Int32Array} ids                      tracks.liveIds() — rank → point id
 * @param {(img: number) => number} camIdxOf    −1 ⇒ skip
 * @param {(img: number) => {n:number, xy:Float64Array} | null | undefined} keypointsAt
 *   the image's KeypointSet (keypointSet.js)
 */
export function buildBaObservations(tracks, ids, camIdxOf, keypointsAt) {
  let cap = 0
  for (let r = 0; r < ids.length; r++) cap += tracks.viewCount(ids[r])
  const cam = new Int32Array(cap), pt = new Int32Array(cap)
  const x = new Float64Array(cap), y = new Float64Array(cap)
  let n = 0
  for (let r = 0; r < ids.length; r++) {
    tracks.forEachView(ids[r], (img, kpIdx) => {
      const ci = camIdxOf(img)
      if (ci == null || ci === -1) return
      const set = keypointsAt(img)
      if (!hasKp(set, kpIdx)) return
      cam[n] = ci; pt[n] = r; x[n] = set.xy[2 * kpIdx]; y[n] = set.xy[2 * kpIdx + 1]
      n++
    })
  }
  return { n, cam, pt, x, y, wx: null, wy: null }
}

/** Positions of the points `ids` as one flat Float64Array [x0,y0,z0, x1,…], plus `extra` [{x,y,z}]. */
export function trackPositions(tracks, ids, extra = []) {
  const pos = new Float64Array(3 * (ids.length + extra.length))
  for (let r = 0; r < ids.length; r++) {
    const p = ids[r]
    pos[3 * r] = tracks.x(p); pos[3 * r + 1] = tracks.y(p); pos[3 * r + 2] = tracks.z(p)
  }
  extra.forEach((q, i) => { const j = 3 * (ids.length + i); pos[j] = q.x; pos[j + 1] = q.y; pos[j + 2] = q.z })
  return pos
}

/**
 * A new list: `list` followed by `extra` observation records
 * (`{camIdx, ptIdx, x, y, weightX?, weightY?}`, e.g. GCP marks).
 */
export function appendObservations(list, extra) {
  const n = list.n + extra.length
  const cam = new Int32Array(n), pt = new Int32Array(n)
  const x = new Float64Array(n), y = new Float64Array(n)
  const wx = new Float64Array(n).fill(1), wy = new Float64Array(n).fill(1)
  cam.set(list.cam.subarray(0, list.n)); pt.set(list.pt.subarray(0, list.n))
  x.set(list.x.subarray(0, list.n)); y.set(list.y.subarray(0, list.n))
  if (list.wx) { wx.set(list.wx.subarray(0, list.n)); wy.set(list.wy.subarray(0, list.n)) }
  for (let i = 0; i < extra.length; i++) {
    const o = extra[i], j = list.n + i
    cam[j] = o.camIdx; pt[j] = o.ptIdx; x[j] = o.x; y[j] = o.y
    wx[j] = o.weightX ?? 1; wy[j] = o.weightY ?? 1
  }
  return { n, cam, pt, x, y, wx, wy }
}
