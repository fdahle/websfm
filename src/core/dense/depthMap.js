// Stage A, one reference image at a time: source-view selection, the sparse depth seed,
// the coarse-to-fine gray pyramid around the PatchMatch kernel (depthMapForImage, with
// its GPU↔CPU validation), the per-map speckle filter, quality presets and Stage A's
// knobs (depthMapSettings). The cross-view filter that follows is geomFilter.js.

import { computeDepthMap } from '../sfm/reconstruction.js'
import { planeCostRef, aggregateValidCosts } from './planeCost.js'
import { DENSE_TUNING } from '../tuning.js'
import { normalizeRegion } from '../products/region.js'
import { viewIndex, positionsInRegion } from './sparseInput.js'
import { DEPTHMAP_DEFAULTS } from '../defaults.user.js'
import { levelPerturbStarts } from './refineSchedule.js'
import { cameraCenter, triangulationAngle, toScaledPx } from '../sfm/geometry.js'
import { relativePose, project } from './denseGeometry.js'
import { numOpt, boolOpt } from './denseOptions.js'
import { projectDensePeakBytes, workingPixels } from './memBudget.js'
import { filterSettings } from './geomFilter.js'

// ── Stage A helpers ──────────────────────────────────────────────────────────

// Pick the best source views for a reference image: candidates that share the
// most sparse 3D points with the reference at a healthy parallax angle. Returns
// up to `maxSources` source uuids, best first.
//   cameras: Map<uuid, { R, t, K }>   sparse: the packed sparse input (sparseInput.js)
//   index: viewIndex(sparse) — pass the run's one index; built here when omitted.
// Walks only the points the reference sees: O(its observations), not O(points).
export function selectSourceViews(cameras, sparse, refUuid, opts = {}, index = viewIndex(sparse)) {
  // maxSources is user-facing (DEPTHMAP_DEFAULTS); the angle window is internal (tuning.js).
  const {
    maxSources = DEPTHMAP_DEFAULTS.maxSources,
    minAngleDeg = DENSE_TUNING.minAngleDeg,
    maxAngleDeg = DENSE_TUNING.maxAngleDeg,
  } = opts
  const refCam = cameras.get(refUuid)
  if (!refCam) return []
  const Cref = cameraCenter(refCam)
  const centers = new Map()
  const score = new Map()

  const { pos, vstart, vcam, viewUuids } = sparse
  const pt = { x: 0, y: 0, z: 0 }
  for (const i of index.get(refUuid) ?? []) {
    pt.x = pos[3 * i]
    pt.y = pos[3 * i + 1]
    pt.z = pos[3 * i + 2]
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
    const u = Math.round(p.u),
      v = Math.round(p.v)
    if (u < 0 || v < 0 || u >= width || v >= height) continue
    seed[v * width + u] = p.depth
    depths.push(p.depth)
  }
  if (depths.length < 2) return { seedDepth: seed, depthMin: 0, depthMax: 0 }
  depths.sort((a, b) => a - b)
  const at = (q) => depths[Math.min(depths.length - 1, Math.max(0, Math.round(q * (depths.length - 1))))]
  const lo = at(0.05),
    hi = at(0.95)
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

// 2× box-downsample a Uint8 grayscale plane. Floor dims (≥1): an odd last row/column is
// dropped, not squeezed in, so coarse pixel u is exactly fine pixels 2u…2u+1 and the
// coarse grid is the fine one at a factor of exactly ½ (halfScale). Returns { gray,w,h }.
function downsampleGray2x(gray, w, h) {
  const nw = Math.max(1, w >> 1),
    nh = Math.max(1, h >> 1)
  const out = new Uint8Array(nw * nh)
  for (let v = 0; v < nh; v++) {
    const v0 = 2 * v,
      v1 = Math.min(v0 + 1, h - 1)
    for (let u = 0; u < nw; u++) {
      const u0 = 2 * u,
        u1 = Math.min(u0 + 1, w - 1)
      out[v * nw + u] = (gray[v0 * w + u0] + gray[v0 * w + u1] + gray[v1 * w + u0] + gray[v1 * w + u1] + 2) >> 2
    }
  }
  return { gray: out, w: nw, h: nh }
}

// 2× max-pool a 0/1 exclusion mask: a downsampled texel is masked if ANY of its
// (up to) four contributors is masked (so a coarse warp can't sample near a
// frame/fiducial edge that the fine mask would have rejected).
function downsampleMaskMax2x(mask, w, h) {
  const nw = Math.max(1, w >> 1),
    nh = Math.max(1, h >> 1)
  const out = new Uint8Array(nw * nh)
  for (let v = 0; v < nh; v++) {
    const v0 = 2 * v,
      v1 = Math.min(v0 + 1, h - 1)
    for (let u = 0; u < nw; u++) {
      const u0 = 2 * u,
        u1 = Math.min(u0 + 1, w - 1)
      out[v * nw + u] = mask[v0 * w + u0] || mask[v0 * w + u1] || mask[v1 * w + u0] || mask[v1 * w + u1] ? 1 : 0
    }
  }
  return out
}

// The coarse/fine factor of a downsampleGray2x axis of `n` fine pixels: exactly ½ (the
// odd last pixel is cropped, not resampled), or 1 for a 1-px axis that cannot halve.
// floor(n/2)/n — what the level dims suggest — is NOT it on an odd axis: 20/41 put the
// far edge of a 41-px level half a coarse pixel off.
const halfScale = (n) => (n >= 2 ? 0.5 : 1)

// Nearest-neighbour upsample a depth plane cw×ch → fw×fh, the inverse of one
// downsampleGray2x step (edge-preserving: keeps depth discontinuities crisp for the next
// level's refinement to sharpen).
function upsampleDepthNearest(depth, cw, ch, fw, fh) {
  const out = new Float32Array(fw * fh)
  const sx = halfScale(fw),
    sy = halfScale(fh)
  for (let v = 0; v < fh; v++) {
    // Centre-aligned nearest (geometry.js toScaledPx): fine pixel centre v + ½ lands at
    // (v + ½)·½ on the coarse grid, i.e. coarse pixel ⌊v/2⌋; a cropped odd last row
    // takes the last coarse row.
    const sv = Math.min(ch - 1, ((v + 0.5) * sy) | 0)
    for (let u = 0; u < fw; u++) {
      const su = Math.min(cw - 1, ((u + 0.5) * sx) | 0)
      out[v * fw + u] = depth[sv * cw + su]
    }
  }
  return out
}

// Scale intrinsics with independent horizontal/vertical factors — one pyramid step is
// halfScale per axis, which differs only on a 1-px axis. The principal point moves by
// the centre-aligned rule (geometry.js toScaledPx).
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
export async function depthMapForImage(
  ref,
  sources,
  pos,
  settings = {},
  computeDepthMapFn = computeDepthMap,
  hooks = {},
) {
  // window/iterations/bestK are user-facing (DEPTHMAP_DEFAULTS); coarseLong is internal (tuning.js).
  const window = numOpt(settings.window, DEPTHMAP_DEFAULTS.window, { int: true, min: 1 })
  const iterations = numOpt(settings.iterations, DEPTHMAP_DEFAULTS.iterations, { int: true, min: 1 })
  const bestK = numOpt(settings.bestK, 3, { int: true, min: 1 })
  const coarseLong = numOpt(settings.coarseLong, DENSE_TUNING.coarseLong, { int: true, min: 1 })
  // Bilateral-weighted NCC (mvs.rs Bilateral): σc in grey levels (0 = plain NCC), σs in
  // px, by default the window radius (COLMAP's). The same at every pyramid level.
  const sigmaColor = numOpt(settings.bilateralSigmaColor, DENSE_TUNING.bilateralSigmaColor, { min: 0 })
  // Every other window row and column (mvs.rs Patch) when 2.
  const windowStep = numOpt(settings.windowStep, DENSE_TUNING.windowStep, { int: true, min: 1, max: 2 })
  const sigmaSpatial = numOpt(settings.bilateralSigmaSpatial, Math.min(5, Math.max(1, window)), { positive: true })
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
    gray: ref.gray,
    w: ref.width,
    h: ref.height,
    K: ref.K,
    srcs: src.map((s) => ({ gray: s.gray, w: s.w, h: s.h, K: s.K, R: s.R, t: s.t, mask: s.mask })),
  }
  const levels = [finest]
  for (let l = 1; l < nLevels; l++) {
    const cur = levels[0]
    const dr = downsampleGray2x(cur.gray, cur.w, cur.h)
    const level = {
      gray: dr.gray,
      w: dr.w,
      h: dr.h,
      K: scaleKxy(cur.K, halfScale(cur.w), halfScale(cur.h)),
      srcs: cur.srcs.map((s) => {
        const ds = downsampleGray2x(s.gray, s.w, s.h)
        return {
          gray: ds.gray,
          w: ds.w,
          h: ds.h,
          K: scaleKxy(s.K, halfScale(s.w), halfScale(s.h)),
          R: s.R,
          t: s.t,
          mask: s.mask ? downsampleMaskMax2x(s.mask, s.w, s.h) : null,
        }
      }),
    }
    levels.unshift(level)
  }

  // Coarse-to-fine sweep: seed the coarsest from the sparse cloud (the Region's points
  // when one is set, the same `seedPos` the depth range came from — a point outside it
  // would be clamped into the range and could overwrite a good seed on its pixel), then
  // upsample each level's depth as the next (finer) level's full-coverage seed. Coarser
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
  let dm = null,
    prevDepth = null,
    prevW = 0,
    prevH = 0
  // Refinement continues across levels rather than restarting (refineSchedule.js).
  const perturbStarts = levelPerturbStarts(levels.map((_, li) => iterations + (levels.length - 1 - li)))
  for (let li = 0; li < levels.length; li++) {
    const L = levels[li]
    let seedDepth
    if (li === 0) {
      const camL = { R: ref.cam.R, t: ref.cam.t, K: L.K }
      seedDepth = seedDepthFromSparse(camL, seedPos, L.w, L.h).seedDepth
    } else {
      seedDepth = upsampleDepthNearest(prevDepth, prevW, prevH, L.w, L.h)
    }
    const levelIters = iterations + (levels.length - 1 - li) // coarsest gets the most
    dm = await computeDepthMapFn(L.gray, L.w, L.h, L.K, L.srcs, {
      depthMin,
      depthMax,
      seedDepth,
      window,
      iterations: levelIters,
      bestK,
      seed: (baseSeed ^ (li * 0x9e3779b1)) >>> 0,
      perturbStart: perturbStarts[li],
      sigmaSpatial,
      sigmaColor,
      viewSelection: settings.viewSelection === 'acmh' ? 'acmh' : 'bestk',
      windowStep,
      threads: numOpt(settings.threads, 0, { int: true, min: 0 }),
    })
    if (!dm) return null
    prevDepth = dm.depth
    prevW = L.w
    prevH = L.h
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
    const srcCs = src.map((s) => ({
      gray: s.gray,
      w: s.w,
      h: s.h,
      fx: s.K.fx,
      fy: s.K.fy,
      cx: s.K.cx,
      cy: s.K.cy,
      R: s.R,
      t: s.t,
      mask: s.mask,
    }))
    const k = Math.min(Math.max(bestK, 1), srcCs.length) // reported best-K (upper bound)
    // Best-K aggregation matching the GPU's aggCost: exclude no-measurement
    // sources (INVALID sentinel) instead of averaging their max cost in.
    const aggRef = (u, v, depth, n) => {
      if (depth <= 0) return 2
      const cs = srcCs.map((sc) =>
        planeCostRef(refC, sc, u, v, depth, n, radius, { sigmaSpatial, sigmaColor }, windowStep),
      )
      return aggregateValidCosts(cs, bestK)
    }
    const stride = Math.max(1, Math.floor(dm.depth.length / 4000))
    const costs = []
    let sse = 0,
      max = 0,
      cnt = 0
    for (let i = 0; i < dm.depth.length; i += stride) {
      const u = i % ref.width,
        v = (i / ref.width) | 0
      const n = dm.normals ? [dm.normals[i * 3], dm.normals[i * 3 + 1], dm.normals[i * 3 + 2]] : [0, 0, -1]
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
    hooks.onLog?.(
      `GPU validate: cost consistency RMS ${rms.toExponential(2)} (max ${max.toExponential(2)}) ` +
        `over ${cnt} px; median final cost ${medCost.toFixed(3)} (${srcCs.length} src, best-${k})`,
      rms < 5e-3 ? 'success' : 'warn',
      'Dense',
    )
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
  const radius = numOpt(opts.radius, 1, { int: true, min: 1 })
  const relTol = numOpt(opts.relTol, DEPTHMAP_DEFAULTS.filterRelTol / 100, { positive: true })
  const minValidNeighbors = numOpt(opts.minValidNeighbors, 4, { int: true, min: 0 })
  const smooth = boolOpt(opts.smooth, true)
  const out = new Float32Array(depth.length)
  // The window's valid depths, kept sorted as they arrive (insertion into a fixed
  // buffer): a JS array pushed and comparator-sorted per pixel cost ~15 s on each
  // 27 MP map of a film block at High.
  const win = new Float64Array((2 * radius + 1) ** 2)
  let removed = 0,
    smoothed = 0
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const idx = v * w + u
      const d = depth[idx]
      if (!(d > 0)) continue // already a hole
      let n = 0
      for (let dv = -radius; dv <= radius; dv++) {
        const vv = v + dv
        if (vv < 0 || vv >= h) continue
        for (let du = -radius; du <= radius; du++) {
          const uu = u + du
          if (uu < 0 || uu >= w) continue
          const nd = depth[vv * w + uu]
          if (nd > 0) {
            let j = n++
            while (j > 0 && win[j - 1] > nd) {
              win[j] = win[j - 1]
              j--
            }
            win[j] = nd
          }
        }
      }
      if (n < minValidNeighbors) {
        removed++
        continue
      } // isolated → drop
      const med = win[n >> 1]
      if (Math.abs(d - med) > relTol * med) {
        removed++
        continue
      } // speckle → drop
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

// The highest depth quality at or below `quality` whose projected peak fits `budget`
// (memBudget.js projectDensePeakBytes over the images' real working sizes) — the
// depth stage steps down and says so rather than refusing, as fusion re-plans its
// step. `sizes`: [{ width, height }] of each image's working basis (native, or the
// film canonical frame). Returns { quality, maxDim, proj, steps } (steps = levels
// dropped) or null when not even Low fits; `proj` is the chosen level's projection.
export const DEPTH_QUALITY_ORDER = ['ultra', 'high', 'medium', 'low']
export function fitDepthQuality({
  quality,
  sizes,
  budget,
  backend = 'wasm',
  nSources = 6,
  streamMaps = true,
  geomConsistency = true,
}) {
  const nativeLong = sizes.reduce((m, s) => Math.max(m, s.width || 0, s.height || 0), 0)
  const start = Math.max(0, DEPTH_QUALITY_ORDER.indexOf(quality))
  for (let k = start; k < DEPTH_QUALITY_ORDER.length; k++) {
    const q = DEPTH_QUALITY_ORDER[k]
    const maxDim = qualityToMaxDim(q, nativeLong)
    const proj = projectDensePeakBytes({
      nImages: sizes.length,
      maxDim,
      nSources,
      backend,
      pixels: sizes.map((s) => workingPixels(s.width, s.height, maxDim)),
      retainedMaps: streamMaps ? 1 : sizes.length,
      filterMaps: geomConsistency && !streamMaps ? sizes.length : 0,
    })
    if (proj.total <= budget) return { quality: q, maxDim, proj, steps: k - start }
  }
  return null
}

// The view selection a run uses: the setting, with 'auto' (or blank) = ACMH on the GPU,
// best-K on the CPU, where ACMH costs several times the time (DEPTHMAP_DEFAULTS).
export function resolveViewSelection(setting, onGpu) {
  if (setting === 'acmh' || setting === 'bestk') return setting
  return onGpu ? 'acmh' : 'bestk'
}

// Per-image best-K from the number of available source views: average roughly the
// better half, clamped to [1, 4] (occlusion-robust without over-smoothing).
export function autoBestK(nSources) {
  return Math.min(4, Math.max(1, Math.ceil(nSources / 2)))
}

// Stage A's knobs (workers/ops/dense.js computeDepthMaps), read through the engine-
// boundary checks above: a blank / non-finite / out-of-range value takes its default.
// bestK null ⇒ auto per image; maxDim (the store resolves Quality into it) defaults to
// 800 px when absent. The cross-view filter's four come from filterSettings.
export function depthMapSettings(settings = {}) {
  return {
    quality: Object.hasOwn(QUALITY_FRACTION, settings.quality) ? settings.quality : DEPTHMAP_DEFAULTS.quality,
    maxDim: numOpt(settings.maxDim, 800, { int: true, min: 1 }),
    maxSources: numOpt(settings.maxSources, DEPTHMAP_DEFAULTS.maxSources, { int: true, min: 1 }),
    minAngleDeg: numOpt(settings.minAngleDeg, DENSE_TUNING.minAngleDeg, { min: 0, max: 90 }),
    window: numOpt(settings.window, DEPTHMAP_DEFAULTS.window, { int: true, min: 1 }),
    iterations: numOpt(settings.iterations, DEPTHMAP_DEFAULTS.iterations, { int: true, min: 1 }),
    bestK: numOpt(settings.bestK, null, { int: true, min: 1 }),
    speckleFilter: boolOpt(settings.speckleFilter, DEPTHMAP_DEFAULTS.speckleFilter),
    filterRadius: numOpt(settings.filterRadius, 1, { int: true, min: 1 }),
    filterRelTol: numOpt(settings.filterRelTol, DEPTHMAP_DEFAULTS.filterRelTol / 100, { positive: true }),
    coarseLong: numOpt(settings.coarseLong, DENSE_TUNING.coarseLong, { int: true, min: 1 }),
    geomConsistency: boolOpt(settings.geomConsistency, DEPTHMAP_DEFAULTS.geomConsistency),
    ...filterSettings(settings),
    streamMaps: boolOpt(settings.streamMaps, false),
  }
}
