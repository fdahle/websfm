// What the 3D view shows while incremental SfM runs: the registered cameras and the
// points triangulated so far, sent from the worker every few seconds (pure).
//
// A snapshot is a copy: { cameras: [{ uuid, R, t, K }], pos: Float64Array(3n),
// col: Uint8Array(3n) | null }, both arrays transferable. A point takes the colour of
// its first view's keypoint (the finished cloud averages them). Only points seen from two or more registered cameras are included, as
// the finished cloud has, and a big model is thinned evenly to `maxPoints`: the view is
// a progress picture, and copying millions of points every few seconds would slow the
// run it shows.

export const SNAPSHOT_INTERVAL_MS = 2000
export const SNAPSHOT_MAX_POINTS = 200_000

// cameras: Map uuid → { R, t, K }; tracks: the run's track store (trackStore.js);
// keypointsAt(img) → that image's KeypointSet (keypointSet.js), for colour.
export function sparseSnapshot(cameras, tracks, { maxPoints = SNAPSHOT_MAX_POINTS, keypointsAt = null } = {}) {
  const ids = []
  tracks.forEachPoint((p) => {
    if (tracks.viewCount(p) >= 2) ids.push(p)
  })
  const step = Math.max(1, ids.length / maxPoints)
  const n = Math.min(ids.length, Math.floor(ids.length / step))
  const pos = new Float64Array(3 * n)
  let col = keypointsAt ? new Uint8Array(3 * n) : null
  let coloured = 0
  for (let i = 0; i < n; i++) {
    const p = ids[Math.floor(i * step)]
    pos[3 * i] = tracks.x(p)
    pos[3 * i + 1] = tracks.y(p)
    pos[3 * i + 2] = tracks.z(p)
    if (col) {
      tracks.someView(p, (img, kp) => {
        const set = keypointsAt(img)
        if (!set?.hasColor?.[kp]) return false
        col[3 * i] = set.rgb[3 * kp]
        col[3 * i + 1] = set.rgb[3 * kp + 1]
        col[3 * i + 2] = set.rgb[3 * kp + 2]
        coloured++
        return true
      })
    }
  }
  if (!coloured) col = null
  const cams = []
  for (const [uuid, c] of cameras) {
    cams.push({ uuid, R: c.R.map((row) => [...row]), t: [...c.t], K: { ...c.K } })
  }
  return { cameras: cams, pos, col }
}

// Calls `send(snapshot())` at most once per `intervalMs`; `tick()` is cheap to call
// as often as progress is reported. The first tick sends, so the view starts with the
// initial pair; `tick({ force: true })` sends now, at the end of a phase that may have
// finished inside one interval.
export function createSnapshotPacer(
  send,
  snapshot,
  { intervalMs = SNAPSHOT_INTERVAL_MS, now = () => Date.now() } = {},
) {
  let last = -Infinity
  return {
    tick({ force = false } = {}) {
      if (!send) return
      const t = now()
      if (!force && t - last < intervalMs) return
      // null: nothing worth drawing yet (no initial pair); the interval is not spent.
      const snap = snapshot()
      if (!snap) return
      last = t
      send(snap)
    },
  }
}
