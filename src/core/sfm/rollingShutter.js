// Rolling shutter (plan-after-0.7 ▸ RSH): a CMOS sensor without a mechanical shutter
// reads its rows one after another over the readout time τ, so a camera that moves
// while it does sees the top and the bottom of the photo from different places. A
// global-shutter model takes up the difference as a sheared, bent block with small
// residuals; the check points see it.
//
// The model (bundle.rs `bundle_adjust_rs`): a camera's pose is the one at its principal
// row, and row r is read from C + τ·s·v, s = (r − cy)/h, v the camera centre's velocity.
// v comes from the camera's neighbours along the flight (their centres in the model and
// their capture times); τ is one unknown per camera group, estimated by the global
// bundle adjustments. The angular rate is taken as zero: a gimbal holds the camera still.
//
// A camera carries it as `rs: { v: [vx, vy, vz], h, tau }` (model units per second,
// frame rows, seconds), which every projection then honours (geometry.js
// projectRollingShutter). Pure.

import { cameraCenter } from './geometry.js'

// Capture time in seconds (any fixed origin), or null. EXIF DateTimeOriginal holds whole
// seconds; SubSecTimeOriginal ("45" = .45 s), where the camera writes it, adds the rest.
export function captureSeconds(meta) {
  const raw = meta?.dateTime
  if (raw == null || raw === '') return null
  let ms = raw instanceof Date ? raw.getTime() : NaN
  if (!Number.isFinite(ms)) {
    // EXIF's "YYYY:MM:DD HH:MM:SS", or an ISO string from a saved project.
    const text = String(raw).replace(/^(\d{4}):(\d{2}):(\d{2})[ T]/, '$1-$2-$3T')
    ms = Date.parse(text)
  }
  if (!Number.isFinite(ms)) return null
  const sub = String(meta?.subSecTime ?? '').match(/^\d+/)?.[0]
  return ms / 1000 + (sub ? Number(`0.${sub}`) : 0)
}

// Each camera's velocity from the cameras taken just before and after it: the slope of a
// least-squares line through the centres of a window of neighbours in capture order
// (whole-second times scatter a two-photo difference; the line over several photos
// averages that out). A window does not cross a pause longer than `maxGap` seconds, so a
// second flight or a hand-held pause starts afresh.
//   items  [{ key, t (s), C: [x, y, z] }]
// → Map key → [vx, vy, vz], for the cameras that have a usable window.
export function cameraVelocities(items, { half = 2, maxGap = 8 } = {}) {
  const sorted = items.filter((i) => Number.isFinite(i.t) && i.C?.every(Number.isFinite)).sort((a, b) => a.t - b.t)
  // Runs of photos without a long pause.
  const runs = []
  for (const it of sorted) {
    const run = runs.at(-1)
    if (run && it.t - run.at(-1).t <= maxGap) run.push(it)
    else runs.push([it])
  }
  const out = new Map()
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      const lo = Math.max(0, i - half),
        hi = Math.min(run.length - 1, i + half)
      if (hi - lo < 1) continue
      const win = run.slice(lo, hi + 1)
      const tm = win.reduce((s, w) => s + w.t, 0) / win.length
      const stt = win.reduce((s, w) => s + (w.t - tm) ** 2, 0)
      if (!(stt > 0)) continue
      const v = [0, 1, 2].map((k) => {
        const cm = win.reduce((s, w) => s + w.C[k], 0) / win.length
        return win.reduce((s, w) => s + (w.t - tm) * (w.C[k] - cm), 0) / stt
      })
      out.set(run[i].key, v)
    }
  }
  return out
}

// Give the registered cameras their rolling-shutter record from the current model:
// velocity from their neighbours, frame height, and their group's readout time (kept from
// an earlier solve, else `tau0`). A camera with no capture time or no neighbour, or a film
// scan, gets none (it is solved as a global shutter). Changes `cameras` in place.
//   cameras     Map uuid → { R, t, K, rs? }
//   frameOf     uuid → { t (s) | null, h (frame rows) | null, group, film? }
// → { cameras: with a record, groups: Map group → τ }
export function attachRollingShutter(cameras, frameOf, { tau0 = 0 } = {}) {
  const items = []
  const taus = new Map()
  for (const [uuid, cam] of cameras) {
    const f = frameOf(uuid)
    if (!f || f.film || !(f.h > 0) || f.t == null) continue
    items.push({ key: uuid, t: f.t, C: cameraCenter(cam) })
    if (cam.rs && Number.isFinite(cam.rs.tau) && !taus.has(f.group)) taus.set(f.group, cam.rs.tau)
  }
  const v = cameraVelocities(items)
  let n = 0
  for (const [uuid, cam] of cameras) {
    const f = frameOf(uuid)
    const vel = v.get(uuid)
    if (!vel) {
      if (cam.rs) cameras.set(uuid, withoutRs(cam))
      continue
    }
    const tau = taus.get(f.group) ?? tau0
    cameras.set(uuid, { ...cam, rs: { v: vel, h: f.h, tau } })
    n++
  }
  return { cameras: n, groups: taus }
}

function withoutRs(cam) {
  // eslint-disable-next-line no-unused-vars
  const { rs, ...rest } = cam
  return rest
}

// The readout times a model ended with, one per camera group: { group → τ (s) }, and the
// count of cameras that carry a record.
export function readoutSummary(cameras, groupOf) {
  const out = new Map()
  for (const [uuid, cam] of cameras) {
    if (!(cam.rs?.h > 0)) continue
    const g = groupOf(uuid)
    const rec = out.get(g) ?? { tau: cam.rs.tau, cameras: 0 }
    rec.cameras++
    out.set(g, rec)
  }
  return out
}
