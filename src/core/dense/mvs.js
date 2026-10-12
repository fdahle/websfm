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
import { normalizeRegion, regionContains } from '../products/region.js'
import { viewIndex, positionsInRegion } from './sparseInput.js'
import { DEPTHMAP_DEFAULTS, DENSE_FUSE_DEFAULTS } from '../defaults.user.js'
import { levelPerturbStarts } from './refineSchedule.js'
import { projectDensifyPeakBytes, densifyInputBytes, formatBytes, maxFusionTileCells, DENSIFY_CLOUD_BYTES_PER_CELL } from './memBudget.js'
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
//   cameras: Map<uuid, { R, t, K }>   sparse: the packed sparse input (sparseInput.js)
//   index: viewIndex(sparse) — pass the run's one index; built here when omitted.
// Walks only the points the reference sees: O(its observations), not O(points).
export function selectSourceViews(cameras, sparse, refUuid, opts = {}, index = viewIndex(sparse)) {
  // maxSources is user-facing (DEPTHMAP_DEFAULTS); the angle window is internal (tuning.js).
  const { maxSources = 6, minAngleDeg = DENSE_TUNING.minAngleDeg, maxAngleDeg = DENSE_TUNING.maxAngleDeg } = opts
  const refCam = cameras.get(refUuid)
  if (!refCam) return []
  const Cref = cameraCenter(refCam)
  const centers = new Map()
  const score = new Map()

  const { pos, vstart, vcam, viewUuids } = sparse
  const pt = { x: 0, y: 0, z: 0 }
  for (const i of index.get(refUuid) ?? []) {
    pt.x = pos[3 * i]; pt.y = pos[3 * i + 1]; pt.z = pos[3 * i + 2]
    for (let k = vstart[i]; k < vstart[i + 1]; k++) {
      const u = viewUuids[vcam[k]]
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
// project every point (`pos`, flat xyz) in front of the reference camera, splat its
// depth to the nearest working pixel. Returns { seedDepth: Float32Array(w*h),
// depthMin, depthMax } where the range is a padded 5–95th percentile of the seeds.
export function seedDepthFromSparse(refCam, pos, width, height) {
  const seed = new Float32Array(width * height) // 0 ⇒ no seed
  const depths = []
  for (let i = 0; i < pos.length; i += 3) {
    const p = project(refCam, pos[i], pos[i + 1], pos[i + 2])
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
// `pos`: the sparse positions (flat xyz Float64Array; sparseInput.js `pos`).
export async function depthMapForImage(ref, sources, pos, settings = {}, computeDepthMapFn = computeDepthMap, hooks = {}) {
  // window/iterations/bestK are user-facing (DEPTHMAP_DEFAULTS); coarseLong is internal (tuning.js).
  const { window = 3, iterations = 3, bestK = 3, coarseLong = DENSE_TUNING.coarseLong } = settings
  const refCamScaled = { R: ref.cam.R, t: ref.cam.t, K: ref.K }
  // Depth range is view-space (resolution-invariant): derive it once from the
  // working-res projection (most sparse points visible → tightest percentiles).
  // A region narrows the depth search to the sparse points inside it.
  const region = normalizeRegion(settings.region)
  const seedPos = region ? positionsInRegion(pos, region) : pos
  const { depthMin, depthMax, seeded } = seedDepthFromSparse(refCamScaled, seedPos, ref.width, ref.height)
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
  // Refinement continues across levels rather than restarting (refineSchedule.js).
  const perturbStarts = levelPerturbStarts(levels.map((_, li) => iterations + (levels.length - 1 - li)))
  for (let li = 0; li < levels.length; li++) {
    const L = levels[li]
    let seedDepth
    if (li === 0) {
      const camL = { R: ref.cam.R, t: ref.cam.t, K: L.K }
      seedDepth = seedDepthFromSparse(camL, pos, L.w, L.h).seedDepth
    } else {
      seedDepth = upsampleDepthNearest(prevDepth, prevW, prevH, L.w, L.h)
    }
    const levelIters = iterations + (levels.length - 1 - li) // coarsest gets the most
    dm = await computeDepthMapFn(L.gray, L.w, L.h, L.K, L.srcs, {
      depthMin, depthMax, seedDepth, window, iterations: levelIters, bestK,
      seed: (baseSeed ^ (li * 0x9e3779b1)) >>> 0, perturbStart: perturbStarts[li],
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

// ── Candidate views for the cross-view filter (exact cull + ordering) ────────────
// Which other maps could vouch for a pixel, and in what order to ask them. Neither
// changes a verdict, only the work:
//
//   • CULL — exact, not a heuristic. Every valid pixel of a region lies in the frustum
//     slice {u∈[u0,u1], v∈[v0,v1], depth∈[d0,d1]} of its own camera, a convex set whose
//     8 vertices are those corners unprojected. A perspective projection maps a convex
//     set lying wholly in front of the camera onto the convex hull of its vertices'
//     images, so if those images' bounding box misses a candidate's raster, every
//     pixel's projection misses it too — the walk would `continue` past it anyway. A
//     slice not wholly in front keeps the candidate (the hull argument fails there); one
//     wholly behind drops it (camera depth is affine). The 1 px margin absorbs rounding
//     between this test and the per-pixel one. Done per map, then per block: one stray
//     far depth (sky) stretches a whole map's slice over every other camera, so a
//     map-level cull alone cuts little on exactly the scenes this filter is for.
//   • ORDER — nearest camera centre first. A pixel is kept as soon as `minConsistent`
//     views agree, and agreeing views are the overlapping, i.e. nearby, ones; in index
//     order a good pixel of map 150 first walked 149 maps that cannot see it. The count
//     that decides the verdict does not depend on order.
const FILTER_BLOCK = 64
const CULL_MARGIN = 1

function sliceCorners(m, ua, ub, va, vb) {
  const { width: w, depth } = m
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, d0 = Infinity, d1 = -Infinity
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

function sliceMisses(corners, c, margin = CULL_MARGIN) {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, behind = 0
  for (const P of corners) {
    const p = project(c, P.x, P.y, P.z)
    if (!p) { behind++; continue }
    if (p.u < minU) minU = p.u
    if (p.u > maxU) maxU = p.u
    if (p.v < minV) minV = p.v
    if (p.v > maxV) maxV = p.v
  }
  if (behind === corners.length) return true
  return !behind && (maxU < -0.5 - margin || minU > c.width - 0.5 + margin
    || maxV < -0.5 - margin || minV > c.height - 0.5 + margin)
}

// Candidate views of ONE reference map: every other map its depth slice can reach,
// nearest camera first. Needs only the reference's depth (its slice corners) and the
// others' cameras — which is what lets the streamed filter pick candidates before it
// loads any of their planes. `others[ci]` needs { width, height, K, R, t }.
function referenceCandidates(ref, mi, others, centres) {
  const corners = sliceCorners(ref, 0, ref.width, 0, ref.height)
  if (!corners) return []
  const C = centres[mi]
  const dist = (ci) => Math.hypot(centres[ci][0] - C[0], centres[ci][1] - C[1], centres[ci][2] - C[2])
  const out = []
  for (let ci = 0; ci < others.length; ci++) if (ci !== mi && !sliceMisses(corners, others[ci])) out.push(ci)
  return out.map((ci) => [dist(ci), ci]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((e) => e[1])
}

// Per map: the surviving candidate indices, nearest first.
export function filterCandidates(maps) {
  const centres = maps.map((m) => cameraCenter(m))
  return maps.map((m, mi) => referenceCandidates(m, mi, maps, centres))
}

// Per block of the reference map: the subset of its map-level candidates (order kept)
// that survive that block's own slice. Row-major blocks of FILTER_BLOCK px.
function blockCandidates(ref, others, mapCand) {
  const bw = Math.ceil(ref.width / FILTER_BLOCK), bh = Math.ceil(ref.height / FILTER_BLOCK)
  const out = new Array(bw * bh)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const ua = bx * FILTER_BLOCK, va = by * FILTER_BLOCK
      const corners = sliceCorners(ref, ua, Math.min(ref.width, ua + FILTER_BLOCK), va, Math.min(ref.height, va + FILTER_BLOCK))
      out[by * bw + bx] = corners ? Int32Array.from(mapCand.filter((ci) => !sliceMisses(corners, others[ci]))) : new Int32Array(0)
    }
  }
  return { bw, lists: out }
}

// Flat per-map camera parameters for the filter's allocation-free inner loop:
// R (row-major, 9) · t (3) · fx fy cx cy. Read back as the same doubles, so the
// inlined arithmetic below reproduces unprojectPixel/project bit for bit.
function camParams(m) {
  const { R, t, K } = m
  return Float64Array.of(R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2],
    t[0], t[1], t[2], K.fx, K.fy, K.cx, K.cy)
}

// Share of Stage A's progress bar owned by the per-image loop (the rest is the
// cross-view filter that runs after it). Derived from what the loop has measured so
// far — elapsed ms and working pixels over `done` images, extrapolated to `total` —
// against the filter's modelled per-pixel cost. A fixed split was wrong in both
// directions: WASM PatchMatch takes minutes per image (filter ≈ 1 %), the GPU path
// seconds (filter can be most of the run). Clamped so neither phase vanishes.
export function geomFilterLoopShare({ loopMs, done, total, pxDone, usPerPx = DENSE_TUNING.geomFilterUsPerPx }) {
  if (!(done > 0) || !(loopMs > 0)) return null
  const loopEst = loopMs / done * total
  const filterEst = pxDone / done * total * usPerPx / 1000
  return Math.min(0.99, Math.max(0.05, loopEst / (loopEst + filterEst)))
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
// A view counts as consistent when e ≤ maxGeomCost **and** it sees P at a
// triangulation angle ≥ minGeomAngleDeg (COLMAP's filter_min_triangulation_angle, also
// applied per view). Requiring `minConsistent` such views kills anything only one view
// believes in. The angle matters because at ~0° parallax the round trip is vacuous: a
// source next to the reference sees the same ray, so any depth — a sky pixel at an
// arbitrary distance — returns to (u,v). Without it, near-duplicate views vouched for
// sky, which then survived in the persisted maps the orthophoto uses as a z-buffer
// (fusion's own parallax gate only cleans the fused cloud). Note this samples the source's depth
// at ONE pixel, which is what makes it strict: fuseDepthMaps' own check searches a
// (2·consistencyPx+1)² window and accepts if *any* pixel there is within tolerance, so
// a noisy depth cloud (a bush) passes it by chance. That check stays as a cheap second
// line of defence; this is the one that discriminates.
//
// Also applies an absolute per-pixel photometric floor (`minNcc`, COLMAP's
// filter_min_ncc). This floor is what vets the photometry; fusion's `maxCost` is only a
// loose backstop above it.
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
// Cost is O(maps · candidates · px), with an early break once `minConsistent` views
// agree. Candidates are culled per block and ordered nearest-first (see
// `filterCandidates` — neither changes a verdict); walking every map in index order was
// O(maps² · px) and dominated Stage A on large sets. Pure: maps are mutated only via the
// returned planes; no I/O. `opts.cull: false` walks every map in index order — the
// reference the cull is tested against.
export function filterDepthMapsGeometric(maps, opts = {}, onLog = () => {}, hooks = {}) {
  const cfg = filterConfig(opts)
  const { onProgress } = hooks
  const nMaps = maps.length
  const checkViews = nMaps >= 2 && cfg.minConsistent > 0
  const params = maps.map(camParams)
  const centres = maps.map((m) => cameraCenter(m))
  const masks = maps.map((m) => new Uint8Array(m.width * m.height)) // 1 = drop
  const totals = { considered: 0, kept: 0, lowNcc: 0, inconsistent: 0, lowParallax: 0 }
  let nCand = 0
  for (let mi = 0; mi < nMaps; mi++) {
    const m = maps[mi]
    const label = m.name ?? m.uuid?.slice(0, 8) ?? ''
    onProgress?.(mi, nMaps, label)
    const { cand, lists } = referencePlan(m, mi, maps, centres, cfg, checkViews)
    nCand += cand.length
    const depths = new Array(nMaps)
    for (const ci of cand) depths[ci] = maps[ci].depth
    const tMap = Date.now()
    m.filterStats = judgeReference(mi, m, cand, lists, maps, params, centres, cfg, checkViews, depths,
      masks[mi], totals, (frac) => onProgress?.(mi + frac, nMaps, label))
    logReference(onLog, m.filterStats, label, mi, nMaps, cand.length, cfg, tMap)
  }
  if (checkViews) {
    onLog(`Depth filter: cross-view check over ${nMaps} maps — ${(nCand / nMaps).toFixed(1)} candidate `
      + `views/map (of ${nMaps - 1})${cfg.cull ? ' after the frustum cull' : ''}`, 'info', 'Dense')
  }
  // Apply now that every map has been judged against the original evidence.
  for (let mi = 0; mi < nMaps; mi++) {
    const { depth, width, height } = maps[mi]
    const mask = masks[mi]
    for (let k = 0; k < width * height; k++) if (mask[k]) depth[k] = 0
  }
  logFilterTotals(onLog, totals, nMaps, cfg)
  return totals
}

/**
 * The same cross-view filter over maps that are NOT all in memory — the path that
 * lets Stage A scale past the number of maps one worker can hold (TODO ▸ SC-4).
 * Verdicts are identical to filterDepthMapsGeometric: the per-reference kernel is
 * shared, and every map is judged against UNFILTERED planes (each is read as stored;
 * nothing is written until every map has been judged).
 *
 * metas[i]: { uuid, name, width, height, K, R, t } — cameras only.
 * io.loadReference(i) → { depth, cost } (unfiltered); io.loadDepth(i) → depth plane.
 * Candidate depth planes are cached in a byte-bounded LRU (`cacheBytes`); a reference
 * whose candidates alone exceed it still runs, briefly over the bound.
 * `opts.refs` (indices) judges only those references — every reference is judged
 * against the same unfiltered planes, so disjoint subsets run in parallel workers give
 * exactly the full run's verdicts; `opts.summaryLogs: false` leaves the run-level log
 * lines to the caller that merges them (`logFilterTotals`).
 * Returns { masks: Uint8Array per map (bit-packed, 1 = drop), stats: per map, totals,
 * loads, hits, nCand } (masks/stats only at the judged indices).
 */
export async function filterDepthMapsGeometricStreamed(metas, io, opts = {}, onLog = () => {}, hooks = {}) {
  const cfg = filterConfig(opts)
  const { onProgress } = hooks
  const cacheBytes = opts.cacheBytes ?? 512 * 1024 ** 2
  const nMaps = metas.length
  const checkViews = nMaps >= 2 && cfg.minConsistent > 0
  const params = metas.map(camParams)
  const centres = metas.map((m) => cameraCenter(m))
  const cache = new Map() // ci → depth plane, in use order (LRU at the front)
  let cached = 0, loads = 0, hits = 0
  const depthOf = async (ci) => {
    const hit = cache.get(ci)
    if (hit) { hits++; cache.delete(ci); cache.set(ci, hit); return hit }
    const plane = await io.loadDepth(ci)
    loads++
    cache.set(ci, plane); cached += plane.byteLength
    return plane
  }
  const evict = (keep) => {
    for (const [ci, plane] of cache) {
      if (cached <= cacheBytes) break
      if (keep.has(ci)) continue
      cache.delete(ci); cached -= plane.byteLength
    }
  }
  const masks = new Array(nMaps), stats = new Array(nMaps)
  const totals = { considered: 0, kept: 0, lowNcc: 0, inconsistent: 0, lowParallax: 0 }
  let nCand = 0
  const refs = opts.refs ?? Array.from({ length: nMaps }, (_, i) => i)
  for (let k = 0; k < refs.length; k++) {
    const mi = refs[k]
    const meta = metas[mi]
    const label = meta.name ?? meta.uuid?.slice(0, 8) ?? ''
    onProgress?.(k, refs.length, label)
    const { depth, cost } = await io.loadReference(mi)
    const ref = { ...meta, depth, cost }
    const { cand, lists } = referencePlan(ref, mi, metas, centres, cfg, checkViews)
    nCand += cand.length
    const depths = new Array(nMaps)
    for (const ci of cand) depths[ci] = await depthOf(ci)
    evict(new Set(cand))
    const mask = new Uint8Array(meta.width * meta.height)
    const tMap = Date.now()
    stats[mi] = judgeReference(mi, ref, cand, lists, metas, params, centres, cfg, checkViews, depths,
      mask, totals, (frac) => onProgress?.(k + frac, refs.length, label))
    logReference(onLog, stats[mi], label, mi, nMaps, cand.length, cfg, tMap)
    masks[mi] = packBits(mask)
  }
  if (opts.summaryLogs !== false) {
    if (checkViews) logFilterCache(onLog, { nMaps, nCand, loads, hits, cacheBytes, cull: cfg.cull })
    logFilterTotals(onLog, totals, nMaps, cfg)
  }
  return { masks, stats, totals, loads, hits, nCand }
}

// The streamed filter's candidate/cache line, for one run or the merge of several.
export function logFilterCache(onLog, { nMaps, nCand, loads, hits, cacheBytes, cull = true, workers = 1 }) {
  onLog(`Depth filter: cross-view check over ${nMaps} maps — ${(nCand / nMaps).toFixed(1)} candidate `
    + `views/map (of ${nMaps - 1})${cull ? ' after the frustum cull' : ''}; `
    + `${loads} plane reads, ${hits} cache hits (≤${formatBytes(cacheBytes)} cache${workers > 1 ? ` per worker, ${workers} workers` : ''})`, 'info', 'Dense')
}

/** Zero the pixels a packed filter mask drops, in place. */
export function applyPackedMask(depth, packed) {
  for (let k = 0; k < depth.length; k++) if (packed[k >> 3] & (1 << (k & 7))) depth[k] = 0
  return depth
}

function packBits(mask) {
  const out = new Uint8Array((mask.length + 7) >> 3)
  for (let k = 0; k < mask.length; k++) if (mask[k]) out[k >> 3] |= 1 << (k & 7)
  return out
}

// The cross-view filter's knobs from the depth-map settings (DEPTHMAP_DEFAULTS for the
// unset ones) — shared by the worker op and the store that merges a split run.
export function filterSettings(settings = {}) {
  return {
    maxGeomCost: settings.maxGeomCost ?? DEPTHMAP_DEFAULTS.maxGeomCost,
    minConsistent: settings.minConsistent ?? DEPTHMAP_DEFAULTS.minConsistent,
    minNcc: settings.minNcc ?? DEPTHMAP_DEFAULTS.minNcc,
    minGeomAngleDeg: settings.minGeomAngleDeg ?? DEPTHMAP_DEFAULTS.minGeomAngleDeg,
  }
}

export function filterConfig(opts) {
  const {
    minNcc = DEPTHMAP_DEFAULTS.minNcc,
    maxGeomCost = DEPTHMAP_DEFAULTS.maxGeomCost,
    minConsistent = DEPTHMAP_DEFAULTS.minConsistent,
    minGeomAngleDeg = DEPTHMAP_DEFAULTS.minGeomAngleDeg,
    cull = true,
  } = opts
  return { minNcc, maxGeomCost, minConsistent, minGeomAngleDeg, cull,
    maxCostGate: 1 - minNcc, // ZNCC ncc ≥ minNcc  ⇔  cost ≤ 1 − minNcc
    angleOn: minGeomAngleDeg > 0, cosMinAngle: Math.cos(minGeomAngleDeg * Math.PI / 180) }
}

// Which views a reference is checked against, map level and per 64 px block. A lone
// map has no cross-view evidence — the test is meaningless, not "everything fails".
function referencePlan(ref, mi, others, centres, cfg, checkViews) {
  if (!checkViews) return { cand: [], lists: null }
  if (!cfg.cull) return { cand: others.map((_, ci) => ci).filter((ci) => ci !== mi), lists: null }
  const cand = referenceCandidates(ref, mi, others, centres)
  return { cand, lists: blockCandidates(ref, others, cand) }
}

// The per-pixel verdict for one reference map (the filter's whole kernel, shared by
// the in-memory and the streamed filter). `depths[ci]` is candidate ci's UNFILTERED
// depth plane; `others[ci]` its camera and size. Writes 1 = drop into `mask`,
// accumulates `totals`, returns the map's own counts.
function judgeReference(mi, ref, cand, plan, others, params, centres, cfg, checkViews, depths, mask, totals, onTick) {
  const { width: w, height: h, depth, cost } = ref
  const { maxCostGate, maxGeomCost, minConsistent, angleOn, cosMinAngle } = cfg
  const bw = plan ? plan.bw : 1
  const lists = plan ? plan.lists : null
  const flatList = lists ? null : Int32Array.from(cand)
  // This map's camera, unpacked once (see camParams).
  const pm = params[mi]
  const mR00 = pm[0], mR01 = pm[1], mR02 = pm[2], mR10 = pm[3], mR11 = pm[4], mR12 = pm[5]
  const mR20 = pm[6], mR21 = pm[7], mR22 = pm[8], mt0 = pm[9], mt1 = pm[10], mt2 = pm[11]
  const mfx = pm[12], mfy = pm[13], mcx = pm[14], mcy = pm[15]
  const [mCx, mCy, mCz] = centres[mi]
  let mapLowNcc = 0, mapInconsistent = 0, mapLowParallax = 0
  let tTick = Date.now()
  for (let v = 0; v < h; v++) {
    // Within-map progress (a map is seconds on a big set): time-throttled so a
    // 1000-row plane doesn't post 1000 events.
    if ((v & 15) === 0 && v > 0) {
      const now = Date.now()
      if (now - tTick >= 100) { tTick = now; onTick(v / h) }
    }
    const rowBlock = ((v / FILTER_BLOCK) | 0) * bw
    for (let u = 0; u < w; u++) {
      const idx = v * w + u
      const d = depth[idx]
      if (!(d > 0)) continue // already a hole
      totals.considered++
      if (cost[idx] > maxCostGate) { mask[idx] = 1; totals.lowNcc++; mapLowNcc++; continue }
      if (!checkViews) { totals.kept++; continue }

      // P = unprojectPixel(m, u, v, d), inlined (same arithmetic, no allocation).
      const ax = (u - mcx) / mfx * d - mt0, ay = (v - mcy) / mfy * d - mt1, az = d - mt2
      const Px = mR00 * ax + mR10 * ay + mR20 * az
      const Py = mR01 * ax + mR11 * ay + mR21 * az
      const Pz = mR02 * ax + mR12 * ay + mR22 * az
      const list = flatList ?? lists[rowBlock + ((u / FILTER_BLOCK) | 0)]
      // Reference ray P→C, for the parallax gate.
      const rx = mCx - Px, ry = mCy - Py, rz = mCz - Pz
      const rr = rx * rx + ry * ry + rz * rz
      // `flat` counts views that round-trip but at too little parallax: they decide
      // only which bucket a rejected pixel is reported in, never the verdict.
      let agree = 0, flat = 0
      for (let k = 0; k < list.length && agree < minConsistent; k++) {
        const ci = list[k]
        const c = others[ci], pc = params[ci]
        // p = project(c, P)
        const zc = pc[6] * Px + pc[7] * Py + pc[8] * Pz + pc[11]
        if (!(zc > 1e-9)) continue // behind the source camera
        const xc = pc[0] * Px + pc[1] * Py + pc[2] * Pz + pc[9]
        const yc = pc[3] * Px + pc[4] * Py + pc[5] * Pz + pc[10]
        const cu = Math.round(pc[12] * (xc / zc) + pc[14]), cv = Math.round(pc[13] * (yc / zc) + pc[15])
        if (cu < 0 || cu >= c.width || cv < 0 || cv >= c.height) continue
        const od = depths[ci][cv * c.width + cu]
        if (!(od > 0)) continue // source has no depth here — no evidence either way
        // The source's own surface point at that pixel. If the source is looking at
        // something else entirely (occluder, or noise), the round trip lands far from
        // (u,v) and this view simply doesn't vouch for the pixel.
        // P2 = unprojectPixel(c, cu, cv, od)
        const bx = (cu - pc[14]) / pc[12] * od - pc[9], by = (cv - pc[15]) / pc[13] * od - pc[10], bz = od - pc[11]
        const Qx = pc[0] * bx + pc[3] * by + pc[6] * bz
        const Qy = pc[1] * bx + pc[4] * by + pc[7] * bz
        const Qz = pc[2] * bx + pc[5] * by + pc[8] * bz
        // q = project(m, P2)
        const qz = mR20 * Qx + mR21 * Qy + mR22 * Qz + mt2
        if (!(qz > 1e-9)) continue
        const qx = mR00 * Qx + mR01 * Qy + mR02 * Qz + mt0
        const qy = mR10 * Qx + mR11 * Qy + mR12 * Qz + mt1
        if (Math.hypot(mfx * (qx / qz) + mcx - u, mfy * (qy / qz) + mcy - v) > maxGeomCost) continue
        if (angleOn) {
          const Cs = centres[ci]
          const sx = Cs[0] - Px, sy = Cs[1] - Py, sz = Cs[2] - Pz
          const ss = sx * sx + sy * sy + sz * sz
          if (rx * sx + ry * sy + rz * sz > cosMinAngle * Math.sqrt(rr * ss)) { flat++; continue }
        }
        agree++
      }
      if (agree < minConsistent) {
        mask[idx] = 1
        // Would have passed on views that only lacked parallax ⇒ report it as such.
        if (agree + flat >= minConsistent) { totals.lowParallax++; mapLowParallax++ } else { totals.inconsistent++; mapInconsistent++ }
        continue
      }
      totals.kept++
    }
  }
  let considered = 0
  for (let k = 0; k < depth.length; k++) if (depth[k] > 0) considered++
  const kept = considered - mapLowNcc - mapInconsistent - mapLowParallax
  return { considered, lowNcc: mapLowNcc, inconsistent: mapInconsistent, lowParallax: mapLowParallax,
    kept, keptPct: considered ? 100 * kept / considered : 0 }
}

// Info, like Stage A's per-image line: this pass can run for minutes, and at the
// default log level it was otherwise silent from start to summary.
function logReference(onLog, s, label, mi, nMaps, nCand, cfg, tMap) {
  onLog(`Depth filter: ${label || '?'} (${mi + 1}/${nMaps}) — kept ${s.keptPct.toFixed(1)}%; `
    + `dropped ${s.lowNcc} low-NCC, ${s.inconsistent} inconsistent`
    + `${cfg.angleOn ? `, ${s.lowParallax} low-parallax` : ''} px; ${nCand} candidate views, `
    + `${((Date.now() - tMap) / 1000).toFixed(1)}s`, 'info', 'Dense')
}

export function logFilterTotals(onLog, t, nMaps, cfg) {
  const pct = (n) => (100 * n / Math.max(1, t.considered)).toFixed(1)
  if (nMaps < 2) {
    onLog(`Depth filter: only ${nMaps} map — cross-view check skipped, NCC floor only`, 'warn', 'Dense')
  }
  onLog(`Depth filter: ${t.considered} px with depth → ${t.kept} kept (${pct(t.kept)}%); dropped `
    + `${t.lowNcc} NCC<${cfg.minNcc} (${pct(t.lowNcc)}%), `
    + `${t.inconsistent} <${cfg.minConsistent} consistent views @${cfg.maxGeomCost}px (${pct(t.inconsistent)}%)`
    + `${cfg.angleOn ? `, ${t.lowParallax} consistent only at <${cfg.minGeomAngleDeg}° parallax (${pct(t.lowParallax)}%)` : ''}`,
    'info', 'Dense')
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

// The valid-pixel cost distribution across all depth maps: its median (the run
// summary) and p70 (the weak-signal warning: a genuine ZNCC match is ≥ ~0.55, cost
// ≤ 0.45, so a p70 above 0.55 means the whole set matches poorly — bad intrinsics,
// window or working resolution). It does NOT set the fusion gate any more. It used to
// (p70 clamped to [0.30, 0.45]), which by construction dropped ~30 % of the pixels the
// cross-view filter's absolute minNcc floor had already vetted: the fixed default
// (DENSE_FUSE_DEFAULTS.maxCost) raised the ETH3D mean F1 at 2 cm from 52.6 to 58.9 with
// accuracy unchanged on every scene (HANDOVER ▸ B-parity, 2026-10-12).
//
// Costs are **stride-subsampled** into a single Float32Array and sorted once, so
// the whole set can pool tens of millions of pixels without a per-pixel JS-boxed
// array (the double-sort memory hog). `n` is the true valid-pixel count; `median`
// feeds the run summary (replaces the old second full pool + sort in medianOf).
// Returns { n, p70, median }.
function* fusionCostSteps(maps, { maxSamples = DENSE_TUNING.fuseCostMaxSamples } = {}) {
  // One cheap scan for the true valid count → a stride that caps the sample budget.
  let totalValid = 0
  for (let mi = 0; mi < maps.length; mi++) {
    const m = yield mi
    const { depth } = m
    for (let i = 0; i < depth.length; i++) if (depth[i] > 0) totalValid++
  }
  if (!totalValid) return { n: 0, p70: 0, median: 0 }
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
  return { n: totalValid, p70: at(0.7), median: at(0.5) }
}

function runWithMaps(iterator, maps) {
  let step = iterator.next()
  while (!step.done) step = iterator.next(maps[step.value])
  return step.value
}
export function fusionCostStats(maps, options = {}) {
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

// murmur3's 32-bit finalizer: a bijective avalanche mix of an int32 (→ uint32). The
// voxel accumulator's index and the fusion cell-count estimate hash with it.
function mix32(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

// Streaming voxel accumulator: the fusion loop feeds kept pixels **one at a time**
// into this, so the raw per-source-pixel point list — the fusion OOM (25–30 M boxed
// {x,y,z,color} objects ≈ 3 GB on a 50-image set) — never materializes. It's the
// spatial merge of `mergePointsSpatial` done incrementally: cells are anchored at
// the world origin (`floor(coord/cell)`), identical to that function, so the merged
// cells/averages match exactly. Storage is an open-addressing hash of numeric keys
// → slot idx plus parallel typed-array sums (60 B per *merged cell* ≈ one ground
// pixel, + ≤ 16 B of index; memBudget.js DENSIFY_CELL_BYTES). Cell keys are packed
// numerically — `(dix·ny+diy)·nz+diz`
// — from per-axis offsets/counts derived from `bounds`; the caller keeps the product
// < 2^53 (float64-exact) via clampCellForBounds. `bounds` may be a coarse estimate
// (fusion samples every 16th pixel): a point outside the packed grid goes to a small
// string-keyed **overflow** map with the same origin-anchored cell, so the merge stays
// exact for every input. Clamping it into the border cell instead collapsed thin, tall
// features the stride sampling missed (a pole's top 16 px all averaged into one cell).
// Exact bounds are not the alternative: one far sky flyer would stretch the box, and
// clampCellForBounds would then coarsen the merge cell for the whole scene.
// The index is NOT a JS Map: V8 caps a Map at 2^24 (16,777,216) entries and throws
// "Map maximum size exceeded" past it, which a large fused cloud reaches, and every
// Map entry lives on the ~4 GB V8 heap. Colour sums are Uint32 (exact for integer
// channels, as every caller passes) and normal sums Float32 (renormalized on output).
// `capacity` presizes the slot arrays and the table (fusion passes its measured cell
// count), so a run that stays within it never reallocates.
export function createVoxelAccumulator(cellSize, bounds, { capacity = 1024 } = {}) {
  const inv = 1 / cellSize
  const ix0 = Math.floor(bounds.minX * inv), iy0 = Math.floor(bounds.minY * inv), iz0 = Math.floor(bounds.minZ * inv)
  const ix1 = Math.floor(bounds.maxX * inv), iy1 = Math.floor(bounds.maxY * inv), iz1 = Math.floor(bounds.maxZ * inv)
  // Pad one cell each side so a point just past a coarse-estimated bound still packs
  // to a unique in-range key instead of aliasing onto the opposite face.
  const bx = ix0 - 1, by = iy0 - 1, bz = iz0 - 1
  const nx = (ix1 - ix0) + 3, ny = (iy1 - iy0) + 3, nz = (iz1 - iz0) + 3
  // Cells outside the packed grid, keyed `${dix},${diy},${diz}` in the same grid-relative
  // indices (negative or ≥ n* there). Empty for callers that pass exact bounds.
  const overflow = new Map()
  const inGrid = (dix, diy, diz) => dix >= 0 && dix < nx && diy >= 0 && diy < ny && diz >= 0 && diz < nz
  let cap = Math.max(16, Math.ceil(capacity)), n = 0, nGrid = 0
  // keyOf[s]: the packed key of an in-grid slot, −1 for an overflow slot.
  let keyOf = new Float64Array(cap)
  let sx = new Float64Array(cap), sy = new Float64Array(cap), sz = new Float64Array(cap)
  let sr = new Uint32Array(cap), sg = new Uint32Array(cap), sb = new Uint32Array(cap)
  // World-space normal sums (Phase: Poisson meshing). Averaging unit normals then
  // renormalizing is a valid orientation estimate; the k coincident shell points a
  // surface produces all carry ~the same normal, so the sum stays well-conditioned.
  let snx = new Float32Array(cap), sny = new Float32Array(cap), snz = new Float32Array(cap)
  let cnt = new Uint32Array(cap)
  let removed = 0 // cells zeroed by filterIsolated (WS4); excluded from count + finalize
  // Open-addressing index (linear probing): table[i] = slot, −1 = empty. Power-of-two
  // size, load kept ≤ ½.
  let tsize = 1
  while (tsize < 2 * cap) tsize *= 2
  let table = new Int32Array(tsize).fill(-1), tmask = tsize - 1
  // Table position holding `key`, or −1 − (the empty position where it belongs).
  const find = (key) => {
    const hi = Math.floor(key / 4294967296)
    let i = mix32(mix32(hi) ^ (key - hi * 4294967296)) & tmask
    for (;;) {
      const s = table[i]
      if (s === -1) return -1 - i
      if (keyOf[s] === key) return i
      i = (i + 1) & tmask
    }
  }
  const growTable = () => {
    tsize *= 2; table = new Int32Array(tsize).fill(-1); tmask = tsize - 1
    for (let s = 0; s < n; s++) if (keyOf[s] >= 0) table[-1 - find(keyOf[s])] = s
  }
  const lookup = (key) => { const i = find(key); return i >= 0 ? table[i] : undefined }
  const slotAt = (dix, diy, diz) => (inGrid(dix, diy, diz) ? lookup((dix * ny + diy) * nz + diz)
    : overflow.size ? overflow.get(`${dix},${diy},${diz}`) : undefined)
  const grow = () => {
    cap *= 2
    const g = (a, T) => { const b = new T(cap); b.set(a); return b } // tail zero-filled
    keyOf = g(keyOf, Float64Array)
    sx = g(sx, Float64Array); sy = g(sy, Float64Array); sz = g(sz, Float64Array)
    sr = g(sr, Uint32Array); sg = g(sg, Uint32Array); sb = g(sb, Uint32Array)
    snx = g(snx, Float32Array); sny = g(sny, Float32Array); snz = g(snz, Float32Array)
    cnt = g(cnt, Uint32Array)
  }
  // Occupied 26-neighbours of a cell, stopping at `need` (filterIsolated's probe).
  const neighbours = (dix, diy, diz, radius, need) => {
    let neigh = 0
    for (let ddx = -radius; ddx <= radius; ddx++) {
      for (let ddy = -radius; ddy <= radius; ddy++) {
        for (let ddz = -radius; ddz <= radius; ddz++) {
          if (ddx === 0 && ddy === 0 && ddz === 0) continue
          const ns = slotAt(dix + ddx, diy + ddy, diz + ddz)
          if (ns !== undefined && cnt[ns] > 0 && ++neigh >= need) return neigh
        }
      }
    }
    return neigh
  }
  // Slot → origin-anchored cell index along `axis` (0 x, 1 y, 2 z), the same
  // floor(coord/cell) the slot was keyed by. Overflow slots decode their string key
  // (reverse map built on first use; overflow is the rare thin-feature spill).
  let overflowKeyOf = null
  const cellIndex = (s, axis) => {
    const key = keyOf[s]
    let d
    if (key >= 0) d = axis === 0 ? Math.floor(key / (nz * ny)) : axis === 1 ? Math.floor(key / nz) % ny : key % nz
    else {
      if (!overflowKeyOf || overflowKeyOf.size !== overflow.size) overflowKeyOf = new Map([...overflow].map(([k, v]) => [v, k]))
      d = Number(overflowKeyOf.get(s).split(',')[axis])
    }
    return d + (axis === 0 ? bx : axis === 1 ? by : bz)
  }
  const inRange = (s, { axis, lo, hi }) => { const a = cellIndex(s, axis); return a >= lo && a < hi }
  return {
    // Normals (nx,ny,nz) are optional (world-space, unit) — omitted callers still
    // get the exact same cells/averages for the 6-float wire format.
    add(x, y, z, r, g, b, nx_ = 0, ny_ = 0, nz_ = 0) {
      const dix = Math.floor(x * inv) - bx
      const diy = Math.floor(y * inv) - by
      const diz = Math.floor(z * inv) - bz
      let s
      if (inGrid(dix, diy, diz)) {
        const key = (dix * ny + diy) * nz + diz
        const i = find(key)
        if (i >= 0) s = table[i]
        else { // fresh slot is zeroed
          if (n === cap) grow()
          s = n++; keyOf[s] = key; table[-1 - i] = s
          if (2 * ++nGrid > tsize) growTable()
        }
      } else {
        const key = `${dix},${diy},${diz}`
        s = overflow.get(key)
        if (s === undefined) { if (n === cap) grow(); s = n++; keyOf[s] = -1; overflow.set(key, s) }
      }
      sx[s] += x; sy[s] += y; sz[s] += z
      sr[s] += r; sg[s] += g; sb[s] += b
      snx[s] += nx_; sny[s] += ny_; snz[s] += nz_
      cnt[s]++
    },
    get count() { return n - removed },
    // Cells that fell outside `bounds` (kept exact in the overflow map). Non-zero means
    // the caller's bounds estimate missed real points — worth a log line, not an error.
    get overflowCells() { return overflow.size },
    // Bytes the accumulator holds (slot arrays at capacity + the index table) — the
    // figure fusion logs against its pre-flight projection.
    get bytes() { return cap * 60 + tsize * 4 },
    // Post-fusion isolated-cell removal (WS4): a real surface cell has occupied
    // neighbours; a lone low-support cell is fusion noise (a sky/vegetation flyer that
    // slipped the consistency gate). Only *low-support* cells (cnt ≤ maxSupport) are
    // tested — a ≥3-pixel cell is never a floater — so this stays O(noise tail), not
    // O(all cells). For each tested cell, probe the 26 (radius 1) neighbour keys
    // arithmetically; if fewer than `minNeighbors` are occupied, zero its count so the
    // finalizers skip it. Cell indices are recovered from the packed key (or parsed
    // from an overflow key; neighbours straddle the two maps). Returns the number removed.
    // Every verdict is taken against the unfiltered occupancy and applied afterwards, so
    // the result does not depend on cell order. That is what lets a tile decide its
    // own cells exactly from a one-cell halo (tiled fusion): a sequential pass let a
    // cell zeroed earlier change a later cell's verdict, a chain no fixed halo bounds.
    // `within` ({ axis, lo, hi }) tests only the cells in that cell-index range; the
    // rest still count as neighbours.
    filterIsolated({ radius = 1, minNeighbors = 2, maxSupport = 2, within = null } = {}) {
      const drop = []
      for (let s = 0; s < n; s++) {
        const key = keyOf[s]
        if (key < 0 || cnt[s] === 0 || cnt[s] > maxSupport || (within && !inRange(s, within))) continue
        const diz = key % nz
        const diy = Math.floor(key / nz) % ny
        const dix = Math.floor(key / (nz * ny))
        if (neighbours(dix, diy, diz, radius, minNeighbors) < minNeighbors) drop.push(s)
      }
      for (const [key, s] of overflow) {
        if (cnt[s] === 0 || cnt[s] > maxSupport || (within && !inRange(s, within))) continue
        const [dix, diy, diz] = key.split(',').map(Number)
        if (neighbours(dix, diy, diz, radius, minNeighbors) < minNeighbors) drop.push(s)
      }
      for (const s of drop) cnt[s] = 0
      removed += drop.length
      return drop.length
    },
    // Occupied cells inside `within` ({ axis, lo, hi } in origin-anchored cell indices).
    countWithin(within) {
      let c = 0
      for (let s = 0; s < n; s++) if (cnt[s] > 0 && inRange(s, within)) c++
      return c
    },
    // Drop every cell outside `within` (a tile's halo, once it has served as
    // neighbours), so `count` and the finalizers see the tile's own cells only.
    restrict(within) {
      let c = 0
      for (let s = 0; s < n; s++) if (cnt[s] > 0 && !inRange(s, within)) { cnt[s] = 0; c++ }
      removed += c
      return c
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
// The consistency check compares each reference only with the maps its depth frustum
// can reach (the cull below), in index order, and reads those planes through a
// byte-bounded cache (`opts.cacheBytes`, optimal eviction over the known request
// sequence — see below). Both are exact: a map whose box misses the
// reference's frustum by more than the ±consistencyPx window cannot produce a hit, and
// the surviving comparisons run in the same order, so the cloud is identical to
// fuseDepthMaps' (streamedProducts.test.js). Reading every other map for every
// reference was N² plane reads: 33 min of fusion on quarry's 347 maps.
export async function fuseDepthMapsStreamed(metas, loadMap, opts = {}, onLog = () => {}, hooks = {}) {
  // The comparison cache is part of the run's memory: an eighth of the budget, at
  // most 1 GiB, and counted in the fusion preflight's input term.
  const cacheBytes = opts.cacheBytes ?? Math.min(1024 ** 3, (opts.memBudgetBytes > 0 ? opts.memBudgetBytes : 4 * 1024 ** 3) / 8)
  const iterator = fusionSteps(metas, { ...opts, cacheBytes }, onLog, { ...hooks, streaming: true })
  // ci → { map, next }: `next` is the position in the request sequence where the
  // plane is wanted again. The whole sequence is known before the pass (each slab's
  // visit list and every reference's frustum cull), so eviction is Belady's MIN: drop
  // the plane wanted furthest ahead. LRU over index order thrashed (quarry: 39 k reads
  // for 56 k comparisons at ~150 cached planes). Only the policy changes; the planes
  // and their order of use do not, so neither does the cloud.
  const cache = new Map()
  let cached = 0, reads = 0, hits = 0, compared = 0, culled = 0
  const planeBytes = (m) => m.depth?.byteLength ?? 0
  const candidatesOf = (mi, corners, rad) => {
    const cand = []
    for (let ci = 0; ci < metas.length; ci++) {
      if (ci === mi) continue
      if (!corners[mi] || sliceMisses(corners[mi], metas[ci], rad + 1)) continue
      cand.push(ci)
    }
    return cand
  }
  let planSlab = -1, candByRef = null, nextUse = null, pos = 0
  const planSequence = ({ visits, corners }, rad) => {
    candByRef = new Map(visits.map((mi) => [mi, candidatesOf(mi, corners, rad)]))
    const seq = []
    for (const mi of visits) for (const ci of candByRef.get(mi)) seq.push(ci)
    nextUse = new Float64Array(seq.length)
    const later = new Map()
    for (let p = seq.length - 1; p >= 0; p--) { nextUse[p] = later.get(seq[p]) ?? Infinity; later.set(seq[p], p) }
    pos = 0
  }
  let next = iterator.next()
  while (!next.done) {
    const request = next.value
    if (typeof request === 'number') next = iterator.next(await loadMap(request))
    else {
      const { m, mi, minViews, minTriAngleDeg, maxCost, depthTolRel, consistencyPx, step, slab, slabIndex = 0, slabCount = 1 } = request
      const agree = new Uint32Array(m.width * m.height), angle = new Float64Array(agree.length)
      const C = cameraCenter(m), rad = Math.max(0, Math.round(consistencyPx))
      const loadComparison = hooks.loadDepth ?? loadMap
      if (slabIndex !== planSlab) { planSequence(request.plan, rad); planSlab = slabIndex }
      const cand = candByRef.get(mi)
      culled += metas.length - 1 - cand.length
      // The reference's eligible pixels (valid depth, cost-gated, in this slab) and their
      // world points, found once: the loop below used to unproject every pixel again for
      // every candidate and only then drop those outside the slab — with narrow slabs
      // that was most of the work. Same pixels, same order, same points.
      const W = m.width, elig = [], wp = []
      for (let v = 0; v < m.height; v += step) for (let u = 0; u < W; u += step) {
        const idx = v * W + u, d = m.depth[idx]
        if (!(d > 0) || m.cost[idx] > maxCost) continue
        const P = unprojectPixel(m, u, v, d)
        // Tiled fusion: only the pixels whose point lands in this slab (or its halo).
        if (slab) { const ca = Math.floor(P[slab.key] * slab.inv); if (ca < slab.lo || ca >= slab.hi) continue }
        elig.push(idx); wp.push(P.x, P.y, P.z)
      }
      for (let k = 0; k < cand.length; k++) {
        const ci = cand[k], want = nextUse[pos++]
        let entry = cache.get(ci)
        if (entry) { hits++; entry.next = want } else {
          entry = { map: await loadComparison(ci), next: want }; reads++
          cache.set(ci, entry); cached += planeBytes(entry.map)
          while (cached > cacheBytes && cache.size > 1) {
            let far = -1, farKey = -1
            for (const [cj, e] of cache) if (cj !== ci && e.next > far) { far = e.next; farKey = cj }
            if (farKey < 0) break
            cached -= planeBytes(cache.get(farKey).map); cache.delete(farKey)
          }
        }
        const other = entry.map
        compared++
        const otherC = cameraCenter(other)
        for (let e = 0; e < elig.length; e++) {
          const idx = elig[e]
          if (agree[idx] >= minViews && (minTriAngleDeg <= 0 || angle[idx] >= minTriAngleDeg)) continue
          const P = { x: wp[3 * e], y: wp[3 * e + 1], z: wp[3 * e + 2] }
          const p = project(other, P.x, P.y, P.z)
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
        hooks.onProgress?.(slabIndex * metas.length + mi + STREAMED_CHECK_SHARE * (k + 1) / cand.length,
          slabCount * metas.length, 'Checking depth consistency…')
      }
      next = iterator.next({ agree, angle })
    }
  }
  const stream = { compared, culled, reads, hits, cacheBytes }
  // A slab run (opts.slabIndices) hands its counters to the caller that merges them.
  if (!opts.slabIndices && !opts.planOnly) logFusionStream(onLog, stream)
  const out = next.value
  if (out && typeof out === 'object') out.stream = stream
  return out
}

export function logFusionStream(onLog, { compared, culled, reads, hits, cacheBytes, workers = 1 }) {
  onLog(`Fusion: consistency over ${compared} map pair(s) (${culled} culled as out of view); `
    + `${reads} plane reads, ${hits} cache hits (≤${formatBytes(cacheBytes)} cache${workers > 1 ? ` per worker, ${workers} workers` : ''})`, 'info', 'Dense')
}

// Measured fusion size: the distinct merge cells of every pixel fusion could keep —
// valid depth, cost ≤ maxCost, on the `step` grid, inside the region — at the real
// merge cell. An upper bound on the fused cloud (the consistency, parallax, grazing
// and isolated-cell filters only remove), measured instead of guessed from the pixel
// count: with a merge cell of one ground pixel, a surface seen by k views collapses
// ~k pixels into a cell, and that overlap is what a pixel-count guess cannot see.
// Distinct counting by hash sampling: a cell is tracked only while its hash's low
// `level` bits are zero, and the level rises whenever more than `sampleCap` cells
// are tracked, so memory stays bounded and the estimate is exact for small scenes
// (level 0) and within ~1/√sampleCap otherwise. Cells are identified by two
// independent hashes (53 bits), never by coordinates. Same origin-anchored cells as
// createVoxelAccumulator, so the count is the accumulator's.
// It also records what tiled fusion plans from (`tile` = { axis }): the distinct
// cells per cell index along the tile axis (`hist`, a Map over the sampled cells, so
// at most sampleCap entries), and per map the cell range
// along that axis of every pixel past the cost gate (`mapLo`/`mapHi`, ±∞ when none),
// region or not — a tile visits exactly the maps whose range reaches it.
// With `withCorners` it also keeps each map's depth-slice corners (`corners`, the
// frustum the streamed consistency check culls with), so the streamed runner knows
// every reference's comparison list before the pass starts.
function* fusionCellEstimateSteps(maps, { cell, step, maxCost, region, sampleCap, tile = null, withCorners = false }) {
  const inv = 1 / cell
  let level = 0, mask = 0, candidates = 0
  const seen = new Map() // sampled cell hash → its cell index along the tile axis
  const k = tile ? 'xyz'[tile.axis] : null
  const mapLo = new Float64Array(maps.length).fill(Infinity), mapHi = new Float64Array(maps.length).fill(-Infinity)
  const corners = withCorners ? new Array(maps.length).fill(null) : null
  for (let mi = 0; mi < maps.length; mi++) {
    const m = yield mi
    const { width: w, height: h, depth, cost } = m
    let lo = Infinity, hi = -Infinity
    for (let v = 0; v < h; v += step) {
      for (let u = 0; u < w; u += step) {
        const idx = v * w + u, d = depth[idx]
        if (!(d > 0) || cost[idx] > maxCost) continue
        const P = unprojectPixel(m, u, v, d)
        const ia = k ? Math.floor(P[k] * inv) : 0
        if (ia < lo) lo = ia
        if (ia > hi) hi = ia
        if (region && !regionContains(region, P.x, P.y, P.z)) continue
        candidates++
        const ix = Math.floor(P.x * inv) | 0, iy = Math.floor(P.y * inv) | 0, iz = Math.floor(P.z * inv) | 0
        const h1 = mix32(mix32(mix32(ix) ^ iy) ^ iz)
        if ((h1 & mask) !== 0) continue
        const h2 = mix32(mix32(mix32(iz ^ 0x5bd1e995) ^ ix) ^ iy) & 0x1fffff
        const key = h1 * 2097152 + h2
        if (!seen.has(key)) seen.set(key, ia)
        if (seen.size > sampleCap) {
          level++; mask = (2 ** level - 1) | 0
          for (const sk of seen.keys()) if ((Math.floor(sk / 2097152) & mask) !== 0) seen.delete(sk)
        }
      }
    }
    mapLo[mi] = lo; mapHi[mi] = hi
    if (corners) corners[mi] = sliceCorners(m, 0, w, 0, h)
  }
  const cells = Math.min(candidates, Math.ceil(seen.size * 2 ** level))
  let hist = null
  if (tile) {
    hist = new Map()
    for (const ia of seen.values()) hist.set(ia, (hist.get(ia) ?? 0) + 2 ** level)
  }
  return { cells, candidates, level, sampled: seen.size, hist, mapLo, mapHi, corners }
}

// Slabs along the tile axis, each holding at most `cap` estimated cells (one cell
// index over the cap stays one slab). `hist` maps a cell index along the axis to its
// estimated cell count. Edges are integer cell indices, so a merge cell belongs to
// exactly one slab, [lo, hi), and the outer slabs reach ±∞.
export function planFusionSlabs(hist, cap) {
  const idx = [...hist.keys()].sort((a, b) => a - b)
  const slabs = []
  let start = -Infinity, cur = 0
  for (const ia of idx) {
    const c = hist.get(ia)
    if (cur > 0 && cur + c > cap) { slabs.push({ lo: start, hi: ia, cells: cur }); start = ia; cur = 0 }
    cur += c
  }
  slabs.push({ lo: start, hi: Infinity, cells: cur })
  return slabs
}

// Fusion in three parts, so a run can be split over workers: the plan (every pre-pass
// over the maps, the preflight and the slab layout; serialisable), the slabs (any
// subset of the plan's, each independent and exact thanks to its halo), and the
// finish (merged counters → logs + summary). `opts.planOnly` returns the plan,
// `opts.plan` + `opts.slabIndices` run those slabs and return { parts, counters };
// without either, one call does all three, as before.
function* fusionSteps(maps, opts = {}, onLog = () => {}, hooks = {}) {
  const plan = opts.plan ?? (yield* fusionPlanSteps(maps, opts, onLog, hooks))
  if (plan.refused) return Object.assign(new Float32Array(0), { nrm: null, summary: null, refused: plan.refused })
  if (opts.planOnly) return plan
  const slabIdx = opts.slabIndices ?? plan.slabs.map((_, i) => i)
  const run = yield* fusionSlabSteps(maps, plan, slabIdx, onLog, hooks)
  if (opts.slabIndices) return run
  return finishFusion(plan, run.counters, run.parts, onLog, hooks)
}

function fusionGates(opts) {
  // depthTolRel/step are user-facing (DENSE_FUSE_DEFAULTS); consistencyPx is internal (tuning.js).
  const { consistencyPx = DENSE_TUNING.consistencyPx, depthTolRel = 0.01, step = 1 } = opts
  // WS4 geometric filters (0 disables each; fall back to DENSE_FUSE_DEFAULTS values).
  const minTriAngleDeg = opts.minTriAngleDeg ?? 2.0
  const maxIncidenceDeg = opts.maxIncidenceDeg ?? 80
  const removeIsolated = opts.removeIsolated ?? true
  // cos of the incidence gate; ≤0 or ≥90 ⇒ disabled (cosInc ≥ 0 always passes).
  const incidenceOn = maxIncidenceDeg > 0 && maxIncidenceDeg < 90
  const cosIncGate = incidenceOn ? Math.cos(maxIncidenceDeg * Math.PI / 180) : -1
  return { consistencyPx, depthTolRel, step, minTriAngleDeg, maxIncidenceDeg, removeIsolated, incidenceOn, cosIncGate }
}

function* fusionPlanSteps(maps, opts, onLog, hooks) {
  const gates = fusionGates(opts)
  const { consistencyPx, depthTolRel, step, removeIsolated } = gates

  // Cost histogram (sampled, one sort): the summary median and the weak-signal check.
  const costStats = yield* fusionCostSteps(maps)

  // Defaults when the user hasn't overridden them: minViews = min(2, nMaps−1) so a
  // 2-image project can still fuse (needs 1 agreeing view); maxCost = the fixed
  // default (fusionCostSteps says why it no longer adapts to the data).
  const minViews = opts.minViews != null ? opts.minViews : Math.max(1, Math.min(2, maps.length - 1))
  const maxCost = opts.maxCost ?? DENSE_FUSE_DEFAULTS.maxCost
  onLog(`Fusion: valid-pixel cost median ${costStats.median.toFixed(2)}, p70 ${costStats.p70.toFixed(2)} `
    + `(${costStats.n} px)`, 'info', 'Dense')
  // A real ZNCC match is ≥ ~0.55 (cost ≤ 0.45). A p70 above 0.55 means the
  // photoconsistency signal is weak across the whole set: the problem is upstream of
  // fusion, so say so.
  if (costStats.p70 > 0.55) {
    onLog(`Fusion: weak cost distribution — p70 ${costStats.p70.toFixed(2)} > 0.55 (most pixels match at ZNCC < 0.45). `
      + 'Check intrinsics / window size / working resolution.', 'warn', 'Dense')
  }

  onLog(`Fusion: ${maps.length} map(s), minViews ${minViews}, maxCost ${maxCost}, `
    + `depth tol ${(depthTolRel * 100).toFixed(1)}%, consistency ±${consistencyPx}px, step ${step}px`,
    'info', 'Dense')

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
        const P = unprojectPixel(m, u, v, d)
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
  const region = normalizeRegion(opts.region)

  // Tiles are slabs along the scene's longest axis, cut at merge-cell boundaries.
  const ext = [bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ]
  const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2
  const axKey = 'xyz'[axis]

  // Stage B pre-flight: measure the merged size, project the peak and refuse before
  // the expensive consistency pass. Runs in the worker because the cell count needs
  // every map's pixels at the real merge cell; a refusal returns normally (no
  // throw), so the caller still gets transferred buffers home.
  const est = yield* fusionCellEstimateSteps(maps, {
    cell: mergeCell, step, maxCost, region, sampleCap: DENSE_TUNING.fuseEstimateSampleCap, tile: { axis },
    withCorners: !!hooks.streaming,
  })
  const margin = est.level > 0 ? DENSE_TUNING.fuseEstimateMargin : 1
  const estCells = Math.ceil(est.cells * margin)
  // Per worker: its reference + comparison planes and its comparison cache.
  const inputBytes = densifyInputBytes(maps, { streamed: !!hooks.streaming }) + (hooks.streaming ? (opts.cacheBytes ?? 0) : 0)
  let proj = projectDensifyPeakBytes({ inputBytes, cells: estCells })
  const budget = opts.memBudgetBytes > 0 ? opts.memBudgetBytes : 0
  onLog(`Fusion: measured ${est.candidates.toLocaleString()} candidate px → ≤ ${estCells.toLocaleString()} `
    + `merge cells at ${mergeCell.toExponential(2)}${est.level ? ` (hash-sampled 1/${2 ** est.level}, +${Math.round((DENSE_TUNING.fuseEstimateMargin - 1) * 100)}% margin)` : ' (exact)'}; `
    + `projected peak ≈ ${formatBytes(proj.total)} (input ${formatBytes(proj.input)} + accumulator `
    + `${formatBytes(proj.accumulator)} + output ${formatBytes(proj.output)})`
    + (budget ? ` vs budget ${formatBytes(budget)}` : ''), 'info', 'Dense')
  const scaledHist = () => new Map([...est.hist].map(([ia, c]) => [ia, c * margin]))
  let slabs = [{ lo: -Infinity, hi: Infinity, cells: estCells }]
  let workers = 1
  // Parallel (`opts.parallel` workers, each running whole slabs): about one slab per
  // worker, each small enough that every worker can hold one slab's accumulator beside
  // the finished slabs.
  const parallel = Math.max(1, Math.floor(opts.parallel ?? 1))
  if (parallel > 1 && est.hist.size > 1) {
    const cap = maxFusionTileCells({ inputBytes, cells: estCells, budget: budget || Infinity, workers: parallel })
    // One slab per worker, balanced by cells: every extra cut makes the maps that span
    // it read and unprojected once more (17 slabs on quarry ran slower than one).
    const planned = cap > 0 ? planFusionSlabs(scaledHist(), Math.min(cap, Math.ceil(estCells / parallel))) : []
    if (planned.length > 1) {
      const largest = Math.max(...planned.map((s) => s.cells))
      const parProj = projectDensifyPeakBytes({ inputBytes, cells: estCells, tileCells: largest, workers: Math.min(parallel, planned.length) })
      if (!budget || parProj.total <= budget) {
        slabs = planned; proj = parProj; workers = Math.min(parallel, planned.length)
        onLog(`Fusion: ${slabs.length} slabs along ${axKey} on ${workers} workers (≤ ${Math.ceil(largest).toLocaleString()} cells each); `
          + `projected peak ≈ ${formatBytes(proj.total)} (accumulators ${formatBytes(proj.accumulator)} + finished slabs `
          + `${formatBytes(proj.finished)}; joining ${formatBytes(proj.assemble)})`, 'info', 'Dense')
      }
    }
  }
  // Over budget in one piece: build the cloud slab by slab, so only one slab's
  // accumulator is resident beside the finished slabs (already in the cloud's 27 B
  // layout). The cloud itself still has to fit, twice while the slabs are joined.
  if (workers === 1 && budget && proj.total > budget) {
    const cap = maxFusionTileCells({ inputBytes, cells: estCells, budget })
    if (cap > 0) {
      const planned = planFusionSlabs(scaledHist(), cap)
      const largest = Math.max(...planned.map((s) => s.cells))
      const tiledProj = projectDensifyPeakBytes({ inputBytes, cells: estCells, tileCells: largest })
      if (planned.length > 1 && tiledProj.total <= budget) {
        slabs = planned; proj = tiledProj
        onLog(`Fusion: one piece would need ${formatBytes(projectDensifyPeakBytes({ inputBytes, cells: estCells }).total)} — `
          + `fusing in ${slabs.length} slabs along ${axKey} (≤ ${Math.ceil(largest).toLocaleString()} cells each); `
          + `projected peak ≈ ${formatBytes(proj.total)} (accumulator ${formatBytes(proj.accumulator)} + finished slabs `
          + `${formatBytes(proj.finished)}; joining ${formatBytes(proj.assemble)})`, 'info', 'Dense')
      }
    }
  }
  if (budget && proj.total > budget) {
    onLog(`Fusion: projected peak ${formatBytes(proj.total)} exceeds the budget ${formatBytes(budget)} even in slabs `
      + `(the cloud alone is ${formatBytes(estCells * DENSIFY_CLOUD_BYTES_PER_CELL)}).`, 'error', 'Dense')
    onLog('Fusion: aborting before the consistency pass — projected memory exceeds the budget. '
      + 'Raise the point-density sample step to 2 (¼ the pixels), set a Region around the subject '
      + '(Tools ▸ Model), or build depth maps at a lower Quality; or raise the memory budget '
      + '(Settings ▸ Compute) if the machine has the RAM.', 'error', 'Dense')
    return { refused: { ...proj, budget, mergeCell } }
  }
  const tiled = slabs.length > 1
  // A slab also accumulates a halo as wide as the isolated-cell search, so every
  // neighbour of its own cells is exactly as occupied as in a single pass.
  const halo = tiled && removeIsolated ? DENSE_TUNING.isolatedRadius : 0
  // A slab visits only the maps with a pixel past the cost gate that lands in it or
  // its halo; a map with none is visited once, by the first slab, for the cull
  // accounting. With each map's slice corners a slab's visit list is its whole
  // sequence of plane requests (the streamed cache plans on it). Per-pixel culls
  // before a world point exists are counted by a map's first visiting slab.
  const nM = maps.length
  const firstSlab = new Int32Array(nM).fill(-1)
  const visits = slabs.map(({ lo, hi }, ti) => {
    const list = []
    for (let mi = 0; mi < nM; mi++) {
      const hasRange = est.mapLo[mi] <= est.mapHi[mi]
      if (!tiled || (hasRange ? est.mapHi[mi] >= lo - halo && est.mapLo[mi] < hi + halo : ti === 0)) {
        list.push(mi)
        if (firstSlab[mi] < 0) firstSlab[mi] = ti
      }
    }
    return list
  })
  // Streamed + tiled: each map's frustum corners over just the pixels landing in each
  // slab (+ halo), so a slab compares a map only with the views that can see ITS part of
  // it. The whole-map corners made every slab compare with every view that sees any of
  // the map — 17 slabs on quarry did 307 k comparisons for the single pass's 56 k. Exact
  // for the same reason the whole-map cull is: the box still covers every pixel the slab
  // considers. One more read of every map, only when tiled.
  let slabCorners = null
  if (tiled && hooks.streaming) {
    const inv = 1 / mergeCell, k = 'xyz'[axis]
    slabCorners = slabs.map(() => new Array(nM).fill(null))
    for (let mi = 0; mi < nM; mi++) {
      if (!(est.mapLo[mi] <= est.mapHi[mi])) continue
      const m = yield mi
      const { width: w, height: h, depth, cost } = m
      const box = slabs.map(() => [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]) // u0 u1 v0 v1 d0 d1
      for (let v = 0; v < h; v += step) {
        for (let u = 0; u < w; u += step) {
          const idx = v * w + u, d = depth[idx]
          if (!(d > 0) || cost[idx] > maxCost) continue
          const ca = Math.floor(unprojectPixel(m, u, v, d)[k] * inv)
          for (let ti = 0; ti < slabs.length; ti++) {
            if (ca < slabs[ti].lo - halo || ca >= slabs[ti].hi + halo) continue
            const b = box[ti]
            if (u < b[0]) b[0] = u; if (u > b[1]) b[1] = u
            if (v < b[2]) b[2] = v; if (v > b[3]) b[3] = v
            if (d < b[4]) b[4] = d; if (d > b[5]) b[5] = d
          }
        }
      }
      box.forEach((b, ti) => {
        if (!(b[5] > 0)) return
        const cs = []
        for (const d of [b[4], b[5]]) for (const u of [b[0], b[1]]) for (const v of [b[2], b[3]]) cs.push(unprojectPixel(m, u, v, d))
        slabCorners[ti][mi] = cs
      })
    }
  }
  return {
    nMaps: nM, gates, minViews, maxCost, costMedian: costStats.median, bounds, bboxStride, mergeCell, region,
    axis, slabs, tiled, halo, workers, visits, firstSlab, estCells, slabCorners,
    est: { mapLo: est.mapLo, mapHi: est.mapHi, corners: est.corners },
  }
}

const zeroFusionCounters = () => ({
  considered: 0, noDepth: 0, highCost: 0, failedConsistency: 0, kept: 0, lowParallax: 0, grazing: 0,
  outsideRegion: 0, mergedCells: 0, isolatedRemoved: 0, degenerate: 0, overflowCells: 0, accBytes: 0, cells: 0,
  noNormalMaps: 0,
})
// Counters of several slab runs as one (sums; the accumulator figure is the largest).
export function mergeFusionCounters(list) {
  const out = zeroFusionCounters()
  for (const c of list) for (const k of Object.keys(out)) out[k] = k === 'accBytes' ? Math.max(out[k], c[k]) : out[k] + c[k]
  return out
}

function* fusionSlabSteps(maps, plan, slabIdx, onLog, hooks) {
  const { consistencyPx, depthTolRel, step, minTriAngleDeg, removeIsolated, incidenceOn, cosIncGate } = plan.gates
  const { minViews, maxCost, bounds, mergeCell, region, axis, slabs, tiled, halo, visits, firstSlab, est } = plan
  const { onProgress } = hooks
  const inv = 1 / mergeCell, axKey = 'xyz'[axis]
  const unproject = unprojectPixel
  // Cameras for reprojection consistency checks.
  const cams = maps.map((m) => ({ R: m.R, t: m.t, K: m.K, m }))
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
  const counters = zeroFusionCounters()
  const parts = []
  const nT = slabs.length, nM = maps.length

  for (const ti of slabIdx) {
    const { lo, hi } = slabs[ti], loH = lo - halo, hiH = hi + halo
    const within = tiled ? { axis, lo, hi } : null
    const tT = now()
    let acc = createVoxelAccumulator(mergeCell, bounds, { capacity: Math.ceil(slabs[ti].cells * (tiled ? 1.05 : 1)) })
    for (const mi of visits[ti]) {
      const firstVisit = firstSlab[mi] === ti
      const m = yield mi
      const checks = hooks.streaming ? yield {
        mi, m, minViews, minTriAngleDeg, maxCost, depthTolRel, consistencyPx, step,
        slab: tiled ? { key: axKey, inv, lo: loH, hi: hiH } : null, slabIndex: ti, slabCount: nT,
        plan: { visits: visits[ti], corners: plan.slabCorners?.[ti] ?? est.corners },
      } : null
      const { width: w, height: h, depth, cost, rgb, normals } = m
      if (!normals && firstVisit) counters.noNormalMaps++
      // Camera centre C = −Rᵀt, for the view-direction normal fallback (stale caches).
      const C = rotToWorld(m, -m.t[0], -m.t[1], -m.t[2])
      let mapKept = 0, mapConsidered = 0
      let considered = 0, noDepth = 0, highCost = 0, failedConsistency = 0, kept = 0
      let lowParallax = 0, grazing = 0, outsideRegion = 0
      for (let v = 0; v < h; v += step) {
        // Throttled progress: done = mapIdx + rowsDone/h, so the bar glides within a map.
        if (onProgress) {
          const t = now()
          if (t - lastEmit >= DENSE_TUNING.fuseProgressMs) {
            lastEmit = t
            const base = hooks.streaming ? STREAMED_CHECK_SHARE : 0
            onProgress(ti * nM + mi + base + (1 - base) * v / h, nT * nM, m.name ?? m.uuid?.slice(0, 8) ?? '')
          }
        }
        for (let u = 0; u < w; u += step) {
          const idx = v * w + u
          const d = depth[idx]
          if (!(d > 0)) { if (firstVisit) { considered++; mapConsidered++; noDepth++ } continue }
          if (cost[idx] > maxCost) { if (firstVisit) { considered++; mapConsidered++; highCost++ } continue }
          const P = unproject(m, u, v, d)
          let own = true
          if (tiled) {
            const ca = Math.floor(P[axKey] * inv)
            if (ca < loH || ca >= hiH) continue
            own = ca >= lo && ca < hi
          }
          if (own) { considered++; mapConsidered++ }

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
          if (agree < minViews) { if (own) failedConsistency++; continue }
          if (minTriAngleDeg > 0 && maxAngle < minTriAngleDeg) { if (own) lowParallax++; continue }

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
              if (cosInc < cosIncGate) { if (own) grazing++; continue }
            }
          }

          if (region && !regionContains(region, P.x, P.y, P.z)) { if (own) outsideRegion++; continue }

          // Stream straight into the voxel merge — no raw point ever exists.
          const o = idx * 3
          acc.add(P.x, P.y, P.z, rgb[o], rgb[o+1], rgb[o+2], nwx, nwy, nwz)
          if (own) { kept++; mapKept++ }
        }
      }
      counters.considered += considered; counters.noDepth += noDepth; counters.highCost += highCost
      counters.failedConsistency += failedConsistency; counters.kept += kept; counters.lowParallax += lowParallax
      counters.grazing += grazing; counters.outsideRegion += outsideRegion
      onLog(`Fusion: ${m.name ?? m.uuid?.slice(0, 8) ?? '?'}${tiled ? ` (slab ${ti + 1}/${nT})` : ''} — ${mapKept}/${mapConsidered} px kept `
        + `(${(100 * mapKept / Math.max(1, mapConsidered)).toFixed(1)}%)`, 'debug', 'Dense')
    }

    // The slab's own cells: merged, then isolated-cell removal judged with the halo
    // as neighbours, then the halo dropped before finalizing.
    counters.mergedCells += within ? acc.countWithin(within) : acc.count
    // WS4 post-fusion isolated-cell removal: drop lone low-support cells (fusion noise
    // that slipped the per-pixel gates) with too few occupied neighbours.
    if (removeIsolated) {
      counters.isolatedRemoved += acc.filterIsolated({
        radius: DENSE_TUNING.isolatedRadius,
        minNeighbors: DENSE_TUNING.isolatedMinNeighbors,
        maxSupport: DENSE_TUNING.isolatedMaxSupport,
        within,
      })
    }
    if (within) acc.restrict(within)
    counters.overflowCells += acc.overflowCells
    counters.accBytes = Math.max(counters.accBytes, acc.bytes)
    const slabCells = acc.count
    counters.cells += slabCells
    const flat = acc.finalizeFlat()
    const fin = acc.finalizeNormals()
    counters.degenerate += fin.degenerate
    flat.nrm = fin.nrm
    acc = null // release the accumulator before the caller converts the slab
    if (tiled) {
      onLog(`Fusion: slab ${ti + 1}/${nT} (${axKey} cells ${Number.isFinite(lo) ? lo : '−∞'}…${Number.isFinite(hi) ? hi : '∞'}) → `
        + `${slabCells.toLocaleString()} points in ${((now() - tT) / 1000).toFixed(1)}s`, 'info', 'Dense')
    }
    if (hooks.onTile) hooks.onTile(flat, { index: ti, count: nT })
    else parts.push(flat)
  }
  return { parts, counters }
}

// Logs and summary of a fusion run from its (merged) counters; with `parts` (flat
// slabs, in slab order) it also joins the cloud — empty when the slabs went to onTile.
export function finishFusion(plan, counters, parts = [], onLog = () => {}, hooks = {}) {
  const { minViews, maxCost, mergeCell, region, estCells, tiled, bboxStride, slabs, nMaps } = plan
  const { minTriAngleDeg, maxIncidenceDeg, incidenceOn } = plan.gates
  const { considered, noDepth, highCost, failedConsistency, kept, lowParallax, grazing, outsideRegion,
    mergedCells, isolatedRemoved, degenerate, overflowCells, accBytes, cells, noNormalMaps } = counters
  const nT = slabs.length
  hooks.onProgress?.(nT * nMaps - 0.02 * nT * nMaps, nT * nMaps, 'Packing points…')

  // Where did the candidate pixels go? (kept + the cull buckets = considered.)
  const pct = (n) => (100 * n / Math.max(1, considered)).toFixed(1)
  onLog(`Fusion: ${considered} candidate px → ${kept} kept (${pct(kept)}%); culled `
    + `${noDepth} no-depth (${pct(noDepth)}%), ${highCost} cost>${maxCost} (${pct(highCost)}%), `
    + `${failedConsistency} <${minViews} views (${pct(failedConsistency)}%)`
    + `${minTriAngleDeg > 0 ? `, ${lowParallax} <${minTriAngleDeg}° parallax (${pct(lowParallax)}%)` : ''}`
    + `${incidenceOn ? `, ${grazing} >${maxIncidenceDeg}° grazing (${pct(grazing)}%)` : ''}`
    + `${region ? `, ${outsideRegion} outside the region (${pct(outsideRegion)}%)` : ''}`, 'info', 'Dense')

  // The voxel merge already collapsed the per-source-pixel "shell" duplicates (a
  // surface seen by k views → k coincident points → one averaged cell). Report it.
  if (overflowCells) {
    onLog(`Fusion: ${overflowCells} merged cell(s) lay outside the ${bboxStride}-px-sampled scene bounds `
      + '— merged exactly in the overflow map (thin features the bounds sample missed)', 'debug', 'Dense')
  }
  if (mergedCells !== kept) {
    onLog(`Fusion: spatial merge cell ${mergeCell.toExponential(2)} — ${kept} → ${mergedCells} pts `
      + `(−${kept - mergedCells} dupes, ${(100 * (kept - mergedCells) / Math.max(1, kept)).toFixed(1)}%)`,
      'info', 'Dense')
  }

  // Audit the pre-flight: how tight was the measured bound, and what did the
  // accumulator actually hold.
  onLog(`Fusion: ${mergedCells.toLocaleString()} merged cells vs the measured bound `
    + `${estCells.toLocaleString()} (${(100 * mergedCells / Math.max(1, estCells)).toFixed(0)}%); `
    + `accumulator held ${formatBytes(accBytes)}${tiled ? ' (largest slab)' : ''}`, 'info', 'Dense')
  if (isolatedRemoved) {
    onLog(`Fusion: isolated-cell removal — dropped ${isolatedRemoved} lone cell(s) `
      + `(${(100 * isolatedRemoved / Math.max(1, mergedCells)).toFixed(1)}% of merged)`, 'info', 'Dense')
  }

  let flat
  if (!parts.length) flat = Object.assign(new Float32Array(0), { nrm: null })
  else if (parts.length === 1) flat = parts[0]
  else {
    flat = new Float32Array(cells * 6)
    const nrm = new Float32Array(cells * 3)
    let o = 0
    for (const p of parts) { flat.set(p, o * 6); nrm.set(p.nrm, o * 3); o += p.length / 6 }
    flat.nrm = nrm
  }
  if (noNormalMaps) {
    onLog(`Fusion: ${noNormalMaps}/${nMaps} map(s) had no per-pixel normals — `
      + `used view-direction fallback (re-run depth maps to refresh)`, 'warn', 'Dense')
  }
  if (degenerate) {
    onLog(`Fusion: ${degenerate}/${cells} cell(s) had cancelling normals — set to (0,0,1)`, 'debug', 'Dense')
  }

  // Q3: a small, persistable summary so successive dense runs are comparable
  // (attached to the returned typed array — non-breaking for callers that iterate).
  const denom = Math.max(1, considered)
  flat.summary = {
    costMedian: plan.costMedian,
    keptPct: 100 * kept / denom,
    mergeCell,
    estimatedCells: estCells,
    mergedPct: kept ? 100 * (kept - mergedCells) / kept : 0,
    isolatedRemoved,
    slabs: nT,
    cullBreakdown: {
      noDepthPct: 100 * noDepth / denom,
      highCostPct: 100 * highCost / denom,
      lowViewsPct: 100 * failedConsistency / denom,
      lowParallaxPct: 100 * lowParallax / denom,
      grazingPct: 100 * grazing / denom,
      ...(region ? { outsideRegionPct: 100 * outsideRegion / denom } : {}),
    },
  }
  flat.count = cells
  return flat
}
