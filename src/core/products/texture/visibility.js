// Which views see which faces, and how well (plan-texture ▸ Pipeline 1). Pure.
//
// Per view the mesh is rasterised into a depth buffer (its own z-buffer, not the depth
// maps: those have holes, sit at working resolution and disagree with a decimated or
// imported mesh). A face is a candidate for a view when four probes on it (the corners
// pulled 10 % toward the centroid, and the centroid) are in front of the camera, on a
// usable pixel, and pass the depth test; and when it faces the camera at more than
// `minCos`. Requiring the whole face visible is what keeps an occluder's edge out of
// the texture. The score is the face's projected area in full-resolution pixels (how
// many texels the view can give it) times the view's weight (image quality).
//
// The mesh's winding is not trusted: Poisson output is consistently oriented, an
// imported STL may not be. Candidates are kept with the sign of their facing, and the
// orientation is decided from all of them at the end: a clear majority one way drops
// the back faces (the inside of a thin wall); a split means an unoriented mesh, and
// |cos| is used.
//
// Conventions: views are { R (row-major 3×3), t, K, width, height, rect?, weight? } with
// K in full-resolution pinhole pixels (geometry.js). `rect` = { x0, y0, width, height }
// is the pinhole-pixel window a face must lie in (default: the photo; a fisheye passes
// its 60° canvas). Pixel centres sit at integers.

import { TEXTURE_TUNING } from '../../tuning.js'

export const NO_VIEW = 0xffff
const FALLBACK_K = 4 // partly hidden views kept per face
const PROBE_PULL = 0.1 // probes sit this share of the way from a corner to the centroid

// The mesh in a local Float64 frame around its bounding-box centre (projected
// coordinates lose precision in Float32), plus each face's centroid and unit normal.
export function meshGeometry(pos, idx) {
  const V = pos.length / 3, F = idx.length / 3
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < V; i++) {
    for (let c = 0; c < 3; c++) {
      const x = pos[3 * i + c]
      if (x < lo[c]) lo[c] = x
      if (x > hi[c]) hi[c] = x
    }
  }
  const origin = V ? [0, 1, 2].map((c) => (lo[c] + hi[c]) / 2) : [0, 0, 0]
  const P = new Float64Array(3 * V)
  for (let i = 0; i < V; i++) for (let c = 0; c < 3; c++) P[3 * i + c] = pos[3 * i + c] - origin[c]
  const centroid = new Float64Array(3 * F), normal = new Float32Array(3 * F)
  for (let f = 0; f < F; f++) {
    const a = 3 * idx[3 * f], b = 3 * idx[3 * f + 1], c = 3 * idx[3 * f + 2]
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2]
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const n = Math.hypot(nx, ny, nz)
    if (n > 0) { normal[3 * f] = nx / n; normal[3 * f + 1] = ny / n; normal[3 * f + 2] = nz / n }
    for (let k = 0; k < 3; k++) centroid[3 * f + k] = (P[a + k] + P[b + k] + P[c + k]) / 3
  }
  return { origin, P, centroid, normal, nVerts: V, nFaces: F }
}

// The view's camera in the mesh's local frame: x_cam = R·(X_local + origin) + t.
export function localCamera(view, origin) {
  const { R, t, K } = view
  const r = Float64Array.of(...R[0], ...R[1], ...R[2])
  const tl = [0, 1, 2].map((i) => r[3 * i] * origin[0] + r[3 * i + 1] * origin[1] + r[3 * i + 2] * origin[2] + t[i])
  const C = [0, 1, 2].map((j) => -(r[j] * tl[0] + r[3 + j] * tl[1] + r[6 + j] * tl[2]))
  return { r, t: tl, K, C }
}

// The z-buffer grid of a view: its window at a scale whose long side is ≤ bufferSide.
// A pinhole pixel x lies at grid x' = (x − x0 + ½)·scale − ½ (geometry.js toScaledPx).
export function viewGrid(view, bufferSide = TEXTURE_TUNING.bufferSide) {
  const rect = view.rect ?? { x0: 0, y0: 0, width: view.width, height: view.height }
  const scale = Math.min(1, bufferSide / Math.max(rect.width, rect.height))
  return {
    scale, x0: rect.x0, y0: rect.y0,
    width: Math.max(1, Math.ceil(rect.width * scale)),
    height: Math.max(1, Math.ceil(rect.height * scale)),
  }
}

// Every vertex into a view's grid: gx, gy (grid pixels) and z (camera depth; ≤ 0 =
// behind). Reuses `out` when given.
export function projectVertices(P, cam, grid, out) {
  const V = P.length / 3
  const o = out ?? { gx: new Float32Array(V), gy: new Float32Array(V), z: new Float32Array(V) }
  const { r, t, K } = cam, { scale: s, x0, y0 } = grid
  const ax = K.fx * s, bx = (K.cx - x0 + 0.5) * s - 0.5
  const ay = K.fy * s, by = (K.cy - y0 + 0.5) * s - 0.5
  for (let i = 0; i < V; i++) {
    const X = P[3 * i], Y = P[3 * i + 1], Z = P[3 * i + 2]
    const z = r[6] * X + r[7] * Y + r[8] * Z + t[2]
    o.z[i] = z
    if (!(z > 0)) { o.gx[i] = NaN; o.gy[i] = NaN; continue }
    o.gx[i] = ax * ((r[0] * X + r[1] * Y + r[2] * Z + t[0]) / z) + bx
    o.gy[i] = ay * ((r[3] * X + r[4] * Y + r[5] * Z + t[1]) / z) + by
  }
  return o
}

// CPU depth buffer: the nearest camera depth of the mesh at each grid pixel centre,
// Infinity where nothing lies. Perspective-correct (1/z interpolates linearly in screen
// space). A triangle that covers no pixel centre is splatted at its centroid's pixel,
// so a mesh finer than the grid still occludes. Faces crossing the camera plane are
// skipped. The WebGPU depth pass (workers/gpu) must agree with this one.
export function rasterizeDepth(proj, idx, width, height, depth) {
  const W = width, H = height, F = idx.length / 3
  const buf = depth ?? new Float32Array(W * H)
  buf.fill(Infinity)
  const { gx, gy, z } = proj
  const EPS = 1e-4 // closes cracks: a centre on a shared edge belongs to both triangles
  for (let f = 0; f < F; f++) {
    const a = idx[3 * f], b = idx[3 * f + 1], c = idx[3 * f + 2]
    const za = z[a], zb = z[b], zc = z[c]
    if (!(za > 0 && zb > 0 && zc > 0)) continue
    const xa = gx[a], ya = gy[a], xb = gx[b], yb = gy[b], xc = gx[c], yc = gy[c]
    const minx = Math.min(xa, xb, xc), maxx = Math.max(xa, xb, xc)
    const miny = Math.min(ya, yb, yc), maxy = Math.max(ya, yb, yc)
    if (maxx < -0.5 || maxy < -0.5 || minx > W - 0.5 || miny > H - 0.5) continue
    const x0 = Math.max(0, Math.ceil(minx)), x1 = Math.min(W - 1, Math.floor(maxx))
    const y0 = Math.max(0, Math.ceil(miny)), y1 = Math.min(H - 1, Math.floor(maxy))
    const area2 = (xb - xa) * (yc - ya) - (xc - xa) * (yb - ya)
    if (x0 > x1 || y0 > y1 || Math.abs(area2) < 1e-12) {
      const px = Math.round((xa + xb + xc) / 3), py = Math.round((ya + yb + yc) / 3)
      if (px < 0 || py < 0 || px >= W || py >= H) continue
      const zm = 3 / (1 / za + 1 / zb + 1 / zc), i = py * W + px
      if (zm < buf[i]) buf[i] = zm
      continue
    }
    const inv = 1 / area2, iza = 1 / za, izb = 1 / zb, izc = 1 / zc
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const w0 = ((xb - x) * (yc - y) - (xc - x) * (yb - y)) * inv
        const w1 = ((xc - x) * (ya - y) - (xa - x) * (yc - y)) * inv
        const w2 = 1 - w0 - w1
        if (w0 < -EPS || w1 < -EPS || w2 < -EPS) continue
        const zp = 1 / (w0 * iza + w1 * izb + w2 * izc), i = y * W + x
        if (zp < buf[i]) buf[i] = zp
      }
    }
  }
  return buf
}

// Candidate views per face. `geom` from meshGeometry, `views` as above. Hooks:
//   validLut(vi, grid)    → Uint8Array over the grid (1 = usable: on the photo, not
//                           masked) or null when every pixel of the window is usable
//   renderDepth(vi, grid, cam, geom, idx) → Float32Array depth buffer (the WebGPU
//                           pass), or null for the CPU one
//   viewImage(vi, grid)   → { data: RGBA over the grid } | null: the photo resampled
//                           into the z-buffer grid. Given, every candidate carries
//                           its colour (mean of the face's probes) for the
//                           photo-consistency test and the gain fit (texture.js).
//   onProgress(done, total)
// → { K, count: Uint8Array(F), view: Uint16Array(F·K), score: Float32Array(F·K),
//     colour: Uint8Array(3·F·K) | null, orientation: 1 | −1 | 0, seenBy: Int32Array(nViews) }
export async function faceCandidates(geom, idx, views, opts = {}, hooks = {}) {
  const {
    bufferSide = TEXTURE_TUNING.bufferSide, maxCandidates: K = TEXTURE_TUNING.maxCandidates,
    minCos = TEXTURE_TUNING.minCos, depthTolRel = TEXTURE_TUNING.depthTolRel,
    occludedFallback: fallback = TEXTURE_TUNING.occludedFallback,
  } = opts
  const { P, centroid, normal, nFaces: F } = geom
  const count = new Uint8Array(F)
  const view = new Uint16Array(F * K).fill(NO_VIEW)
  const score = new Float32Array(F * K)
  const withColour = !!hooks.viewImage
  const colour = withColour ? new Uint8Array(3 * F * K) : null
  const rgb = [0, 0, 0]
  const seenBy = new Int32Array(views.length)
  // Per face, the best views that see it only partly (an occluder in front): its
  // candidates when no view sees it whole. Several, so the view selection can still
  // keep neighbours on one photo.
  const KF = Math.min(K, FALLBACK_K)
  const fbCount = fallback ? new Uint8Array(F) : null
  const fbView = fallback ? new Uint16Array(F * KF).fill(NO_VIEW) : null, fbScore = fallback ? new Float32Array(F * KF) : null
  const fbColour = fallback && withColour ? new Uint8Array(3 * F * KF) : null
  let proj = null, depth = null
  const PROBES = [[1 - PROBE_PULL, PROBE_PULL / 2, PROBE_PULL / 2], [PROBE_PULL / 2, 1 - PROBE_PULL, PROBE_PULL / 2],
    [PROBE_PULL / 2, PROBE_PULL / 2, 1 - PROBE_PULL], [1 / 3, 1 / 3, 1 / 3]]

  for (let vi = 0; vi < views.length; vi++) {
    const v = views[vi]
    const cam = localCamera(v, geom.origin)
    const grid = viewGrid(v, bufferSide)
    const W = grid.width, H = grid.height
    proj = projectVertices(P, cam, grid, proj)
    let zbuf = hooks.renderDepth ? await hooks.renderDepth(vi, grid, cam, geom, idx) : null
    if (!zbuf) {
      if (!depth || depth.length < W * H) depth = new Float32Array(W * H)
      zbuf = rasterizeDepth(proj, idx, W, H, depth.subarray(0, W * H))
    }
    const lut = hooks.validLut ? await hooks.validLut(vi, grid) : null
    const img = withColour ? (await hooks.viewImage(vi, grid))?.data ?? null : null
    const { gx, gy, z } = proj
    const footK = 1 / (cam.K.fx * grid.scale) // world size of a grid pixel per unit depth
    const toPx2 = 1 / (grid.scale * grid.scale)
    const weight = v.weight ?? 1
    const [Cx, Cy, Cz] = cam.C
    let seen = 0
    for (let f = 0; f < F; f++) {
      const a = idx[3 * f], b = idx[3 * f + 1], c = idx[3 * f + 2]
      const za = z[a], zb = z[b], zc = z[c]
      if (!(za > 0 && zb > 0 && zc > 0)) continue
      const xa = gx[a], ya = gy[a], xb = gx[b], yb = gy[b], xc = gx[c], yc = gy[c]
      if (!(xa >= -0.5 && xb >= -0.5 && xc >= -0.5 && ya >= -0.5 && yb >= -0.5 && yc >= -0.5)) continue
      if (!(xa <= W - 0.5 && xb <= W - 0.5 && xc <= W - 0.5 && ya <= H - 0.5 && yb <= H - 0.5 && yc <= H - 0.5)) continue
      const dx = Cx - centroid[3 * f], dy = Cy - centroid[3 * f + 1], dz = Cz - centroid[3 * f + 2]
      const cos = (normal[3 * f] * dx + normal[3 * f + 1] * dy + normal[3 * f + 2] * dz) / Math.hypot(dx, dy, dz)
      const ac = Math.abs(cos)
      if (!(ac >= minCos)) continue
      const tan = Math.min(10, Math.sqrt(1 - ac * ac) / ac)
      let ok = true, onPhoto = true, visible = 0
      let cr = 0, cg = 0, cb = 0
      for (let p = 0; p < 4 && onPhoto; p++) {
        const [la, lb, lc] = PROBES[p]
        // A 3D point Σλ·V projects to Σ(λ·z·g)/Σ(λ·z): exact under perspective.
        const zp = la * za + lb * zb + lc * zc
        const px = (la * za * xa + lb * zb * xb + lc * zc * xc) / zp
        const py = (la * za * ya + lb * zb * yb + lc * zc * yc) / zp
        const ix = Math.min(W - 1, Math.max(0, Math.round(px))), iy = Math.min(H - 1, Math.max(0, Math.round(py)))
        const i = iy * W + ix
        if (lut && !lut[i]) { ok = onPhoto = false; break }
        if (img) { cr += img[4 * i]; cg += img[4 * i + 1]; cb += img[4 * i + 2] }
        const tol = zp * depthTolRel + zp * footK * (1 + tan)
        if (zp > zbuf[i] + tol) ok = false
        else visible++
      }
      if (!onPhoto) continue
      const area = 0.5 * Math.abs((xb - xa) * (yc - ya) - (xc - xa) * (yb - ya)) * toPx2
      const s = area * weight
      if (!(s > 0)) continue
      const here = img ? (rgb[0] = cr / 4, rgb[1] = cg / 4, rgb[2] = cb / 4, rgb) : null
      if (!ok) {
        // Partly or wholly hidden: remembered only as the face's fallback, preferring
        // the view that hides least of it, then the larger.
        if (fallback && !count[f]) {
          const fs = s * (0.2 + 0.2 * visible)
          insertCandidate(fbCount, fbView, fbScore, KF, f, vi, cos < 0 ? -fs : fs, fbColour, here)
        }
        continue
      }
      insertCandidate(count, view, score, K, f, vi, cos < 0 ? -s : s, colour, here)
      seen++
    }
    seenBy[vi] = seen
    hooks.onProgress?.(vi + 1, views.length)
  }

  const orientation = settleOrientation(count, view, score, K, opts.orientation, colour)
  // Faces no view sees whole take their fallback view as the only candidate, if it
  // faces the settled side. Better than a flat colour: Poisson closes trees into
  // solid blobs, while the photos see the wall behind them through the leaves.
  let fallbackFaces = 0
  for (let f = 0; f < F && fallback; f++) {
    if (count[f] || !fbCount[f]) continue
    let n = 0
    for (let i = 0; i < fbCount[f]; i++) {
      const sc = fbScore[f * KF + i]
      if (orientation !== 0 && (orientation > 0) !== (sc > 0)) continue
      // Sorted insert, best first.
      let j = n++
      while (j > 0 && score[f * K + j - 1] < Math.abs(sc)) { moveSlot(view, score, colour, f * K + j - 1, f * K + j); j-- }
      view[f * K + j] = fbView[f * KF + i]; score[f * K + j] = Math.abs(sc)
      if (colour) for (let ch = 0; ch < 3; ch++) colour[3 * (f * K + j) + ch] = fbColour[3 * (f * KF + i) + ch]
    }
    if (n) { count[f] = n; fallbackFaces++ }
  }
  return { K, count, view, score, colour, orientation, seenBy, fallbackFaces }
}

// Candidate slot `from` → slot `to` (view, score, and colour when kept).
function moveSlot(view, score, colour, from, to) {
  view[to] = view[from]; score[to] = score[from]
  if (colour) { colour[3 * to] = colour[3 * from]; colour[3 * to + 1] = colour[3 * from + 1]; colour[3 * to + 2] = colour[3 * from + 2] }
}

// Keep the K best candidates by |score| (the sign carries the facing until the
// orientation is settled).
function insertCandidate(count, view, score, K, f, vi, s, colour = null, c = null) {
  const base = f * K, n = count[f]
  let slot = -1
  if (n < K) { slot = base + n; count[f] = n + 1 } else {
    let worst = 0
    for (let i = 1; i < K; i++) if (Math.abs(score[base + i]) < Math.abs(score[base + worst])) worst = i
    if (Math.abs(s) > Math.abs(score[base + worst])) slot = base + worst
  }
  if (slot < 0) return
  view[slot] = vi; score[slot] = s
  if (colour && c) { colour[3 * slot] = c[0]; colour[3 * slot + 1] = c[1]; colour[3 * slot + 2] = c[2] }
}

// Decide the winding from every candidate: ≥ 75 % one way is an oriented mesh (drop the
// other side's candidates, which are back faces that slipped through the depth
// tolerance); anything in between is unoriented and keeps all of them. Leaves every
// score positive and each face's candidates sorted best first. → 1 | −1 | 0
function settleOrientation(count, view, score, K, force = null, colour = null) {
  const F = count.length
  let pos = 0, neg = 0
  for (let f = 0; f < F; f++) for (let i = 0; i < count[f]; i++) (score[f * K + i] > 0 ? pos++ : neg++)
  const total = pos + neg
  const orientation = force != null ? force : !total ? 1 : pos >= 0.75 * total ? 1 : neg >= 0.75 * total ? -1 : 0
  for (let f = 0; f < F; f++) {
    const base = f * K
    let n = 0
    for (let i = 0; i < count[f]; i++) {
      const s = score[base + i]
      if (orientation !== 0 && (orientation > 0) !== (s > 0)) continue
      // Insertion sort, best first (K is small).
      const vi = view[base + i], a = Math.abs(s)
      const c0 = colour ? colour[3 * (base + i)] : 0, c1 = colour ? colour[3 * (base + i) + 1] : 0, c2 = colour ? colour[3 * (base + i) + 2] : 0
      let j = n++
      while (j > 0 && score[base + j - 1] < a) { moveSlot(view, score, colour, base + j - 1, base + j); j-- }
      view[base + j] = vi; score[base + j] = a
      if (colour) { colour[3 * (base + j)] = c0; colour[3 * (base + j) + 1] = c1; colour[3 * (base + j) + 2] = c2 }
    }
    for (let i = n; i < K; i++) { view[base + i] = NO_VIEW; score[base + i] = 0 }
    count[f] = n
  }
  return orientation
}
