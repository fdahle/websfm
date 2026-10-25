// Dense geometry primitives shared by Stage A, the cross-view filter and fusion: the
// relative pose, the in-front projector alias and its exact inverse (unprojectPixel),
// and the frustum-slice cull (sliceCorners / sliceMisses / CULL_MARGIN). Every caller
// imports these single definitions — exactness across modules depends on identical
// arithmetic, so never copy them.

import { projectWithDepth } from '../sfm/geometry.js'

// ── Geometry helpers ────────────────────────────────────────────────────────────

// Pose of the source camera relative to the reference: maps a point expressed in
// the reference camera frame into the source camera frame.
//   X_src = R_src·X_world + t_src,  X_world = R_refᵀ(X_ref − t_ref)
//   ⇒ R_rel = R_src·R_refᵀ,  t_rel = t_src − R_rel·t_ref
export function relativePose(refCam, srcCam) {
  const { R: Rr, t: tr } = refCam
  const { R: Rs, t: ts } = srcCam
  // R_rel = Rs · Rrᵀ
  const R = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) R[i][j] = Rs[i][0] * Rr[j][0] + Rs[i][1] * Rr[j][1] + Rs[i][2] * Rr[j][2]
  // t_rel = ts − R_rel·tr
  const t = [
    ts[0] - (R[0][0] * tr[0] + R[0][1] * tr[1] + R[0][2] * tr[2]),
    ts[1] - (R[1][0] * tr[0] + R[1][1] * tr[1] + R[1][2] * tr[2]),
    ts[2] - (R[2][0] * tr[0] + R[2][1] * tr[1] + R[2][2] * tr[2]),
  ]
  return { R, t }
}

// Local alias: dense reprojection wants the in-front-only projector (returns depth).
export const project = projectWithDepth

// Back-project a working pixel (u,v,depth) of map `m` to a world point.
//   X_cam = ((u−cx)/fx·d, (v−cy)/fy·d, d);  X_world = Rᵀ(X_cam − t)
// Shared by fuseDepthMaps and filterDepthMapsGeometric — both need the exact same
// inverse of `project`, and a divergence between them would silently misreport
// cross-view agreement.
export function unprojectPixel(m, u, v, depth) {
  const xc = ((u - m.K.cx) / m.K.fx) * depth
  const yc = ((v - m.K.cy) / m.K.fy) * depth
  const zc = depth
  const ax = xc - m.t[0],
    ay = yc - m.t[1],
    az = zc - m.t[2]
  return {
    x: m.R[0][0] * ax + m.R[1][0] * ay + m.R[2][0] * az,
    y: m.R[0][1] * ax + m.R[1][1] * ay + m.R[2][1] * az,
    z: m.R[0][2] * ax + m.R[1][2] * ay + m.R[2][2] * az,
  }
}

// unprojectPixel for a per-pixel loop: map `m`'s constants read once, the point written
// into `out` ({ x, y, z }, reused) instead of a new object for every pixel (fusion's plan
// and pass unprojected ~400 M pixels on quarry, each into a fresh object). The same
// arithmetic in the same order, so the same bits.
export function pixelUnprojector(m) {
  const { cx, cy, fx, fy } = m.K
  const t0 = m.t[0],
    t1 = m.t[1],
    t2 = m.t[2]
  const [r0, r1, r2] = m.R
  const r00 = r0[0],
    r01 = r0[1],
    r02 = r0[2],
    r10 = r1[0],
    r11 = r1[1],
    r12 = r1[2],
    r20 = r2[0],
    r21 = r2[1],
    r22 = r2[2]
  return (u, v, depth, out) => {
    const ax = ((u - cx) / fx) * depth - t0,
      ay = ((v - cy) / fy) * depth - t1,
      az = depth - t2
    out.x = r00 * ax + r10 * ay + r20 * az
    out.y = r01 * ax + r11 * ay + r21 * az
    out.z = r02 * ax + r12 * ay + r22 * az
    return out
  }
}

// `project` (sfm/geometry.js projectWithDepth) for a per-pixel loop, the same way:
// camera `cam`'s constants read once, { u, v, depth } written into `out`; null behind
// the camera, as there. Same arithmetic, same bits.
export function pixelProjector(cam) {
  const { R, t, K } = cam
  const r00 = R[0][0],
    r01 = R[0][1],
    r02 = R[0][2],
    r10 = R[1][0],
    r11 = R[1][1],
    r12 = R[1][2],
    r20 = R[2][0],
    r21 = R[2][1],
    r22 = R[2][2]
  const t0 = t[0],
    t1 = t[1],
    t2 = t[2]
  const { fx, fy, cx, cy } = K
  return (x, y, z, out) => {
    const zc = r20 * x + r21 * y + r22 * z + t2
    if (!(zc > 1e-9)) return null
    const xc = r00 * x + r01 * y + r02 * z + t0
    const yc = r10 * x + r11 * y + r12 * z + t1
    out.u = fx * (xc / zc) + cx
    out.v = fy * (yc / zc) + cy
    out.depth = zc
    return out
  }
}

// ── Frustum-slice cull ──────────────────────────────────────────────────────────
// The exactness argument (and why the cull is per map, then per block) is spelled out
// in geomFilter.js ▸ "Candidate views". sliceCorners: the 8 world-space corners of the
// depth slice of the valid pixels in [ua,ub)×[va,vb) of map `m` (null if none).
// sliceMisses: true when that slice cannot land on camera `c`'s raster. `margin` must
// cover the caller's own per-pixel test: CULL_MARGIN for the filter's single rounded
// pixel, rad + 1 for streamed fusion's ±consistencyPx window.
const CULL_MARGIN = 1

export function sliceCorners(m, ua, ub, va, vb) {
  const { width: w, depth } = m
  let u0 = Infinity,
    u1 = -Infinity,
    v0 = Infinity,
    v1 = -Infinity,
    d0 = Infinity,
    d1 = -Infinity
  for (let v = va; v < vb; v++) {
    for (let u = ua; u < ub; u++) {
      const d = depth[v * w + u]
      if (!(d > 0)) continue
      if (u < u0) u0 = u
      if (u > u1) u1 = u
      if (v < v0) v0 = v
      if (v > v1) v1 = v
      if (d < d0) d0 = d
      if (d > d1) d1 = d
    }
  }
  if (!(d1 > 0)) return null // no valid pixel ⇒ nothing to check
  const corners = []
  for (const d of [d0, d1]) for (const u of [u0, u1]) for (const v of [v0, v1]) corners.push(unprojectPixel(m, u, v, d))
  return corners
}

export function sliceMisses(corners, c, margin = CULL_MARGIN) {
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity,
    behind = 0
  for (const P of corners) {
    const p = project(c, P.x, P.y, P.z)
    if (!p) {
      behind++
      continue
    }
    if (p.u < minU) minU = p.u
    if (p.u > maxU) maxU = p.u
    if (p.v < minV) minV = p.v
    if (p.v > maxV) maxV = p.v
  }
  if (behind === corners.length) return true
  return (
    !behind &&
    (maxU < -0.5 - margin || minU > c.width - 0.5 + margin || maxV < -0.5 - margin || minV > c.height - 0.5 + margin)
  )
}
