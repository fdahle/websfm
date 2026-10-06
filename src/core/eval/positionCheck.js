import { cameraCenter } from '../sfm/geometry.js'
import { fitSimilarity, applySimilarity } from '../products/georef.js'

// ── Camera centres vs independent GNSS positions (pure) ──────────────────────
// When the images carry positions the reconstruction never saw (EXIF GNSS, with no
// camera priors in the solve), the best 7-parameter similarity from SfM centres to
// those positions leaves residuals that measure the model's SHAPE error — bending,
// doming, scale drift — plus the GNSS noise. With RTK/PPK positions (a few cm) that is
// close to ground truth, and unlike a point count it says whether a change made the
// reconstruction more correct rather than merely larger.
//
// Positions are WGS84 geodetic (lat/lon degrees, ellipsoidal or orthometric height —
// a constant offset is absorbed by the fit). They go to ECEF, then to a local
// east-north-up frame at their centroid, which is Cartesian and metric, so the
// similarity needs no map projection.

const A = 6378137
const F = 1 / 298.257223563
const E2 = F * (2 - F)
const RAD = Math.PI / 180

export function geodeticToEcef(latDeg, lonDeg, h) {
  const lat = latDeg * RAD, lon = lonDeg * RAD
  const s = Math.sin(lat), c = Math.cos(lat)
  const n = A / Math.sqrt(1 - E2 * s * s)
  return [(n + h) * c * Math.cos(lon), (n + h) * c * Math.sin(lon), (n * (1 - E2) + h) * s]
}

/** ECEF → ENU about a geodetic origin. */
export function makeEnuFrame(lat0Deg, lon0Deg, h0) {
  const o = geodeticToEcef(lat0Deg, lon0Deg, h0)
  const lat = lat0Deg * RAD, lon = lon0Deg * RAD
  const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon)
  return (p) => {
    const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]
    return [
      -so * d[0] + co * d[1],
      -sl * co * d[0] - sl * so * d[1] + cl * d[2],
      cl * co * d[0] + cl * so * d[1] + sl * d[2],
    ]
  }
}

const quantile = (arr, f) => {
  if (!arr.length) return null
  const a = [...arr].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(f * a.length))]
}
const rms = (arr) => (arr.length ? Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length) : null)

/**
 * @param {Map<string, {R:number[][], t:number[]}>} cameras   registered SfM cameras
 * @param {Map<string, {lat:number, lon:number, alt:number}>} positions  per image uuid
 * @param {object} [opts]
 * @param {number[]|null} [opts.leverArm]  GNSS antenna in the camera frame (x right, y
 *   down, z forward), metres. The positions are the antenna's, so each camera centre
 *   is moved to C + Rᵀ·a/s before the fit; s (SfM units per metre) comes from a first
 *   fit without it, then the fit is repeated.
 * @returns {null | { count, scale, rms3d, rmsH, rmsV, medianH, p95H, maxH, medianV, p95V, maxV, worst, sim, toEnu }}
 *   metres; `worst` lists the five largest 3D residuals by uuid. `sim` maps SfM →
 *   the local ENU frame `toEnu` (geodetic → ENU via ECEF), for checkpoints.
 */
export function cameraPositionCheck(cameras, positions, { leverArm = null } = {}) {
  const ids = [...cameras.keys()].filter((u) => {
    const p = positions.get(u)
    return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.alt)
  })
  if (ids.length < 3) return null
  let lat0 = 0, lon0 = 0, h0 = 0
  for (const u of ids) { const p = positions.get(u); lat0 += p.lat; lon0 += p.lon; h0 += p.alt }
  const toEnu = makeEnuFrame(lat0 / ids.length, lon0 / ids.length, h0 / ids.length)
  const pairs = ids.map((u) => {
    const p = positions.get(u)
    return { uuid: u, src: cameraCenter(cameras.get(u)), dst: toEnu(geodeticToEcef(p.lat, p.lon, p.alt)) }
  })
  let sim = fitSimilarity(pairs)
  if (!sim) return null
  if (leverArm) {
    for (let it = 0; it < 2; it++) {
      const k = 1 / sim.scale
      for (const pr of pairs) {
        const { R } = cameras.get(pr.uuid), C = cameraCenter(cameras.get(pr.uuid))
        pr.src = [0, 1, 2].map((i) => C[i] + k * (R[0][i] * leverArm[0] + R[1][i] * leverArm[1] + R[2][i] * leverArm[2]))
      }
      sim = fitSimilarity(pairs) ?? sim
    }
  }
  const h = [], v = [], d3 = []
  for (const pr of pairs) {
    const q = applySimilarity(sim, pr.src)
    const dh = Math.hypot(q[0] - pr.dst[0], q[1] - pr.dst[1]), dv = q[2] - pr.dst[2]
    h.push(dh); v.push(Math.abs(dv)); d3.push(Math.hypot(dh, dv))
  }
  const worst = d3.map((r, i) => ({ uuid: pairs[i].uuid, m: r })).sort((a, b) => b.m - a.m).slice(0, 5)
  return {
    count: ids.length, scale: sim.scale,
    rms3d: rms(d3), rmsH: rms(h), rmsV: rms(v),
    medianH: quantile(h, 0.5), p95H: quantile(h, 0.95), maxH: quantile(h, 1),
    medianV: quantile(v, 0.5), p95V: quantile(v, 0.95), maxV: quantile(v, 1),
    worst, sim, toEnu,
  }
}

/**
 * Checkpoints: GCPs the solve never used, triangulated from their image marks in the
 * SfM frame, taken through the camera-position similarity, and compared with their
 * survey. This is the direct-georeferencing error a user of the model would see.
 * @param {{ sim:object, toEnu:Function }} fit   from cameraPositionCheck
 * @param {{ label:string, sfm:number[]|null, lat:number, lon:number, h:number, views?:number }[]} gcps
 */
export function gcpCheck(fit, gcps) {
  const rows = gcps.map((g) => {
    if (!g.sfm) return { label: g.label, views: g.views ?? 0, dE: null, dN: null, dU: null }
    const q = applySimilarity(fit.sim, g.sfm)
    const t = fit.toEnu(geodeticToEcef(g.lat, g.lon, g.h))
    return { label: g.label, views: g.views ?? 0, dE: q[0] - t[0], dN: q[1] - t[1], dU: q[2] - t[2] }
  })
  const ok = rows.filter((r) => r.dE != null)
  const mean = (f) => (ok.length ? ok.reduce((s, r) => s + f(r), 0) / ok.length : null)
  return {
    count: ok.length, of: rows.length,
    rmsH: rms(ok.map((r) => Math.hypot(r.dE, r.dN))), rmsV: rms(ok.map((r) => r.dU)),
    meanE: mean((r) => r.dE), meanN: mean((r) => r.dN), meanU: mean((r) => r.dU),
    rows,
  }
}
