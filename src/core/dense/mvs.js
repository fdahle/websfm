// Dense reconstruction (Multi-View Stereo) — pure compute, no Vue/Pinia/OPFS/DOM.
// Mirrors core/sfm/sfm.js: plain data in, plain data out, side effects via hooks. The
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

import { computeDepthMap } from '../sfm/reconstruction.js'
import { planeCostRef, aggregateValidCosts } from './planeCost.js'
import { DENSE_TUNING } from '../tuning.js'
import { DEPTHMAP_DEFAULTS } from '../defaults.user.js'
import {
  cameraCenter, projectWithDepth, triangulationAngle, scaleK, rgbaToGray, toScaledPx,
} from '../sfm/geometry.js'

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

// Back-project a working pixel (u,v,depth) of map `m` to a world point.
//   X_cam = ((u−cx)/fx·d, (v−cy)/fy·d, d);  X_world = Rᵀ(X_cam − t)
// Shared by fuseDepthMaps and filterDepthMapsGeometric — both need the exact same
// inverse of `project`, and a divergence between them would silently misreport
// cross-view agreement.
function unprojectPixel(m, u, v, depth) {
  const xc = (u - m.K.cx) / m.K.fx * depth
  const yc = (v - m.K.cy) / m.K.fy * depth
  const zc = depth
  const ax = xc - m.t[0], ay = yc - m.t[1], az = zc - m.t[2]
  return {
    x: m.R[0][0]*ax + m.R[1][0]*ay + m.R[2][0]*az,
    y: m.R[0][1]*ax + m.R[1][1]*ay + m.R[2][1]*az,
    z: m.R[0][2]*ax + m.R[1][2]*ay + m.R[2][2]*az,
  }
}

// ── Stage A helpers ──────────────────────────────────────────────────────────

// Pick the best source views for a reference image: candidates that share the
// most sparse 3D points with the reference at a healthy parallax angle. Returns
// up to `maxSources` source uuids, best first.
//   cameras: Map<uuid, { R, t, K }>   points: [{ x, y, z, views: [[uuid,kpIdx],…] }]
export function selectSourceViews(cameras, points, refUuid, opts = {}) {
  // maxSources is user-facing (DEPTHMAP_DEFAULTS); the angle window is internal (tuning.js).
  const { maxSources = 6, minAngleDeg = DENSE_TUNING.minAngleDeg, maxAngleDeg = DENSE_TUNING.maxAngleDeg } = opts
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
  return { seedDepth: seed, depthMin: Math.max(1e-4, lo - pad), depthMax: hi + pad, seeded: depths.length }
}

// ── Coarse-to-fine pyramid helpers (Step 2 — fixes freckle) ──────────────────
// PatchMatch propagates ~1px per red-black sweep, so at high working resolution
// information from the sparse seed can't reach most pixels and each pixel is
// stuck on its random init (salt-and-pepper depth). Running the SAME kernel on a
// gray pyramid — coarsest first, then upsampling each level's depth as the next
// level's full-coverage seed — lets a match found at low resolution propagate
// globally for free. Depth is view-space (invariant under image rescale), so no
// depth value scaling is needed between levels — only the intrinsics scale.

// 2× box-downsample a Uint8 grayscale plane. Floor dims (≥1). Returns { gray,w,h }.
function downsampleGray2x(gray, w, h) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1)
  const out = new Uint8Array(nw * nh)
  for (let v = 0; v < nh; v++) {
    const v0 = 2 * v, v1 = Math.min(v0 + 1, h - 1)
    for (let u = 0; u < nw; u++) {
      const u0 = 2 * u, u1 = Math.min(u0 + 1, w - 1)
      out[v * nw + u] = (gray[v0 * w + u0] + gray[v0 * w + u1]
                       + gray[v1 * w + u0] + gray[v1 * w + u1] + 2) >> 2
    }
  }
  return { gray: out, w: nw, h: nh }
}

// 2× max-pool a 0/1 exclusion mask: a downsampled texel is masked if ANY of its
// (up to) four contributors is masked (so a coarse warp can't sample near a
// frame/fiducial edge that the fine mask would have rejected).
function downsampleMaskMax2x(mask, w, h) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1)
  const out = new Uint8Array(nw * nh)
  for (let v = 0; v < nh; v++) {
    const v0 = 2 * v, v1 = Math.min(v0 + 1, h - 1)
    for (let u = 0; u < nw; u++) {
      const u0 = 2 * u, u1 = Math.min(u0 + 1, w - 1)
      out[v * nw + u] = (mask[v0 * w + u0] || mask[v0 * w + u1]
                       || mask[v1 * w + u0] || mask[v1 * w + u1]) ? 1 : 0
    }
  }
  return out
}

// Nearest-neighbour upsample a depth plane cw×ch → fw×fh (edge-preserving: keeps
// depth discontinuities crisp for the next level's refinement to sharpen).
function upsampleDepthNearest(depth, cw, ch, fw, fh) {
  const out = new Float32Array(fw * fh)
  for (let v = 0; v < fh; v++) {
    // Centre-aligned nearest (geometry.js toScaledPx): fine pixel centre v + ½ lands at
    // (v + ½)·ch/fh on the coarse grid. Identical to v/2 for an exact 2× level.
    const sv = Math.min(ch - 1, ((v + 0.5) * ch / fh) | 0)
    for (let u = 0; u < fw; u++) {
      const su = Math.min(cw - 1, ((u + 0.5) * cw / fw) | 0)
      out[v * fw + u] = depth[sv * cw + su]
    }
  }
  return out
}

// Scale intrinsics with independent horizontal/vertical factors (floor-halving can
// make sx ≠ sy by a fraction of a percent; scaleK's single factor would skew fy/cy).
// The principal point moves by the centre-aligned rule (geometry.js toScaledPx).
function scaleKxy(K, sx, sy) {
  return { fx: K.fx * sx, fy: K.fy * sy, cx: toScaledPx(K.cx, sx), cy: toScaledPx(K.cy, sy) }
}

// Number of pyramid levels so the coarsest longest side is ≈ `coarseLong` (default
// 600 — low enough that even a Medium-quality working image gets a coarse level to
// carry global propagation). 1 level (no pyramid) when the working image is already
// at/under that.
function pyramidLevelCount(w, h, coarseLong = DENSE_TUNING.coarseLong) {
  const long = Math.max(w, h)
  if (long <= coarseLong) return 1
  return Math.floor(Math.log2(long / coarseLong)) + 1
}

// Run PatchMatch for one reference image given already-rasterised pixels. `ref`
// and each `sources[i]` carry { gray, width/w, height/h }; cameras carry the
// scaled working K.
//   ref:     { gray, width, height, K, cam:{R,t,K?} }
//   sources: [{ gray, w, h, K, cam }]   (cam = full { R, t, K } pose)
// `computeDepthMapFn` is the per-pixel depth-map kernel (default: the WASM
// implementation). The worker injects a WebGPU backend here when available — both
// share the (refGray, refW, refH, refK, sources, opts) → { depth, cost, w, h }
// contract, so this orchestration is backend-agnostic.
export async function depthMapForImage(ref, sources, points, settings = {}, computeDepthMapFn = computeDepthMap, hooks = {}) {
  // window/iterations/bestK are user-facing (DEPTHMAP_DEFAULTS); coarseLong is internal (tuning.js).
  const { window = 3, iterations = 3, bestK = 3, coarseLong = DENSE_TUNING.coarseLong } = settings
  const refCamScaled = { R: ref.cam.R, t: ref.cam.t, K: ref.K }
  // Depth range is view-space (resolution-invariant): derive it once from the
  // working-res projection (most sparse points visible → tightest percentiles).
  const { depthMin, depthMax, seeded } = seedDepthFromSparse(refCamScaled, points, ref.width, ref.height)
  if (!(depthMax > depthMin)) return null // no sparse support → can't bound depth

  // Relative poses are resolution-independent (R,t only) — shared across levels.
  const src = sources.map((s) => {
    const { R, t } = relativePose(ref.cam, s.cam)
    return { gray: s.gray, w: s.w, h: s.h, K: s.K, R, t, mask: s.mask ?? null }
  })

  // Build the gray pyramid, coarsest → finest. The finest level IS the working
  // resolution, so it reuses ref/src directly (no copy); coarser levels are 2×
  // box-downsampled (masks max-pooled). Each level carries its own scaled K.
  const nLevels = pyramidLevelCount(ref.width, ref.height, coarseLong)
  const finest = {
    gray: ref.gray, w: ref.width, h: ref.height, K: ref.K,
    srcs: src.map((s) => ({ gray: s.gray, w: s.w, h: s.h, K: s.K, R: s.R, t: s.t, mask: s.mask })),
  }
  const levels = [finest]
  for (let l = 1; l < nLevels; l++) {
    const cur = levels[0]
    const dr = downsampleGray2x(cur.gray, cur.w, cur.h)
    const level = {
      gray: dr.gray, w: dr.w, h: dr.h,
      K: scaleKxy(cur.K, dr.w / cur.w, dr.h / cur.h),
      srcs: cur.srcs.map((s) => {
        const ds = downsampleGray2x(s.gray, s.w, s.h)
        return {
          gray: ds.gray, w: ds.w, h: ds.h,
          K: scaleKxy(s.K, ds.w / s.w, ds.h / s.h), R: s.R, t: s.t,
          mask: s.mask ? downsampleMaskMax2x(s.mask, s.w, s.h) : null,
        }
      }),
    }
    levels.unshift(level)
  }

  // Coarse-to-fine sweep: seed the coarsest from the sparse cloud, then upsample
  // each level's depth as the next (finer) level's full-coverage seed. Coarser
  // levels get more iterations (cheap, and they carry the global propagation).
  if (levels.length > 1) {
    const plan = levels.map((L, li) => `${L.w}×${L.h}×${iterations + (levels.length - 1 - li)}it`).join(' → ')
    hooks.onLog?.(`coarse-to-fine ${levels.length} levels (${sources.length} src) — ${plan}`, 'debug', 'Dense')
  }
  const baseSeed = (ref.width * 73856093) ^ (ref.height * 19349663)
  // Per-level progress weights (this image is 0..1): a level's cost ≈ its pixels ×
  // its iteration count, so the finest level dominates — the fraction advances after
  // each level resolves (per-sweep would need a callback from the Rust kernel).
  const levelWeight = levels.map((L, li) => L.w * L.h * (iterations + (levels.length - 1 - li)))
  const totalWeight = levelWeight.reduce((a, b) => a + b, 0) || 1
  let doneWeight = 0
  let dm = null, prevDepth = null, prevW = 0, prevH = 0
  for (let li = 0; li < levels.length; li++) {
    const L = levels[li]
    let seedDepth
    if (li === 0) {
      const camL = { R: ref.cam.R, t: ref.cam.t, K: L.K }
      seedDepth = seedDepthFromSparse(camL, points, L.w, L.h).seedDepth
    } else {
      seedDepth = upsampleDepthNearest(prevDepth, prevW, prevH, L.w, L.h)
    }
    const levelIters = iterations + (levels.length - 1 - li) // coarsest gets the most
    dm = await computeDepthMapFn(L.gray, L.w, L.h, L.K, L.srcs, {
      depthMin, depthMax, seedDepth, window, iterations: levelIters, bestK,
      seed: (baseSeed ^ (li * 0x9e3779b1)) >>> 0,
    })
    if (!dm) return null
    prevDepth = dm.depth; prevW = L.w; prevH = L.h
    doneWeight += levelWeight[li]
    hooks.onProgress?.(doneWeight / totalWeight)
  }

  // GPU↔CPU validation (WebGPU port). Two checks against the first source:
  //   1. cost consistency — recompute the plane cost on the CPU reference at the
  //      GPU's own final (depth, normal); should match to ~e-3 (f32 + hardware
  //      sampler precision). A larger RMS signals a kernel transcription bug.
  //   2. convergence — the median final cost; PatchMatch should pull this well
  //      below the ~1.0 of random/unmatched (the signal the sweeps actually work).
  if (hooks.validate && src.length) {
    const radius = Math.min(5, Math.max(1, window)) // match mvs.rs / wgsl radius cap
    const refC = { gray: ref.gray, w: ref.width, h: ref.height, fx: ref.K.fx, fy: ref.K.fy, cx: ref.K.cx, cy: ref.K.cy }
    const srcCs = src.map((s) => ({ gray: s.gray, w: s.w, h: s.h, fx: s.K.fx, fy: s.K.fy, cx: s.K.cx, cy: s.K.cy, R: s.R, t: s.t, mask: s.mask }))
    const k = Math.min(Math.max(bestK, 1), srcCs.length) // reported best-K (upper bound)
    // Best-K aggregation matching the GPU's aggCost: exclude no-measurement
    // sources (INVALID sentinel) instead of averaging their max cost in.
    const aggRef = (u, v, depth, n) => {
      if (depth <= 0) return 2
      const cs = srcCs.map((sc) => planeCostRef(refC, sc, u, v, depth, n, radius))
      return aggregateValidCosts(cs, bestK)
    }
    const stride = Math.max(1, Math.floor(dm.depth.length / 4000))
    const costs = []
    let sse = 0, max = 0, cnt = 0
    for (let i = 0; i < dm.depth.length; i += stride) {
      const u = i % ref.width, v = (i / ref.width) | 0
      const n = dm.normals
        ? [dm.normals[i * 3], dm.normals[i * 3 + 1], dm.normals[i * 3 + 2]]
        : [0, 0, -1]
      const cpu = aggRef(u, v, dm.depth[i], n)
      const diff = Math.abs(cpu - dm.cost[i])
      sse += diff * diff
      if (diff > max) max = diff
      cnt++
      costs.push(dm.cost[i])
    }
    const rms = cnt ? Math.sqrt(sse / cnt) : 0
    costs.sort((a, b) => a - b)
    const medCost = costs.length ? costs[costs.length >> 1] : 0
    hooks.onLog?.(`GPU validate: cost consistency RMS ${rms.toExponential(2)} (max ${max.toExponential(2)}) `
      + `over ${cnt} px; median final cost ${medCost.toFixed(3)} (${srcCs.length} src, best-${k})`,
      rms < 5e-3 ? 'success' : 'warn', 'Dense')
  }

  // Carry the seeding diagnostics through so the caller can log them.
  return { ...dm, depthMin, depthMax, seeded }
}

// Post-process one depth plane to suppress the noise the per-image photometric
// PatchMatch leaves behind (the cross-view geometric check only happens later, at
// fusion). Two effects in a single (2·radius+1)² pass over valid pixels:
//   • speckle / flying-pixel removal — a valid pixel whose depth disagrees with
//     its local median by more than `relTol` (relative), or that sits in a region
//     with fewer than `minValidNeighbors` valid depths, is dropped (set to 0).
//   • smoothing — surviving pixels are set to the local median (edge-preserving),
//     unless `smooth` is false.
// Pure: returns { depth: Float32Array, removed, smoothed }; input is not mutated.
export function filterDepthMap(depth, w, h, opts = {}) {
  const { radius = 1, relTol = 0.1, minValidNeighbors = 4, smooth = true } = opts
  const out = new Float32Array(depth.length)
  const win = []
  let removed = 0, smoothed = 0
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const idx = v * w + u
      const d = depth[idx]
      if (!(d > 0)) continue // already a hole
      win.length = 0
      for (let dv = -radius; dv <= radius; dv++) {
        const vv = v + dv
        if (vv < 0 || vv >= h) continue
        for (let du = -radius; du <= radius; du++) {
          const uu = u + du
          if (uu < 0 || uu >= w) continue
          const nd = depth[vv * w + uu]
          if (nd > 0) win.push(nd)
        }
      }
      if (win.length < minValidNeighbors) { removed++; continue } // isolated → drop
      win.sort((a, b) => a - b)
      const med = win[win.length >> 1]
      if (Math.abs(d - med) > relTol * med) { removed++; continue }   // speckle → drop
      out[idx] = smooth ? med : d
      if (smooth && med !== d) smoothed++
    }
  }
  return { depth: out, removed, smoothed }
}

// ── Cross-view geometric consistency (COLMAP's `filter` pass) ────────────────────
// Stage A is photometric only, and `filterDepthMap` above is a *neighbourhood* test —
// neither can see that a pixel's depth disagrees with what other views independently
// believe. That blind spot is what leaves sky and vegetation freckled:
//
//   • Vegetation is strongly textured, so its ZNCC is genuinely high. No cost gate can
//     ever reject a bush — cost is not measuring the thing that's wrong with it.
//   • Gradient sky / cloud correlates well at *any* depth: high NCC, arbitrary depth.
//
// Both fail only on cross-view depth disagreement. This runs COLMAP's forward–backward
// reprojection test per pixel (patch_match.cc `filter=true`):
//
//   P  = unproject(ref, u, v, d)          the reference's claim
//   p  = project(src, P)                  where the source should see it
//   P' = unproject(src, p, srcDepth(p))   what the source *actually* has there
//   e  = ‖project(ref, P') − (u,v)‖       forward–backward reprojection error, px
//
// A view counts as consistent when e ≤ maxGeomCost. Requiring `minConsistent` such
// views kills anything only one view believes in. Note this samples the source's depth
// at ONE pixel, which is what makes it strict: fuseDepthMaps' own check searches a
// (2·consistencyPx+1)² window and accepts if *any* pixel there is within tolerance, so
// a noisy depth cloud (a bush) passes it by chance. That check stays as a cheap second
// line of defence; this is the one that discriminates.
//
// Also applies an absolute per-pixel photometric floor (`minNcc`, COLMAP's
// filter_min_ncc): distinct from fusion's *adaptive* p70 maxCost, which by construction
// keeps 70% of pixels no matter how bad the whole distribution is.
//
// Runs across all maps at once (needs every view's depth), and zeroes rejected pixels
// in the maps themselves — so the persisted depth maps, and therefore the orthophoto
// that reuses them as a z-buffer, get the benefit too, not just the fused cloud.
//
// IMPORTANT: evidence is read from the *unfiltered* planes. Rejections are collected
// into per-map masks and applied only after every map has been tested — filtering map i
// in place would make map i+1 judge itself against already-thinned evidence, cascading
// rejections in map order (an order-dependent, irreproducible result).
//
// Cost is O(maps² · px) worst case, the same shape as fusion's loop, with an early
// break once `minConsistent` views agree. Pure: maps are mutated only via the returned
// planes; no I/O.
export function filterDepthMapsGeometric(maps, opts = {}, onLog = () => {}, hooks = {}) {
  const {
    minNcc = DEPTHMAP_DEFAULTS.minNcc,
    maxGeomCost = DEPTHMAP_DEFAULTS.maxGeomCost,
    minConsistent = DEPTHMAP_DEFAULTS.minConsistent,
  } = opts
  const { onProgress } = hooks

  // A lone map has no cross-view evidence — the test is meaningless, not "everything
  // fails". Apply the NCC floor only.
  const nMaps = maps.length
  const maxCostGate = 1 - minNcc // ZNCC ncc ≥ minNcc  ⇔  cost ≤ 1 − minNcc

  const masks = maps.map((m) => new Uint8Array(m.width * m.height)) // 1 = drop
  let considered = 0, lowNcc = 0, inconsistent = 0, kept = 0

  for (let mi = 0; mi < nMaps; mi++) {
    const m = maps[mi]
    const { width: w, height: h, depth, cost } = m
    const mask = masks[mi]
    onProgress?.(mi, nMaps, m.name ?? m.uuid?.slice(0, 8) ?? '')
    let mapLowNcc = 0, mapInconsistent = 0
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const idx = v * w + u
        const d = depth[idx]
        if (!(d > 0)) continue // already a hole
        considered++
        if (cost[idx] > maxCostGate) { mask[idx] = 1; lowNcc++; mapLowNcc++; continue }
        if (nMaps < 2 || minConsistent <= 0) { kept++; continue }

        const P = unprojectPixel(m, u, v, d)
        let agree = 0
        for (let ci = 0; ci < nMaps && agree < minConsistent; ci++) {
          if (ci === mi) continue
          const c = maps[ci]
          const p = project(c, P.x, P.y, P.z)
          if (!p) continue // behind the source camera
          const cu = Math.round(p.u), cv = Math.round(p.v)
          if (cu < 0 || cu >= c.width || cv < 0 || cv >= c.height) continue
          const od = c.depth[cv * c.width + cu]
          if (!(od > 0)) continue // source has no depth here — no evidence either way
          // The source's own surface point at that pixel. If the source is looking at
          // something else entirely (occluder, or noise), the round trip lands far from
          // (u,v) and this view simply doesn't vouch for the pixel.
          const P2 = unprojectPixel(c, cu, cv, od)
          const q = project(m, P2.x, P2.y, P2.z)
          if (!q) continue
          if (Math.hypot(q.u - u, q.v - v) <= maxGeomCost) agree++
        }
        if (agree < minConsistent) { mask[idx] = 1; inconsistent++; mapInconsistent++; continue }
        kept++
      }
    }
    m.filterStats = {
      considered: (() => { let n = 0; for (const d of depth) if (d > 0) n++; return n })(),
      lowNcc: mapLowNcc,
      inconsistent: mapInconsistent,
    }
    m.filterStats.kept = m.filterStats.considered - mapLowNcc - mapInconsistent
    m.filterStats.keptPct = m.filterStats.considered
      ? 100 * m.filterStats.kept / m.filterStats.considered : 0
    onLog(`Depth filter: ${m.name ?? m.uuid?.slice(0, 8) ?? '?'} — dropped ${mapLowNcc} low-NCC, `
      + `${mapInconsistent} geometrically inconsistent px`, 'debug', 'Dense')
  }

  // Apply now that every map has been judged against the original evidence.
  for (let mi = 0; mi < nMaps; mi++) {
    const { depth, width, height } = maps[mi]
    const mask = masks[mi]
    for (let k = 0; k < width * height; k++) if (mask[k]) depth[k] = 0
  }

  const pct = (n) => (100 * n / Math.max(1, considered)).toFixed(1)
  if (nMaps < 2) {
    onLog(`Depth filter: only ${nMaps} map — cross-view check skipped, NCC floor only`, 'warn', 'Dense')
  }
  onLog(`Depth filter: ${considered} px with depth → ${kept} kept (${pct(kept)}%); dropped `
    + `${lowNcc} NCC<${minNcc} (${pct(lowNcc)}%), `
    + `${inconsistent} <${minConsistent} consistent views @${maxGeomCost}px (${pct(inconsistent)}%)`,
    'info', 'Dense')

  return { considered, kept, lowNcc, inconsistent }
}

// ── Step 3: quality presets + derived params ─────────────────────────────────
// Metashape-style *relative* quality presets replace an absolute pixel count as
// the primary control. Each preset is a fraction of the largest native image
// dimension; the derived working longest-side is floored at 200px (below that a
// depth map is useless). `ultra` = native resolution (no downscale).
const QUALITY_FRACTION = { low: 1 / 8, medium: 1 / 4, high: 1 / 2, ultra: 1 }

// Resolve a quality preset + the largest native image dimension → working maxDim.
export function qualityToMaxDim(quality, nativeLongSide) {
  const f = QUALITY_FRACTION[quality] ?? QUALITY_FRACTION.medium
  return Math.max(200, Math.round((nativeLongSide || 0) * f))
}

// Per-image best-K from the number of available source views: average roughly the
// better half, clamped to [1, 4] (occlusion-robust without over-smoothing).
export function autoBestK(nSources) {
  return Math.min(4, Math.max(1, Math.ceil(nSources / 2)))
}

// Auto fusion cost threshold + median: the `percentile` (default p70) and median of
// the valid-pixel costs across all depth maps, clamped to [lo, hi]. After Step 1 the
// per-pixel cost histogram is meaningful (no-measurement sources no longer floor
// it), so the gate can adapt to the data instead of a fixed 0.6. The upper clamp
// is deliberately tight (0.45): a genuine ZNCC match is ≥ ~0.55 (cost ≤ 0.45), so
// a p70 above that means the distribution itself is weak (bad intrinsics / window
// / working resolution) — keeping such points would only fuse junk.
//
// Costs are **stride-subsampled** into a single Float32Array and sorted once, so
// the whole set can pool tens of millions of pixels without a per-pixel JS-boxed
// array (the double-sort memory hog). `n` is the true valid-pixel count; `median`
// feeds the run summary (replaces the old second full pool + sort in medianOf).
// Returns { maxCost, n, raw, median } (raw = unclamped p70, so callers can flag a
// weak signal).
function* fusionCostSteps(maps, {
  percentile = 0.7, lo = 0.3, hi = 0.45, maxSamples = DENSE_TUNING.fuseCostMaxSamples,
} = {}) {
  // One cheap scan for the true valid count → a stride that caps the sample budget.
  let totalValid = 0
  for (let mi = 0; mi < maps.length; mi++) {
    const m = yield mi
    const { depth } = m
    for (let i = 0; i < depth.length; i++) if (depth[i] > 0) totalValid++
  }
  if (!totalValid) return { maxCost: hi, n: 0, raw: hi, median: 0 }
  const stride = Math.max(1, Math.floor(totalValid / maxSamples))
  const samples = new Float32Array(Math.ceil(totalValid / stride) + 1)
  let s = 0, vi = 0
  for (let mi = 0; mi < maps.length; mi++) {
    const m = yield mi
    const { depth, cost } = m
    for (let i = 0; i < depth.length; i++) {
      if (depth[i] > 0) {
        if (vi % stride === 0 && s < samples.length) samples[s++] = cost[i]
        vi++
      }
    }
  }
  const arr = samples.subarray(0, s)
  arr.sort() // TypedArray.sort is numeric ascending
  const at = (q) => arr[Math.min(s - 1, Math.max(0, Math.round(q * (s - 1))))]
  const q = at(percentile)
  return { maxCost: Math.min(hi, Math.max(lo, q)), n: totalValid, raw: q, median: at(0.5) }
}

function runWithMaps(iterator, maps) {
  let step = iterator.next()
  while (!step.done) step = iterator.next(maps[step.value])
  return step.value
}
export function autoFusionMaxCost(maps, options = {}) {
  return runWithMaps(fusionCostSteps(maps, options), maps)
}

// ── Stage B: fusion ──────────────────────────────────────────────────────────

// Fuse per-image depth maps into a dense point cloud. Each map carries its
// reference pose + working K, the depth/cost planes, and an RGB buffer (colours
// at working resolution). A pixel's 3D point is kept only if it reprojects into
// at least `minViews` OTHER maps within `consistencyPx` and at a consistent depth
// (geometric consistency — the cross-view check the per-image PatchMatch omits).
//   maps: [{ uuid, width, height, K, R, t, depth:Float32Array, cost:Float32Array,
//            rgb:Uint8Array(w*h*3) }]
// Returns [{ x, y, z, color:[r,g,b] }]. `onLog(msg, level, category)` (optional)
// receives a breakdown of why pixels were kept or culled.
/**
 * Spatial (voxel) merge of a fused point set: collapse points that fall in the same
 * world-space cell into a single averaged point (position + colour). Order-independent,
 * so it's the principled way to kill the per-source-pixel "duplicate shells" a
 * multi-view fusion emits — the same surface point reconstructed from several views
 * lands in one cell and becomes one point. `cellSize` is in world units (≈ one
 * ground-sample-distance ⇒ one point per ground pixel-footprint: dedupes overlap while
 * preserving resolution). `cellSize <= 0` disables the merge (returns the input).
 */
export function mergePointsSpatial(points, cellSize) {
  if (!(cellSize > 0) || points.length === 0) return points
  const inv = 1 / cellSize
  const cells = new Map()
  for (const p of points) {
    const key = `${Math.floor(p.x * inv)},${Math.floor(p.y * inv)},${Math.floor(p.z * inv)}`
    let acc = cells.get(key)
    if (!acc) { acc = { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, nx: 0, ny: 0, nz: 0, n: 0 }; cells.set(key, acc) }
    acc.x += p.x; acc.y += p.y; acc.z += p.z
    acc.r += p.color[0]; acc.g += p.color[1]; acc.b += p.color[2]
    if (p.normal) { acc.nx += p.normal[0]; acc.ny += p.normal[1]; acc.nz += p.normal[2] }
    acc.n++
  }
  const out = []
  for (const a of cells.values()) {
    const k = 1 / a.n
    const o = {
      x: a.x * k, y: a.y * k, z: a.z * k,
      color: [Math.round(a.r * k), Math.round(a.g * k), Math.round(a.b * k)],
    }
    // Renormalized averaged normal (matches finalizeNormals); (0,0,1) fallback.
    const mag = Math.hypot(a.nx, a.ny, a.nz)
    o.normal = mag > 1e-9 ? [a.nx / mag, a.ny / mag, a.nz / mag] : [0, 0, 1]
    out.push(o)
  }
  return out
}

// Auto voxel size for the spatial merge: the median ground-sample-distance across
// maps (median valid depth / fx = the world-space span of one pixel). One cell ≈ one
// pixel footprint, so cross-view overlap dedupes without discarding real resolution.
function* mergeCellSteps(maps) {
  const gsds = []
  for (let mi = 0; mi < maps.length; mi++) {
    const m = yield mi
    const { depth } = m
    const ds = []
    for (let i = 0; i < depth.length; i++) if (depth[i] > 0) ds.push(depth[i])
    if (!ds.length) continue
    ds.sort((a, b) => a - b)
    const fx = m.K?.fx || 0
    if (fx > 0) gsds.push(ds[ds.length >> 1] / fx)
  }
  if (!gsds.length) return 0
  gsds.sort((a, b) => a - b)
  return gsds[gsds.length >> 1]
}

// Streaming voxel accumulator: the fusion loop feeds kept pixels **one at a time**
// into this, so the raw per-source-pixel point list — the fusion OOM (25–30 M boxed
// {x,y,z,color} objects ≈ 3 GB on a 50-image set) — never materializes. It's the
// spatial merge of `mergePointsSpatial` done incrementally: cells are anchored at
// the world origin (`floor(coord/cell)`), identical to that function, so the merged
// cells/averages match exactly. Storage is a `Map<numeric key → slot idx>` plus
// parallel growable typed-array sums (~44 B per *merged cell* ≈ one ground pixel,
// vs ~200 B per raw point). Cell keys are packed numerically — `(dix·ny+diy)·nz+diz`
// — from per-axis offsets/counts derived from `bounds`; the caller keeps the product
// < 2^53 (float64-exact) via clampCellForBounds. `bounds` may be a coarse estimate:
// out-of-range offsets clamp into the border cell (a rare, negligible quality nick,
// never a key collision).
export function createVoxelAccumulator(cellSize, bounds) {
  const inv = 1 / cellSize
  const ix0 = Math.floor(bounds.minX * inv), iy0 = Math.floor(bounds.minY * inv), iz0 = Math.floor(bounds.minZ * inv)
  const ix1 = Math.floor(bounds.maxX * inv), iy1 = Math.floor(bounds.maxY * inv), iz1 = Math.floor(bounds.maxZ * inv)
  // Pad one cell each side so a point just past a coarse-estimated bound still packs
  // to a unique in-range key instead of aliasing onto the opposite face.
  const bx = ix0 - 1, by = iy0 - 1, bz = iz0 - 1
  const nx = (ix1 - ix0) + 3, ny = (iy1 - iy0) + 3, nz = (iz1 - iz0) + 3
  const slot = new Map()
  let cap = 1024, n = 0
  let sx = new Float64Array(cap), sy = new Float64Array(cap), sz = new Float64Array(cap)
  let sr = new Float64Array(cap), sg = new Float64Array(cap), sb = new Float64Array(cap)
  // World-space normal sums (Phase: Poisson meshing). Averaging unit normals then
  // renormalizing is a valid orientation estimate; the k coincident shell points a
  // surface produces all carry ~the same normal, so the sum stays well-conditioned.
  let snx = new Float64Array(cap), sny = new Float64Array(cap), snz = new Float64Array(cap)
  let cnt = new Uint32Array(cap)
  let removed = 0 // cells zeroed by filterIsolated (WS4); excluded from count + finalize
  const grow = () => {
    cap *= 2
    const g = (a, T) => { const b = new T(cap); b.set(a); return b } // tail zero-filled
    sx = g(sx, Float64Array); sy = g(sy, Float64Array); sz = g(sz, Float64Array)
    sr = g(sr, Float64Array); sg = g(sg, Float64Array); sb = g(sb, Float64Array)
    snx = g(snx, Float64Array); sny = g(sny, Float64Array); snz = g(snz, Float64Array)
    cnt = g(cnt, Uint32Array)
  }
  const clamp = (i, hi) => (i < 0 ? 0 : (i >= hi ? hi - 1 : i))
  return {
    // Normals (nx,ny,nz) are optional (world-space, unit) — omitted callers still
    // get the exact same cells/averages for the 6-float wire format.
    add(x, y, z, r, g, b, nx_ = 0, ny_ = 0, nz_ = 0) {
      const dix = clamp(Math.floor(x * inv) - bx, nx)
      const diy = clamp(Math.floor(y * inv) - by, ny)
      const diz = clamp(Math.floor(z * inv) - bz, nz)
      const key = (dix * ny + diy) * nz + diz
      let s = slot.get(key)
      if (s === undefined) { if (n === cap) grow(); s = n++; slot.set(key, s) } // fresh slot is zeroed
      sx[s] += x; sy[s] += y; sz[s] += z
      sr[s] += r; sg[s] += g; sb[s] += b
      snx[s] += nx_; sny[s] += ny_; snz[s] += nz_
      cnt[s]++
    },
    get count() { return n - removed },
    // Post-fusion isolated-cell removal (WS4): a real surface cell has occupied
    // neighbours; a lone low-support cell is fusion noise (a sky/vegetation flyer that
    // slipped the consistency gate). Only *low-support* cells (cnt ≤ maxSupport) are
    // tested — a ≥3-pixel cell is never a floater — so this stays O(noise tail), not
    // O(all cells). For each tested cell, probe the 26 (radius 1) neighbour keys
    // arithmetically; if fewer than `minNeighbors` are occupied, zero its count so the
    // finalizers skip it. Cell indices are recovered from the packed key. Returns the
    // number removed.
    filterIsolated({ radius = 1, minNeighbors = 2, maxSupport = 2 } = {}) {
      let dropped = 0
      for (const [key, s] of slot) {
        if (cnt[s] === 0 || cnt[s] > maxSupport) continue
        const diz = key % nz
        const diy = Math.floor(key / nz) % ny
        const dix = Math.floor(key / (nz * ny))
        let neigh = 0
        for (let ddx = -radius; ddx <= radius && neigh < minNeighbors; ddx++) {
          const nix = dix + ddx; if (nix < 0 || nix >= nx) continue
          for (let ddy = -radius; ddy <= radius && neigh < minNeighbors; ddy++) {
            const niy = diy + ddy; if (niy < 0 || niy >= ny) continue
            for (let ddz = -radius; ddz <= radius; ddz++) {
              if (ddx === 0 && ddy === 0 && ddz === 0) continue
              const niz = diz + ddz; if (niz < 0 || niz >= nz) continue
              const ns = slot.get((nix * ny + niy) * nz + niz)
              if (ns !== undefined && cnt[ns] > 0) { neigh++; if (neigh >= minNeighbors) break }
            }
          }
        }
        if (neigh < minNeighbors) { cnt[s] = 0; dropped++ }
      }
      removed += dropped
      return dropped
    },
    // Finalize straight into the wire format the densify op returns: a flat
    // Float32Array of [x,y,z,r,g,b] per merged cell (no intermediate objects). Cells
    // zeroed by filterIsolated (cnt === 0) are skipped and the output is compacted.
    finalizeFlat() {
      const out = new Float32Array((n - removed) * 6)
      let o = 0
      for (let s = 0; s < n; s++) {
        if (cnt[s] === 0) continue
        const k = 1 / cnt[s]
        out[o] = sx[s] * k; out[o + 1] = sy[s] * k; out[o + 2] = sz[s] * k
        out[o + 3] = Math.round(sr[s] * k); out[o + 4] = Math.round(sg[s] * k); out[o + 5] = Math.round(sb[s] * k)
        o += 6
      }
      return out
    },
    // Averaged, renormalized world-space normals as a flat Float32Array(3N) — the
    // Poisson solver's oriented-normal input. Cells whose contributors cancelled to
    // a near-zero vector (disagreeing views) fall back to (0,0,1); count returned.
    // Iterates in the SAME order as finalizeFlat (skipping cnt === 0), so the two
    // arrays stay row-aligned.
    finalizeNormals() {
      const out = new Float32Array((n - removed) * 3)
      let degenerate = 0, o = 0
      for (let s = 0; s < n; s++) {
        if (cnt[s] === 0) continue
        const ax = snx[s], ay = sny[s], az = snz[s]
        const mag = Math.hypot(ax, ay, az)
        if (mag > 1e-9) { out[o] = ax / mag; out[o + 1] = ay / mag; out[o + 2] = az / mag }
        else { out[o] = 0; out[o + 1] = 0; out[o + 2] = 1; degenerate++ }
        o += 3
      }
      return { nrm: out, degenerate }
    },
  }
}

// Packed-key cell count for `bounds` at `cell` (matches createVoxelAccumulator's
// nx·ny·nz). Used to keep the key float64-exact.
function boundsCellProduct(bounds, cell) {
  const inv = 1 / cell
  const nx = Math.floor(bounds.maxX * inv) - Math.floor(bounds.minX * inv) + 3
  const ny = Math.floor(bounds.maxY * inv) - Math.floor(bounds.minY * inv) + 3
  const nz = Math.floor(bounds.maxZ * inv) - Math.floor(bounds.minZ * inv) + 3
  return nx * ny * nz
}

// Clamp a requested cell size UP until the packed cell key stays exact in float64
// (product < fuseMaxCells). A degenerate/huge scene (or a near-zero requested cell)
// would otherwise overflow 2^53 and alias distinct cells together.
function clampCellForBounds(bounds, cell) {
  let c = cell > 0 ? cell : 1e-6
  let iter = 0
  while (boundsCellProduct(bounds, c) > DENSE_TUNING.fuseMaxCells && iter++ < 64) c *= 2
  return c
}

// Both runners execute the same fusion/voxel code. The async runner retains one
// reference map and one comparison map. Pair-major consistency preserves view
// order and the original early acceptance gates, using two scratch planes.
// `hooks.loadDepth(i)` (optional) loads a comparison view's depth plane + camera
// only; the check reads nothing else, and it runs N² times. Falls back to loadMap.
const STREAMED_CHECK_SHARE = 0.9
export function fuseDepthMaps(maps, opts = {}, onLog = () => {}, hooks = {}) {
  return runWithMaps(fusionSteps(maps, opts, onLog, hooks), maps)
}
export async function fuseDepthMapsStreamed(metas, loadMap, opts = {}, onLog = () => {}, hooks = {}) {
  const iterator = fusionSteps(metas, opts, onLog, { ...hooks, streaming: true })
  let next = iterator.next()
  while (!next.done) {
    const request = next.value
    if (typeof request === 'number') next = iterator.next(await loadMap(request))
    else {
      const { m, mi, minViews, minTriAngleDeg, maxCost, depthTolRel, consistencyPx, step } = request
      const agree = new Uint32Array(m.width * m.height), angle = new Float64Array(agree.length)
      const C = cameraCenter(m), rad = Math.max(0, Math.round(consistencyPx))
      const loadComparison = hooks.loadDepth ?? loadMap
      for (let ci = 0; ci < metas.length; ci++) {
        if (ci === mi) continue
        const other = await loadComparison(ci), otherC = cameraCenter(other)
        for (let v = 0; v < m.height; v += step) for (let u = 0; u < m.width; u += step) {
          const idx = v * m.width + u, d = m.depth[idx]
          if (!(d > 0) || m.cost[idx] > maxCost
            || (agree[idx] >= minViews && (minTriAngleDeg <= 0 || angle[idx] >= minTriAngleDeg))) continue
          const P = unprojectPixel(m, u, v, d), p = project(other, P.x, P.y, P.z)
          if (!p) continue
          const cu = Math.round(p.u), cv = Math.round(p.v), tol = depthTolRel * p.depth
          let hit = false
          for (let dv = -rad; dv <= rad && !hit; dv++) {
            const y = cv + dv
            if (y < 0 || y >= other.height) continue
            for (let du = -rad; du <= rad; du++) {
              const x = cu + du
              if (x < 0 || x >= other.width) continue
              const od = other.depth[y * other.width + x]
              if (od > 0 && Math.abs(od - p.depth) <= tol) { hit = true; break }
            }
          }
          if (hit) {
            agree[idx]++
            if (minTriAngleDeg > 0) angle[idx] = Math.max(angle[idx], triangulationAngle(C, otherC, P))
          }
        }
        // The N comparisons dominate a streamed map's time: they take the first
        // 90% of its progress slot, the single fusion pass the rest (see fusionSteps).
        hooks.onProgress?.(mi + STREAMED_CHECK_SHARE * (ci + 1) / metas.length, metas.length, 'Checking depth consistency…')
      }
      next = iterator.next({ agree, angle })
    }
  }
  return next.value
}

function* fusionSteps(maps, opts = {}, onLog = () => {}, hooks = {}) {
  // depthTolRel/step are user-facing (DENSE_FUSE_DEFAULTS); consistencyPx is internal (tuning.js).
  const { consistencyPx = DENSE_TUNING.consistencyPx, depthTolRel = 0.01, step = 1 } = opts
  // WS4 geometric filters (0 disables each; fall back to DENSE_FUSE_DEFAULTS values).
  const minTriAngleDeg = opts.minTriAngleDeg ?? 2.0
  const maxIncidenceDeg = opts.maxIncidenceDeg ?? 80
  const removeIsolated = opts.removeIsolated ?? true
  // cos of the incidence gate; ≤0 or ≥90 ⇒ disabled (cosInc ≥ 0 always passes).
  const incidenceOn = maxIncidenceDeg > 0 && maxIncidenceDeg < 90
  const cosIncGate = incidenceOn ? Math.cos(maxIncidenceDeg * Math.PI / 180) : -1
  const { onProgress } = hooks

  // Cost histogram (sampled, one sort) — drives both the auto gate and the summary
  // median, so it's computed once regardless of whether maxCost is overridden.
  const costStats = yield* fusionCostSteps(maps)

  // Derived defaults (Step 3): when the user hasn't overridden them, adapt to the
  // data. minViews = min(2, nMaps−1) so a 2-image project can still fuse (needs 1
  // agreeing view); maxCost = p70 of the pooled valid-pixel costs, clamped.
  const minViews = opts.minViews != null ? opts.minViews : Math.max(1, Math.min(2, maps.length - 1))
  let maxCost = opts.maxCost
  if (maxCost == null) {
    maxCost = costStats.maxCost
    onLog(`Fusion: auto maxCost ${maxCost.toFixed(2)} (p70 of ${costStats.n} valid px, raw ${costStats.raw.toFixed(2)})`, 'info', 'Dense')
    // A real ZNCC match is ≥ ~0.55 (cost ≤ 0.45). A raw p70 above 0.55 means the
    // photoconsistency signal is weak across the whole set — the problem is
    // upstream, not the fusion gate; say so instead of silently keeping junk.
    if (costStats.raw > 0.55) {
      onLog(`Fusion: weak cost distribution — raw p70 ${costStats.raw.toFixed(2)} > 0.55 (median ZNCC < 0.45). `
        + `Check intrinsics / window size / working resolution; the kept fraction below will be low by design.`,
        'warn', 'Dense')
    }
  }

  onLog(`Fusion: ${maps.length} map(s), minViews ${minViews}, maxCost ${maxCost}, `
    + `depth tol ${(depthTolRel * 100).toFixed(1)}%, consistency ±${consistencyPx}px, step ${step}px`,
    'info', 'Dense')

  // Cameras for reprojection consistency checks.
  const cams = maps.map((m) => ({ R: m.R, t: m.t, K: m.K, m }))

  const unproject = unprojectPixel

  // Scene bounds from a coarse valid-depth grid (fuseBboxStride-th row/col of each
  // map) — enough to size the voxel-key packing without a full unprojection pass.
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }
  const bboxStride = DENSE_TUNING.fuseBboxStride
  for (let mi = 0; mi < maps.length; mi++) {
    const m = yield mi
    const { width: w, height: h, depth } = m
    for (let v = 0; v < h; v += bboxStride) {
      for (let u = 0; u < w; u += bboxStride) {
        const d = depth[v * w + u]
        if (!(d > 0)) continue
        const P = unproject(m, u, v, d)
        if (P.x < bounds.minX) bounds.minX = P.x; if (P.x > bounds.maxX) bounds.maxX = P.x
        if (P.y < bounds.minY) bounds.minY = P.y; if (P.y > bounds.maxY) bounds.maxY = P.y
        if (P.z < bounds.minZ) bounds.minZ = P.z; if (P.z > bounds.maxZ) bounds.maxZ = P.z
      }
    }
  }
  const hasBounds = Number.isFinite(bounds.minX)
  if (!hasBounds) { bounds.minX = bounds.minY = bounds.minZ = 0; bounds.maxX = bounds.maxY = bounds.maxZ = 0 }

  // Merge cell in world units (≈ one ground-sample-distance), clamped up if the
  // packed key would overflow float64. mergeCell: null ⇒ auto (median GSD); ≤0 ⇒
  // "disabled" — streamed as a tiny cell so the flat output ≈ raw count but never a
  // per-point object list (a true no-merge would resurrect the OOM). autoMergeCell
  // and the cost histogram only read `maps`, so both resolve before the loop.
  let mergeCell = opts.mergeCell != null ? opts.mergeCell : yield* mergeCellSteps(maps)
  if (!(mergeCell > 0)) {
    const auto = yield* mergeCellSteps(maps)
    mergeCell = (auto > 0 ? auto : 1) * 1e-3
    onLog(`Fusion: merge disabled — streaming near-unmerged at cell ${mergeCell.toExponential(2)} `
      + `(flat output, no raw point objects)`, 'warn', 'Dense')
  }
  mergeCell = clampCellForBounds(bounds, mergeCell)
  const acc = createVoxelAccumulator(mergeCell, bounds)

  // Cull accounting (summed across all maps) so the user can see where pixels go.
  let considered = 0, noDepth = 0, highCost = 0, failedConsistency = 0, kept = 0
  let lowParallax = 0, grazing = 0 // WS4 geometric-filter culls
  // Precompute each camera centre for the triangulation-angle check (WS4).
  const camCenters = cams.map((c) => cameraCenter(c))
  let lastEmit = 0
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  // Rotate a camera-frame direction to world: n_world = Rᵀ · n_cam (same convention
  // as unproject's rotation block; no translation for a direction).
  const rotToWorld = (m, nx_, ny_, nz_) => ({
    x: m.R[0][0]*nx_ + m.R[1][0]*ny_ + m.R[2][0]*nz_,
    y: m.R[0][1]*nx_ + m.R[1][1]*ny_ + m.R[2][1]*nz_,
    z: m.R[0][2]*nx_ + m.R[1][2]*ny_ + m.R[2][2]*nz_,
  })
  let noNormalMaps = 0

  for (let mi = 0; mi < maps.length; mi++) {
    const m = yield mi
    const checks = hooks.streaming ? yield { mi, m, minViews, minTriAngleDeg, maxCost, depthTolRel, consistencyPx, step } : null
    const { width: w, height: h, depth, cost, rgb, normals } = m
    if (!normals) noNormalMaps++
    // Camera centre C = −Rᵀt, for the view-direction normal fallback (stale caches).
    const C = rotToWorld(m, -m.t[0], -m.t[1], -m.t[2])
    let mapKept = 0, mapConsidered = 0
    for (let v = 0; v < h; v += step) {
      // Throttled progress: done = mapIdx + rowsDone/h, so the bar glides within a map.
      if (onProgress) {
        const t = now()
        if (t - lastEmit >= DENSE_TUNING.fuseProgressMs) {
          lastEmit = t
          const base = hooks.streaming ? STREAMED_CHECK_SHARE : 0
          onProgress(mi + base + (1 - base) * v / h, maps.length, m.name ?? m.uuid?.slice(0, 8) ?? '')
        }
      }
      for (let u = 0; u < w; u += step) {
        considered++; mapConsidered++
        const idx = v * w + u
        const d = depth[idx]
        if (!(d > 0)) { noDepth++; continue }
        if (cost[idx] > maxCost) { highCost++; continue }
        const P = unproject(m, u, v, d)

        // Geometric consistency: reproject into other maps and require a pixel
        // within a `consistencyPx` radius whose depth agrees (relative tolerance).
        // The radius search makes the check robust to sub-pixel reprojection /
        // PatchMatch noise — a single rounded-pixel probe rejected most valid
        // points (and `consistencyPx` was previously inert: added to a world-unit
        // depth tolerance scaled by 1e-3, i.e. ≈0).
        const rad = Math.max(0, Math.round(consistencyPx))
        let agree = checks ? checks.agree[idx] : 0, maxAngle = checks ? checks.angle[idx] : 0
        for (let ci = 0; ci < cams.length && !checks; ci++) {
          const c = cams[ci]
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
            // WS4: track the widest triangulation angle among agreeing views. A pixel
            // that only "agrees" at ~0° parallax (sky / distant haze) never reaches
            // minTriAngleDeg, so it is culled below rather than fused into a flyer.
            if (minTriAngleDeg > 0) {
              // camCenters[mi] is the reference centre as an array — triangulationAngle
              // indexes both centres as [x,y,z], so C ({x,y,z}) must NOT be passed here
              // (it reads C[0] as undefined → NaN angle → every pixel culled as low-parallax).
              const ang = triangulationAngle(camCenters[mi], camCenters[ci], P)
              if (ang > maxAngle) maxAngle = ang
            }
            // Stop only when BOTH enough views AND enough parallax are satisfied.
            if (agree >= minViews && (minTriAngleDeg <= 0 || maxAngle >= minTriAngleDeg)) break
          }
        }
        if (agree < minViews) { failedConsistency++; continue }
        if (minTriAngleDeg > 0 && maxAngle < minTriAngleDeg) { lowParallax++; continue }

        // World-space oriented normal: rotate the converged camera-frame normal
        // (nz<0 ⇒ facing camera ⇒ outward for aerial). No normals (stale cache) ⇒
        // view direction (C − P) normalized — always camera-facing, never skipped.
        let nwx, nwy, nwz
        if (normals) {
          const no = idx * 3
          const nw = rotToWorld(m, normals[no], normals[no+1], normals[no+2])
          nwx = nw.x; nwy = nw.y; nwz = nw.z
        } else {
          nwx = C.x - P.x; nwy = C.y - P.y; nwz = C.z - P.z
        }
        const nm = Math.hypot(nwx, nwy, nwz)
        if (nm > 1e-9) { nwx /= nm; nwy /= nm; nwz /= nm } else { nwx = 0; nwy = 0; nwz = 1 }
        // Orient toward the camera that saw it. The kernels only keep n_z < 0 in the
        // camera frame, which is not the same as facing the ray for an off-axis
        // oblique surface — such a plane is only representable as −n, and its
        // homography is identical. Poisson needs outward (camera-facing) normals, and
        // averaging opposite normals in one voxel would cancel them.
        if (nwx * (C.x - P.x) + nwy * (C.y - P.y) + nwz * (C.z - P.z) < 0) { nwx = -nwx; nwy = -nwy; nwz = -nwz }

        // WS4 grazing-angle reject: the incidence angle between the surface normal and
        // the viewing ray (C − P). A grazing (edge-on) surface — thin vegetation shells,
        // silhouette fringes — is seen at ~90° incidence (cosInc ≈ 0), where depth is
        // least reliable. Cull below cos(maxIncidenceDeg). The view-direction fallback
        // normal (no per-pixel normal) equals the viewing ray, so cosInc = 1 and it is
        // never culled — the filter is automatically inert on stale/normal-less maps.
        if (incidenceOn) {
          let vx = C.x - P.x, vy = C.y - P.y, vz = C.z - P.z
          const vm = Math.hypot(vx, vy, vz)
          if (vm > 1e-9) {
            vx /= vm; vy /= vm; vz /= vm
            const cosInc = Math.abs(nwx * vx + nwy * vy + nwz * vz)
            if (cosInc < cosIncGate) { grazing++; continue }
          }
        }

        // Stream straight into the voxel merge — no raw point ever exists.
        const o = idx * 3
        acc.add(P.x, P.y, P.z, rgb[o], rgb[o+1], rgb[o+2], nwx, nwy, nwz)
        kept++; mapKept++
      }
    }
    onLog(`Fusion: ${m.name ?? m.uuid?.slice(0, 8) ?? '?'} — ${mapKept}/${mapConsidered} px kept `
      + `(${(100 * mapKept / Math.max(1, mapConsidered)).toFixed(1)}%)`, 'debug', 'Dense')
  }

  onProgress?.(maps.length - 0.02 * maps.length, maps.length, 'Packing points…')

  // Where did the candidate pixels go? (kept + the cull buckets = considered.)
  const pct = (n) => (100 * n / Math.max(1, considered)).toFixed(1)
  onLog(`Fusion: ${considered} candidate px → ${kept} kept (${pct(kept)}%); culled `
    + `${noDepth} no-depth (${pct(noDepth)}%), ${highCost} cost>${maxCost} (${pct(highCost)}%), `
    + `${failedConsistency} <${minViews} views (${pct(failedConsistency)}%)`
    + `${minTriAngleDeg > 0 ? `, ${lowParallax} <${minTriAngleDeg}° parallax (${pct(lowParallax)}%)` : ''}`
    + `${incidenceOn ? `, ${grazing} >${maxIncidenceDeg}° grazing (${pct(grazing)}%)` : ''}`, 'info', 'Dense')

  // The voxel merge already collapsed the per-source-pixel "shell" duplicates (a
  // surface seen by k views → k coincident points → one averaged cell). Report it.
  const mergedCells = acc.count
  if (mergedCells !== kept) {
    onLog(`Fusion: spatial merge cell ${mergeCell.toExponential(2)} — ${kept} → ${mergedCells} pts `
      + `(−${kept - mergedCells} dupes, ${(100 * (kept - mergedCells) / Math.max(1, kept)).toFixed(1)}%)`,
      'info', 'Dense')
  }

  // WS4 post-fusion isolated-cell removal: drop lone low-support cells (fusion noise
  // that slipped the per-pixel gates) with too few occupied neighbours.
  let isolatedRemoved = 0
  if (removeIsolated) {
    isolatedRemoved = acc.filterIsolated({
      radius: DENSE_TUNING.isolatedRadius,
      minNeighbors: DENSE_TUNING.isolatedMinNeighbors,
      maxSupport: DENSE_TUNING.isolatedMaxSupport,
    })
    if (isolatedRemoved) {
      onLog(`Fusion: isolated-cell removal — dropped ${isolatedRemoved} lone cell(s) `
        + `(${(100 * isolatedRemoved / Math.max(1, mergedCells)).toFixed(1)}% of merged)`, 'info', 'Dense')
    }
  }
  const cells = acc.count // after isolated-cell removal

  const flat = acc.finalizeFlat()
  const { nrm, degenerate } = acc.finalizeNormals()
  flat.nrm = nrm
  if (noNormalMaps) {
    onLog(`Fusion: ${noNormalMaps}/${maps.length} map(s) had no per-pixel normals — `
      + `used view-direction fallback (re-run depth maps to refresh)`, 'warn', 'Dense')
  }
  if (degenerate) {
    onLog(`Fusion: ${degenerate}/${cells} cell(s) had cancelling normals — set to (0,0,1)`, 'debug', 'Dense')
  }

  // Q3: a small, persistable summary so successive dense runs are comparable
  // (attached to the returned typed array — non-breaking for callers that iterate).
  const denom = Math.max(1, considered)
  flat.summary = {
    costMedian: costStats.median,
    keptPct: 100 * kept / denom,
    mergeCell,
    mergedPct: kept ? 100 * (kept - mergedCells) / kept : 0,
    isolatedRemoved,
    cullBreakdown: {
      noDepthPct: 100 * noDepth / denom,
      highCostPct: 100 * highCost / denom,
      lowViewsPct: 100 * failedConsistency / denom,
      lowParallaxPct: 100 * lowParallax / denom,
      grazingPct: 100 * grazing / denom,
    },
  }
  flat.count = cells
  return flat
}
