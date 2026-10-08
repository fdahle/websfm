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
 * Observations of every point in every camera of `camIdxOf`, in point order and,
 * within a point, in the order of its views.
 * @param {Array<{views: Map<string, number>}>} points3d
 * @param {(uuid: string) => number | undefined} camIdxOf   undefined / −1 ⇒ skip
 * @param {(uuid: string) => {n:number, xy:Float64Array} | null | undefined} keypointsOf
 *   the image's KeypointSet (keypointSet.js)
 */
export function buildBaObservations(points3d, camIdxOf, keypointsOf) {
  let cap = 0
  for (const pt of points3d) cap += pt.views.size
  const cam = new Int32Array(cap), pt = new Int32Array(cap)
  const x = new Float64Array(cap), y = new Float64Array(cap)
  let n = 0
  for (let pi = 0; pi < points3d.length; pi++) {
    for (const [uuid, kpIdx] of points3d[pi].views) {
      const ci = camIdxOf(uuid)
      if (ci == null || ci === -1) continue
      const set = keypointsOf(uuid)
      if (!hasKp(set, kpIdx)) continue
      cam[n] = ci; pt[n] = pi; x[n] = set.xy[2 * kpIdx]; y[n] = set.xy[2 * kpIdx + 1]
      n++
    }
  }
  return { n, cam, pt, x, y, wx: null, wy: null }
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
