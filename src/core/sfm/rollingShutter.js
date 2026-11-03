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

import { cameraCenter, jacobiEigen3 } from './geometry.js'

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

// ── The photo on the principal row's pose (RSH-4) ──────────────────────────────
// Dense matching, the orthophoto and the texture work with one pose per photo, the
// principal row's. A rolling-shutter photo is resampled onto that pose once, where its
// pixels are read (displayFrame.js makeSampleMap `rs`), so all of them see the
// corrected image. Each pixel's ray is taken to the plane fitted to the sparse points
// the photo sees (an oblique photo's ground recedes), else to their median depth: a
// point off that surface lands off by the shift times its relative distance from it, a
// few hundredths of a pixel for a shift of a few pixels over a flat site.
//
// A warp is { w: R·v (camera-frame velocity, model units/s), tau (s), h (rows), depth
// (median camera z), plane: { n, d } (camera frame, n·X = d) | null }.

// Each rolling-shutter camera's warp: its velocity in its own frame, its readout time
// and frame height, and the surface of the sparse points it sees. Cameras without a
// record, with τ ≈ 0, or that see no point in front of them get none.
//   cameras  Map uuid → { R, t, K, rs? }
//   points   SparsePoints (pos, vstart, vcam, viewUuids)
// → Map uuid → warp
export function rollingShutterWarps(cameras, points, { minShiftPx = 0.01, maxSamples = 4096 } = {}) {
  const out = new Map()
  const want = new Map()
  for (const [uuid, cam] of cameras) {
    const rs = cam.rs
    if (!(rs?.h > 0) || !Number.isFinite(rs.tau) || !rs.v?.every(Number.isFinite)) continue
    if (!(Math.abs(rs.tau) * Math.hypot(...rs.v) > 0)) continue
    want.set(uuid, [])
  }
  if (!want.size || !points?.pos) return out
  const { pos, vstart, vcam, viewUuids } = points
  const n = points.length
  // Sample the points evenly so a big model costs as much as a small one.
  const step = Math.max(1, Math.floor(n / (maxSamples * 4)))
  for (let i = 0; i < n; i += step) {
    const x = pos[3 * i],
      y = pos[3 * i + 1],
      z = pos[3 * i + 2]
    for (let k = vstart[i]; k < vstart[i + 1]; k++) {
      const uuid = viewUuids[vcam[k]]
      const list = want.get(uuid)
      if (!list || list.length >= maxSamples) continue
      const { R, t } = cameras.get(uuid)
      const zc = R[2][0] * x + R[2][1] * y + R[2][2] * z + t[2]
      if (!(zc > 0)) continue
      list.push([R[0][0] * x + R[0][1] * y + R[0][2] * z + t[0], R[1][0] * x + R[1][1] * y + R[1][2] * z + t[1], zc])
    }
  }
  for (const [uuid, list] of want) {
    if (!list.length) continue
    const zs = list.map((p) => p[2]).sort((a, b) => a - b)
    const depth = zs[zs.length >> 1]
    const { R, rs, K } = cameras.get(uuid)
    const w = [0, 1, 2].map((i) => R[i][0] * rs.v[0] + R[i][1] * rs.v[1] + R[i][2] * rs.v[2])
    // The largest shift over the frame (half a readout at the edge rows), in pixels:
    // below `minShiftPx` the photo is left as it is.
    const f = K?.fx ?? 1
    const shiftPx = (f * Math.abs(rs.tau) * 0.5 * Math.hypot(w[0], w[1])) / depth
    if (!(shiftPx >= minShiftPx)) continue
    out.set(uuid, { w, tau: rs.tau, h: rs.h, depth, plane: fitPlane(list, zs) })
  }
  return out
}

// The plane through camera-frame points, { n, d } with n·X = d > 0, from those between
// the 10th and 90th depth percentiles (a stray far or near point does not tilt it); null
// for fewer than 8 points or a cloud that is not flat (its thinnest spread over a fifth
// of its middle one): the median depth then stands in.
function fitPlane(list, zs) {
  if (list.length < 8) return null
  const lo = zs[Math.floor(0.1 * (zs.length - 1))],
    hi = zs[Math.ceil(0.9 * (zs.length - 1))]
  const pts = list.filter((p) => p[2] >= lo && p[2] <= hi)
  if (pts.length < 8) return null
  const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length)
  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (const p of pts) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) M[a][b] += (p[a] - c[a]) * (p[b] - c[b])
  const { values, vectors } = jacobiEigen3(M)
  const order = [0, 1, 2].sort((a, b) => values[a] - values[b])
  if (!(values[order[0]] <= 0.2 * values[order[1]])) return null
  let nrm = vectors[order[0]]
  let d = nrm[0] * c[0] + nrm[1] * c[1] + nrm[2] * c[2]
  if (d < 0) {
    nrm = nrm.map((x) => -x)
    d = -d
  }
  if (!(d > 0)) return null
  return { n: nrm, d }
}

// A pixel of the principal row's (global-shutter) image → the pixel of the photo that
// recorded the same scene point: the ray through (x, y) to the warp's surface, seen from
// where the camera was when it read that point's row (iterated, as
// projectRollingShutter does). Both in the camera's pinhole frame (K).
export function rollingShutterPixel(warp, K, x, y) {
  const { w, tau, h, depth, plane } = warp
  const rx = (x - K.cx) / K.fx,
    ry = (y - K.cy) / K.fy
  // Depth of the ray's point: on the plane, unless the ray grazes it (then the median).
  let z = depth
  if (plane) {
    const den = plane.n[0] * rx + plane.n[1] * ry + plane.n[2]
    const zp = den > 0 ? plane.d / den : NaN
    if (zp > depth / 4 && zp < depth * 4) z = zp
  }
  const X = z * rx,
    Y = z * ry
  let u = x,
    v = y
  for (let i = 0; i < 4; i++) {
    const k = (tau * (v - K.cy)) / h
    const zc = z - k * w[2]
    if (!(zc > 1e-9)) return { x, y }
    u = (K.fx * (X - k * w[0])) / zc + K.cx
    v = (K.fy * (Y - k * w[1])) / zc + K.cy
  }
  return { x: u, y: v }
}
