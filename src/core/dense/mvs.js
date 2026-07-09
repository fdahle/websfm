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
import {
  cameraCenter, projectWithDepth, triangulationAngle, scaleK, rgbaToGray,
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
    const sv = Math.min(ch - 1, (v * ch / fh) | 0)
    for (let u = 0; u < fw; u++) {
      const su = Math.min(cw - 1, (u * cw / fw) | 0)
      out[v * fw + u] = depth[sv * cw + su]
    }
  }
  return out
}

// Scale intrinsics with independent horizontal/vertical factors (floor-halving can
// make sx ≠ sy by a fraction of a percent; scaleK's single factor would skew fy/cy).
function scaleKxy(K, sx, sy) {
  return { fx: K.fx * sx, fy: K.fy * sy, cx: K.cx * sx, cy: K.cy * sy }
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
    hooks.onLog?.(`Dense: coarse-to-fine ${levels.length} levels (${sources.length} src) — ${plan}`, 'debug', 'Dense')
  }
  const baseSeed = (ref.width * 73856093) ^ (ref.height * 19349663)
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
  }

  // GPU↔CPU validation (WebGPU port). Two checks against the first source:
  //   1. cost consistency — recompute the plane cost on the CPU reference at the
  //      GPU's own final (depth, normal); should match to ~e-3 (f32 + hardware
  //      sampler precision). A larger RMS signals a kernel transcription bug.
  //   2. convergence — the median final cost; PatchMatch should pull this well
  //      below the ~1.0 of random/unmatched (the signal the sweeps actually work).
  if (hooks.validate && src.length) {
    const radius = Math.min(3, Math.max(1, window))
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

// Auto fusion cost threshold: the `percentile` (default p70) of the pooled
// valid-pixel costs across all depth maps, clamped to [lo, hi]. After Step 1 the
// per-pixel cost histogram is meaningful (no-measurement sources no longer floor
// it), so the gate can adapt to the data instead of a fixed 0.6. The upper clamp
// is deliberately tight (0.45): a genuine ZNCC match is ≥ ~0.55 (cost ≤ 0.45), so
// a p70 above that means the distribution itself is weak (bad intrinsics / window
// / working resolution) — keeping such points would only fuse junk. Returns
// { maxCost, n, raw } (raw = unclamped p70, so callers can flag a weak signal).
export function autoFusionMaxCost(maps, { percentile = 0.7, lo = 0.3, hi = 0.45 } = {}) {
  const costs = []
  for (const m of maps) {
    const { depth, cost } = m
    for (let i = 0; i < depth.length; i++) if (depth[i] > 0) costs.push(cost[i])
  }
  if (!costs.length) return { maxCost: hi, n: 0, raw: hi }
  costs.sort((a, b) => a - b)
  const q = costs[Math.min(costs.length - 1, Math.max(0, Math.round(percentile * (costs.length - 1))))]
  return { maxCost: Math.min(hi, Math.max(lo, q)), n: costs.length, raw: q }
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
export function fuseDepthMaps(maps, opts = {}, onLog = () => {}) {
  // depthTolRel/step are user-facing (DENSE_FUSE_DEFAULTS); consistencyPx is internal (tuning.js).
  const { consistencyPx = DENSE_TUNING.consistencyPx, depthTolRel = 0.01, step = 2 } = opts

  // Derived defaults (Step 3): when the user hasn't overridden them, adapt to the
  // data. minViews = min(2, nMaps−1) so a 2-image project can still fuse (needs 1
  // agreeing view); maxCost = p70 of the pooled valid-pixel costs, clamped.
  const minViews = opts.minViews != null ? opts.minViews : Math.max(1, Math.min(2, maps.length - 1))
  let maxCost = opts.maxCost
  if (maxCost == null) {
    const auto = autoFusionMaxCost(maps)
    maxCost = auto.maxCost
    onLog(`Fusion: auto maxCost ${maxCost.toFixed(2)} (p70 of ${auto.n} valid px, raw ${auto.raw.toFixed(2)})`, 'info', 'Dense')
    // A real ZNCC match is ≥ ~0.55 (cost ≤ 0.45). A raw p70 above 0.55 means the
    // photoconsistency signal is weak across the whole set — the problem is
    // upstream, not the fusion gate; say so instead of silently keeping junk.
    if (auto.raw > 0.55) {
      onLog(`Fusion: weak cost distribution — raw p70 ${auto.raw.toFixed(2)} > 0.55 (median ZNCC < 0.45). `
        + `Check intrinsics / window size / working resolution; the kept fraction below will be low by design.`,
        'warn', 'Dense')
    }
  }

  onLog(`Fusion: ${maps.length} map(s), minViews ${minViews}, maxCost ${maxCost}, `
    + `depth tol ${(depthTolRel * 100).toFixed(1)}%, consistency ±${consistencyPx}px, step ${step}px`,
    'info', 'Dense')

  // Cameras for reprojection consistency checks.
  const cams = maps.map((m) => ({ R: m.R, t: m.t, K: m.K, m }))

  // Cull accounting (summed across all maps) so the user can see where pixels go.
  let considered = 0, noDepth = 0, highCost = 0, failedConsistency = 0, kept = 0

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
    let mapKept = 0, mapConsidered = 0
    for (let v = 0; v < h; v += step) {
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
        if (agree < minViews) { failedConsistency++; continue }

        const o = idx * 3
        out.push({ x: P.x, y: P.y, z: P.z, color: [rgb[o], rgb[o+1], rgb[o+2]] })
        kept++; mapKept++
      }
    }
    onLog(`Fusion: ${m.uuid?.slice(0, 8) ?? '?'} — ${mapKept}/${mapConsidered} px kept `
      + `(${(100 * mapKept / Math.max(1, mapConsidered)).toFixed(1)}%)`, 'debug', 'Dense')
  }

  // Where did the candidate pixels go? (kept + the three cull buckets = considered.)
  const pct = (n) => (100 * n / Math.max(1, considered)).toFixed(1)
  onLog(`Fusion: ${considered} candidate px → ${kept} kept (${pct(kept)}%); culled `
    + `${noDepth} no-depth (${pct(noDepth)}%), ${highCost} cost>${maxCost} (${pct(highCost)}%), `
    + `${failedConsistency} <${minViews} views (${pct(failedConsistency)}%)`, 'info', 'Dense')

  // Q3: a small, persistable summary so successive dense runs are comparable
  // (attached to the returned array — non-breaking for callers that just iterate).
  const denom = Math.max(1, considered)
  out.summary = {
    costMedian: medianOf(maps),
    keptPct: 100 * kept / denom,
    cullBreakdown: {
      noDepthPct: 100 * noDepth / denom,
      highCostPct: 100 * highCost / denom,
      lowViewsPct: 100 * failedConsistency / denom,
    },
  }
  return out
}

// Median of the pooled valid-pixel costs across depth maps (dense-summary helper).
function medianOf(maps) {
  const costs = []
  for (const m of maps) {
    const { depth, cost } = m
    for (let i = 0; i < depth.length; i++) if (depth[i] > 0) costs.push(cost[i])
  }
  if (!costs.length) return 0
  costs.sort((a, b) => a - b)
  return costs[costs.length >> 1]
}
