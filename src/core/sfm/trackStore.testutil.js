// Test helpers (imported by *.test.js only): write fixtures in the old literal shape
// `[{ x, y, z, views: Map<uuid, kp> }]` and read a TrackStore back in that shape.

import { createTrackStore, makeImageIds } from './trackStore.js'

/**
 * @param {Array<{x:number,y:number,z:number,views:Map<string,number>}>} points
 * @param {string[]} uuids   image order
 * @param {{kpCount?: number, impl?: string}} [opts]   keypoints per image (index size)
 */
export function tracksFrom(points, uuids, { kpCount = 64, impl = 'typed' } = {}) {
  const ids = makeImageIds(uuids)
  const tracks = createTrackStore(uuids.map(() => kpCount), { impl })
  for (const pt of points) {
    const p = tracks.addPoint(pt.x, pt.y, pt.z)
    for (const [uuid, kp] of pt.views) tracks.addView(p, ids.img(uuid), kp)
  }
  return { tracks, ids }
}

/** The live points as `[{ x, y, z, views: Map<uuid, kp> }]`, in order. */
export function pointsOf(tracks, ids) {
  const out = []
  tracks.forEachPoint((p) => {
    const views = new Map()
    tracks.forEachView(p, (img, kp) => views.set(ids.uuid(img), kp))
    out.push({ x: tracks.x(p), y: tracks.y(p), z: tracks.z(p), views })
  })
  return out
}
