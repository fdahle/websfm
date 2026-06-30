// Dense reconstruction (Multi-View Stereo) — pure compute, no Vue/Pinia/OPFS/DOM.
// Mirrors core/sfm.js: plain data in, plain data out, side effects via hooks. The
// worker (compute.worker.js) decodes image pixels (OffscreenCanvas) and calls
// these; the store keeps reactive state + persistence.
//
// Pipeline (two standalone stages, like Metashape's Build Depth Maps → Build
// Point Cloud):
//   A. computeDepthMaps — per reference image: pick source views, seed a depth
//      range from the sparse cloud, run PatchMatch (compute_depth_map in the
//      reconstruction crate). Produces one depth map per image.
//   B. fuseDepthMaps    — reproject depth pixels to 3D, keep those consistent
//      across ≥k views, colour from the reference pixel. Produces a dense cloud.

import { computeDepthMap } from './reconstruction.js'
import {
  cameraCenter, projectWithDepth, triangulationAngle, scaleK, rgbaToGray,
} from './geometry.js'

// Re-exported for the compute worker, which imports them from this module.
export { cameraCenter, scaleK, rgbaToGray }

// ── Geometry helpers ────────────────────────────────────────────────────────────

// Pose of the source camera relative to the reference: maps a point expressed in
// the reference camera frame into the source camera frame.
//   X_src = R_src·X_world + t_src,  X_world = R_refᵀ(X_ref − t_ref)
//   ⇒ R_rel = R_src·R_refᵀ,  t_rel = t_src − R_rel·t_ref
export function relativePose(refCam, srcCam) {
  const { R: Rr, t: tr } = refCam
  const { R: Rs, t: ts } = srcCam
  // R_rel = Rs · Rrᵀ
  const R = [[0,0,0],[0,0,0],[0,0,0]]
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      R[i][j] = Rs[i][0]*Rr[j][0] + Rs[i][1]*Rr[j][1] + Rs[i][2]*Rr[j][2]
  // t_rel = ts − R_rel·tr
  const t = [
    ts[0] - (R[0][0]*tr[0] + R[0][1]*tr[1] + R[0][2]*tr[2]),
    ts[1] - (R[1][0]*tr[0] + R[1][1]*tr[1] + R[1][2]*tr[2]),
    ts[2] - (R[2][0]*tr[0] + R[2][1]*tr[1] + R[2][2]*tr[2]),
  ]
  return { R, t }
}

// Local alias: dense reprojection wants the in-front-only projector (returns depth).
const project = projectWithDepth

// ── Stage A helpers ──────────────────────────────────────────────────────────

// Pick the best source views for a reference image: candidates that share the
// most sparse 3D points with the reference at a healthy parallax angle. Returns
// up to `maxSources` source uuids, best first.
//   cameras: Map<uuid, { R, t, K }>   points: [{ x, y, z, views: [[uuid,kpIdx],…] }]
export function selectSourceViews(cameras, points, refUuid, opts = {}) {
  const { maxSources = 6, minAngleDeg = 3, maxAngleDeg = 60 } = opts
  const refCam = cameras.get(refUuid)
  if (!refCam) return []
  const Cref = cameraCenter(refCam)
  const centers = new Map()
  const score = new Map()

  for (const pt of points) {
    const viewers = pt.views.map(([u]) => u)
    if (!viewers.includes(refUuid)) continue
    for (const u of viewers) {
      if (u === refUuid || !cameras.has(u)) continue
      if (!centers.has(u)) centers.set(u, cameraCenter(cameras.get(u)))
      const ang = triangulationAngle(Cref, centers.get(u), pt)
      if (ang >= minAngleDeg && ang <= maxAngleDeg) score.set(u, (score.get(u) || 0) + 1)
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxSources)
    .map(([u]) => u)
}

// Seed a depth map + depth range for a reference image from the sparse cloud:
// project every point in front of the reference camera, splat its depth to the
// nearest working pixel. Returns { seedDepth: Float32Array(w*h), depthMin, depthMax }
// where the range is a padded 5–95th percentile of the seeded depths.
export function seedDepthFromSparse(refCam, points, width, height) {
  const seed = new Float32Array(width * height) // 0 ⇒ no seed
  const depths = []
  for (const pt of points) {
    const p = project(refCam, pt.x, pt.y, pt.z)
    if (!p) continue
    const u = Math.round(p.u), v = Math.round(p.v)
    if (u < 0 || v < 0 || u >= width || v >= height) continue
    seed[v * width + u] = p.depth
    depths.push(p.depth)
  }
  if (depths.length < 2) return { seedDepth: seed, depthMin: 0, depthMax: 0 }
  depths.sort((a, b) => a - b)
  const at = (q) => depths[Math.min(depths.length - 1, Math.max(0, Math.round(q * (depths.length - 1))))]
  const lo = at(0.05), hi = at(0.95)
  const pad = (hi - lo) * 0.25 || hi * 0.1
  return { seedDepth: seed, depthMin: Math.max(1e-4, lo - pad), depthMax: hi + pad }
}

// Run PatchMatch for one reference image given already-rasterised pixels. `ref`
// and each `sources[i]` carry { gray, width/w, height/h }; cameras carry the
// scaled working K. Thin wrapper over the wasm so the worker stays declarative.
//   ref:     { gray, width, height, K, cam:{R,t,K?} }
//   sources: [{ gray, w, h, K, cam }]   (cam = full { R, t, K } pose)
export async function depthMapForImage(ref, sources, points, settings = {}) {
  const { window = 2, iterations = 3, bestK = 3 } = settings
  const refCamScaled = { R: ref.cam.R, t: ref.cam.t, K: ref.K }
  const { seedDepth, depthMin, depthMax } = seedDepthFromSparse(refCamScaled, points, ref.width, ref.height)
  if (!(depthMax > depthMin)) return null // no sparse support → can't bound depth

  const src = sources.map((s) => {
    const { R, t } = relativePose(ref.cam, s.cam)
    return { gray: s.gray, w: s.w, h: s.h, K: s.K, R, t }
  })

  return computeDepthMap(ref.gray, ref.width, ref.height, ref.K, src, {
    depthMin, depthMax, seedDepth, window, iterations, bestK,
    seed: (ref.width * 73856093) ^ (ref.height * 19349663),
  })
}

// ── Stage B: fusion ──────────────────────────────────────────────────────────

// Fuse per-image depth maps into a dense point cloud. Each map carries its
// reference pose + working K, the depth/cost planes, and an RGB buffer (colours
// at working resolution). A pixel's 3D point is kept only if it reprojects into
// at least `minViews` OTHER maps within `consistencyPx` and at a consistent depth
// (geometric consistency — the cross-view check the per-image PatchMatch omits).
//   maps: [{ uuid, width, height, K, R, t, depth:Float32Array, cost:Float32Array,
//            rgb:Uint8Array(w*h*3) }]
// Returns [{ x, y, z, color:[r,g,b] }].
export function fuseDepthMaps(maps, opts = {}) {
  const {
    minViews = 2, consistencyPx = 2, depthTolRel = 0.01,
    maxCost = 0.6, step = 2,
  } = opts

  // Cameras for reprojection consistency checks.
  const cams = maps.map((m) => ({ R: m.R, t: m.t, K: m.K, m }))

  // Back-project a working pixel (u,v,depth) of map m to a world point.
  const unproject = (m, u, v, depth) => {
    const xc = (u - m.K.cx) / m.K.fx * depth
    const yc = (v - m.K.cy) / m.K.fy * depth
    const zc = depth
    // X_world = Rᵀ(X_cam − t)
    const ax = xc - m.t[0], ay = yc - m.t[1], az = zc - m.t[2]
    return {
      x: m.R[0][0]*ax + m.R[1][0]*ay + m.R[2][0]*az,
      y: m.R[0][1]*ax + m.R[1][1]*ay + m.R[2][1]*az,
      z: m.R[0][2]*ax + m.R[1][2]*ay + m.R[2][2]*az,
    }
  }

  const out = []
  for (const m of maps) {
    const { width: w, height: h, depth, cost, rgb } = m
    for (let v = 0; v < h; v += step) {
      for (let u = 0; u < w; u += step) {
        const idx = v * w + u
        const d = depth[idx]
        if (!(d > 0) || cost[idx] > maxCost) continue
        const P = unproject(m, u, v, d)

        // Geometric consistency: reproject into other maps and require a pixel
        // within a `consistencyPx` radius whose depth agrees (relative tolerance).
        // The radius search makes the check robust to sub-pixel reprojection /
        // PatchMatch noise — a single rounded-pixel probe rejected most valid
        // points (and `consistencyPx` was previously inert: added to a world-unit
        // depth tolerance scaled by 1e-3, i.e. ≈0).
        const rad = Math.max(0, Math.round(consistencyPx))
        let agree = 0
        for (const c of cams) {
          if (c.m === m) continue
          const p = project(c, P.x, P.y, P.z)
          if (!p) continue
          const cu = Math.round(p.u), cv = Math.round(p.v)
          const tol = depthTolRel * p.depth
          let hit = false
          for (let dv = -rad; dv <= rad && !hit; dv++) {
            const pv = cv + dv
            if (pv < 0 || pv >= c.m.height) continue
            for (let du = -rad; du <= rad; du++) {
              const pu = cu + du
              if (pu < 0 || pu >= c.m.width) continue
              const od = c.m.depth[pv * c.m.width + pu]
              if (od > 0 && Math.abs(od - p.depth) <= tol) { hit = true; break }
            }
          }
          if (hit) {
            agree++
            if (agree >= minViews) break
          }
        }
        if (agree < minViews) continue

        const o = idx * 3
        out.push({ x: P.x, y: P.y, z: P.z, color: [rgb[o], rgb[o+1], rgb[o+2]] })
      }
    }
  }
  return out
}
