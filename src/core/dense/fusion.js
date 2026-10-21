// Stage B's run: the slab pass (fusionSlabSteps — consistency check, normals, gates,
// voxel merge), the orchestration (fusionSteps: plan → slabs → finish), the counters a
// split run merges, finishFusion, and the two runners — resident fuseDepthMaps and
// fuseDepthMapsStreamed with its Belady comparison cache (+ streamedEligible). The plan
// and the map-request protocol the runners drive are fusionPlan.js (runWithMaps).

import { DENSE_TUNING } from '../tuning.js'
import { regionContains } from '../products/region.js'
import { formatBytes } from './memBudget.js'
import { cameraCenter, triangulationAngle } from '../sfm/geometry.js'
import { project, unprojectPixel, sliceMisses } from './denseGeometry.js'
import { createVoxelAccumulator } from './voxelAccumulator.js'
import { runWithMaps, fusionPlanSteps } from './fusionPlan.js'
import { nounFor, pluralize } from '../textFormat.js'

// ── Stage B: fusion ──────────────────────────────────────────────────────────

// Fuse per-image depth maps into a dense point cloud. Each map carries its
// reference pose + working K, the depth/cost planes, and an RGB buffer (colours
// at working resolution). A pixel's 3D point is kept only if it reprojects into
// at least `minViews` OTHER maps within `consistencyPx` and at a consistent depth
// (geometric consistency — the cross-view check the per-image PatchMatch omits).
//   maps: [{ uuid, width, height, K, R, t, depth:Float32Array, cost:Float32Array,
//            rgb:Uint8Array(w*h*3) }]
// Returns a flat Float32Array, 6 values per point (x, y, z, r, g, b — the voxel
// accumulator's layout), carrying `.nrm` (Float32Array, 3 per point, or null),
// `.summary` (the fusion counters) and `.count` (points). A run refused by the memory
// plan returns an empty array with `.refused` instead. `onLog(msg, level, category)`
// (optional) receives a breakdown of why pixels were kept or culled.
//
// Both runners execute the same fusion/voxel code. The async runner retains one
// reference map and a byte-bounded cache of comparison depth planes. Pair-major
// consistency preserves view order and the original early acceptance gates, using two
// scratch planes and the reference's eligible pixels (streamedEligible).
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
  const cacheBytes =
    opts.cacheBytes ?? Math.min(1024 ** 3, (opts.memBudgetBytes > 0 ? opts.memBudgetBytes : 4 * 1024 ** 3) / 8)
  const iterator = fusionSteps(metas, { ...opts, cacheBytes }, onLog, { ...hooks, streaming: true })
  // ci → { map, next }: `next` is the position in the request sequence where the
  // plane is wanted again. The whole sequence is known before the pass (each slab's
  // visit list and every reference's frustum cull), so eviction is Belady's MIN: drop
  // the plane wanted furthest ahead. LRU over index order thrashed (quarry: 39 k reads
  // for 56 k comparisons at ~150 cached planes). Only the policy changes; the planes
  // and their order of use do not, so neither does the cloud.
  const cache = new Map()
  let cached = 0,
    reads = 0,
    hits = 0,
    compared = 0,
    culled = 0,
    skipped = 0
  // Where a streamed run's time goes, for the timing line: plane reads, finding each
  // reference's eligible pixels, and the consistency comparisons.
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  let loadMs = 0,
    eligMs = 0,
    checkMs = 0
  const planeBytes = (m) => m.depth?.byteLength ?? 0
  // Nearest camera first: the views most likely to confirm a pixel come early, so most
  // pixels are settled after a few comparisons and the rest of the list runs on the
  // few still open, or not at all (below). The verdict does not depend on the order: a
  // pixel passes when enough views agree and one of them has the parallax, whichever
  // view comes first, and a failing pixel is compared with every view either way.
  const centres = metas.map((m) => cameraCenter(m))
  const candidatesOf = (mi, corners, rad) => {
    const cand = []
    for (let ci = 0; ci < metas.length; ci++) {
      if (ci === mi) continue
      if (!corners[mi] || sliceMisses(corners[mi], metas[ci], rad + 1)) continue
      cand.push(ci)
    }
    const c = centres[mi],
      d2 = (ci) => (centres[ci][0] - c[0]) ** 2 + (centres[ci][1] - c[1]) ** 2 + (centres[ci][2] - c[2]) ** 2
    const dist = new Map(cand.map((ci) => [ci, d2(ci)]))
    return cand.sort((a, b) => dist.get(a) - dist.get(b) || a - b)
  }
  let planSlab = -1,
    candByRef = null,
    nextUse = null,
    pos = 0
  const planSequence = ({ visits, corners }, rad) => {
    candByRef = new Map(visits.map((mi) => [mi, candidatesOf(mi, corners, rad)]))
    const seq = []
    for (const mi of visits) for (const ci of candByRef.get(mi)) seq.push(ci)
    nextUse = new Float64Array(seq.length)
    const later = new Map()
    for (let p = seq.length - 1; p >= 0; p--) {
      nextUse[p] = later.get(seq[p]) ?? Infinity
      later.set(seq[p], p)
    }
    pos = 0
  }
  let next = iterator.next()
  while (!next.done) {
    const request = next.value
    if (typeof request === 'number') {
      const t = now(),
        map = await loadMap(request)
      loadMs += now() - t
      next = iterator.next(map)
    } else {
      const {
        m,
        mi,
        minViews,
        minTriAngleDeg,
        maxCost,
        depthTolRel,
        consistencyPx,
        step,
        slab,
        slabIndex = 0,
        slabCount = 1,
      } = request
      const agree = new Uint32Array(m.width * m.height),
        angle = new Float64Array(agree.length)
      const C = cameraCenter(m),
        rad = Math.max(0, Math.round(consistencyPx))
      const loadComparison = hooks.loadDepth ?? loadMap
      if (slabIndex !== planSlab) {
        planSequence(request.plan, rad)
        planSlab = slabIndex
      }
      const cand = candByRef.get(mi)
      culled += metas.length - 1 - cand.length
      let t = now()
      const { idx: elig, wp } = streamedEligible(m, { step, maxCost, slab })
      eligMs += now() - t
      // The eligible pixels still open (not yet enough agreeing views, or no view with
      // the parallax), as positions in `elig`, compacted after every comparison. Once
      // none is left, the remaining views would change nothing: their planes are not read.
      const settled = (idx) => agree[idx] >= minViews && (minTriAngleDeg <= 0 || angle[idx] >= minTriAngleDeg)
      const open = new Int32Array(elig.length)
      let nOpen = 0
      for (let e = 0; e < elig.length; e++) if (!settled(elig[e])) open[nOpen++] = e
      for (let k = 0; k < cand.length; k++) {
        if (!nOpen) {
          pos += cand.length - k
          skipped += cand.length - k
          hooks.onProgress?.(
            slabIndex * metas.length + mi + STREAMED_CHECK_SHARE,
            slabCount * metas.length,
            'Checking depth consistency…',
          )
          break
        }
        const ci = cand[k],
          want = nextUse[pos++]
        let entry = cache.get(ci)
        if (entry) {
          hits++
          entry.next = want
        } else {
          t = now()
          entry = { map: await loadComparison(ci), next: want }
          reads++
          loadMs += now() - t
          cache.set(ci, entry)
          cached += planeBytes(entry.map)
          while (cached > cacheBytes && cache.size > 1) {
            let far = -1,
              farKey = -1
            for (const [cj, e] of cache)
              if (cj !== ci && e.next > far) {
                far = e.next
                farKey = cj
              }
            if (farKey < 0) break
            cached -= planeBytes(cache.get(farKey).map)
            cache.delete(farKey)
          }
        }
        const other = entry.map
        compared++
        t = now()
        const otherC = cameraCenter(other)
        let kept = 0
        for (let j = 0; j < nOpen; j++) {
          const e = open[j],
            idx = elig[e]
          const P = { x: wp[3 * e], y: wp[3 * e + 1], z: wp[3 * e + 2] }
          const p = project(other, P.x, P.y, P.z)
          if (!p) {
            open[kept++] = e
            continue
          }
          const cu = Math.round(p.u),
            cv = Math.round(p.v),
            tol = depthTolRel * p.depth
          let hit = false
          for (let dv = -rad; dv <= rad && !hit; dv++) {
            const y = cv + dv
            if (y < 0 || y >= other.height) continue
            for (let du = -rad; du <= rad; du++) {
              const x = cu + du
              if (x < 0 || x >= other.width) continue
              const od = other.depth[y * other.width + x]
              if (od > 0 && Math.abs(od - p.depth) <= tol) {
                hit = true
                break
              }
            }
          }
          if (hit) {
            agree[idx]++
            if (minTriAngleDeg > 0) angle[idx] = Math.max(angle[idx], triangulationAngle(C, otherC, P))
            if (settled(idx)) continue
          }
          open[kept++] = e
        }
        nOpen = kept
        checkMs += now() - t
        // The N comparisons dominate a streamed map's time: they take the first
        // 90% of its progress slot, the single fusion pass the rest (see fusionSteps).
        hooks.onProgress?.(
          slabIndex * metas.length + mi + (STREAMED_CHECK_SHARE * (k + 1)) / cand.length,
          slabCount * metas.length,
          'Checking depth consistency…',
        )
      }
      next = iterator.next({ agree, angle })
    }
  }
  const stream = { compared, culled, skipped, reads, hits, cacheBytes, loadMs, eligMs, checkMs }
  // A slab run (opts.slabIndices) hands its counters to the caller that merges them.
  if (!opts.slabIndices && !opts.planOnly) logFusionStream(onLog, stream)
  const out = next.value
  if (out && typeof out === 'object') out.stream = stream
  return out
}

// The reference's eligible pixels for the streamed consistency check (valid depth,
// cost-gated, on the step grid, and — tiled fusion — whose point lands in this slab or
// its halo) and their world points, found once: the check used to unproject every
// pixel again for every candidate and only then drop those outside the slab — with
// narrow slabs that was most of the work. Same pixels, same order, same points as the
// fusion pass. Two passes, count then fill, into exactly sized typed arrays: growable
// JS arrays (push) threw "Invalid array length" past V8's ~2^27-element limit — ~40 M
// eligible px, two 42-Mpx maps — and boxed 8 B per element on the way there.
// Returns { idx: Int32Array(n), wp: Float64Array(3n) } — 28 B per eligible pixel
// (memBudget.js densifyInputBytes charges it).
export function streamedEligible(m, { step, maxCost, slab = null }) {
  const W = m.width,
    H = m.height,
    { depth, cost } = m
  const inSlab = (u, v, d) => {
    const ca = Math.floor(unprojectPixel(m, u, v, d)[slab.key] * slab.inv)
    return ca >= slab.lo && ca < slab.hi
  }
  let n = 0
  for (let v = 0; v < H; v += step)
    for (let u = 0; u < W; u += step) {
      const i = v * W + u,
        d = depth[i]
      if (!(d > 0) || cost[i] > maxCost) continue
      if (!slab || inSlab(u, v, d)) n++
    }
  const idx = new Int32Array(n),
    wp = new Float64Array(3 * n)
  let e = 0
  for (let v = 0; v < H && e < n; v += step)
    for (let u = 0; u < W; u += step) {
      const i = v * W + u,
        d = depth[i]
      if (!(d > 0) || cost[i] > maxCost) continue
      const P = unprojectPixel(m, u, v, d)
      if (slab) {
        const ca = Math.floor(P[slab.key] * slab.inv)
        if (ca < slab.lo || ca >= slab.hi) continue
      }
      idx[e] = i
      wp[3 * e] = P.x
      wp[3 * e + 1] = P.y
      wp[3 * e + 2] = P.z
      e++
    }
  return { idx, wp }
}

export function logFusionStream(
  onLog,
  { compared, culled, skipped = 0, reads, hits, cacheBytes, workers = 1, loadMs = 0, eligMs = 0, checkMs = 0 },
) {
  onLog(
    `Fusion: consistency over ${pluralize(compared, 'map pair')} (${culled} culled as out of view, ` +
      `${skipped} skipped once every pixel was settled); ` +
      `${reads} plane reads, ${hits} cache hits (≤${formatBytes(cacheBytes)} cache${workers > 1 ? ` per worker, ${workers} workers` : ''})`,
    'info',
    'Dense',
  )
  onLog(
    `Fusion timing${workers > 1 ? ` (summed over ${workers} workers)` : ''}: reading maps ${secs(loadMs)}, ` +
      `eligible pixels ${secs(eligMs)}, consistency check ${secs(checkMs)}`,
    'info',
    'Dense',
  )
}
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`

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

const zeroFusionCounters = () => ({
  considered: 0,
  noDepth: 0,
  highCost: 0,
  failedConsistency: 0,
  kept: 0,
  lowParallax: 0,
  grazing: 0,
  outsideRegion: 0,
  mergedCells: 0,
  isolatedRemoved: 0,
  degenerate: 0,
  overflowCells: 0,
  accBytes: 0,
  cells: 0,
  noNormalMaps: 0,
  passMs: 0,
  finishMs: 0,
})
// Counters of several slab runs as one (sums; the accumulator figure is the largest).
export function mergeFusionCounters(list) {
  const out = zeroFusionCounters()
  for (const c of list)
    for (const k of Object.keys(out)) out[k] = k === 'accBytes' ? Math.max(out[k], c[k]) : out[k] + c[k]
  return out
}

function* fusionSlabSteps(maps, plan, slabIdx, onLog, hooks) {
  const { consistencyPx, depthTolRel, step, minTriAngleDeg, removeIsolated, incidenceOn, cosIncGate } = plan.gates
  const { minViews, maxCost, bounds, mergeCell, region, axis, slabs, tiled, halo, visits, firstSlab, est } = plan
  const { onProgress } = hooks
  const inv = 1 / mergeCell,
    axKey = 'xyz'[axis]
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
    x: m.R[0][0] * nx_ + m.R[1][0] * ny_ + m.R[2][0] * nz_,
    y: m.R[0][1] * nx_ + m.R[1][1] * ny_ + m.R[2][1] * nz_,
    z: m.R[0][2] * nx_ + m.R[1][2] * ny_ + m.R[2][2] * nz_,
  })
  const counters = zeroFusionCounters()
  const parts = []
  const nT = slabs.length,
    nM = maps.length

  for (const ti of slabIdx) {
    const { lo, hi } = slabs[ti],
      loH = lo - halo,
      hiH = hi + halo
    const within = tiled ? { axis, lo, hi } : null
    const tT = now()
    let acc = createVoxelAccumulator(mergeCell, bounds, { capacity: Math.ceil(slabs[ti].cells * (tiled ? 1.05 : 1)) })
    for (const mi of visits[ti]) {
      const firstVisit = firstSlab[mi] === ti
      const m = yield mi
      // Streamed: a check request ↔ { agree, angle } (protocol: fusionPlan.js runWithMaps).
      const checks = hooks.streaming
        ? yield {
            mi,
            m,
            minViews,
            minTriAngleDeg,
            maxCost,
            depthTolRel,
            consistencyPx,
            step,
            slab: tiled ? { key: axKey, inv, lo: loH, hi: hiH } : null,
            slabIndex: ti,
            slabCount: nT,
            plan: { visits: visits[ti], corners: plan.slabCorners?.[ti] ?? est.corners },
          }
        : null
      const { width: w, height: h, depth, cost, rgb, normals } = m
      if (!normals && firstVisit) counters.noNormalMaps++
      // Camera centre C = −Rᵀt, for the view-direction normal fallback (stale caches).
      const C = rotToWorld(m, -m.t[0], -m.t[1], -m.t[2])
      let mapKept = 0,
        mapConsidered = 0
      const tPass = now()
      let considered = 0,
        noDepth = 0,
        highCost = 0,
        failedConsistency = 0,
        kept = 0
      let lowParallax = 0,
        grazing = 0,
        outsideRegion = 0
      for (let v = 0; v < h; v += step) {
        // Throttled progress: done = mapIdx + rowsDone/h, so the bar glides within a map.
        if (onProgress) {
          const t = now()
          if (t - lastEmit >= DENSE_TUNING.fuseProgressMs) {
            lastEmit = t
            const base = hooks.streaming ? STREAMED_CHECK_SHARE : 0
            onProgress(ti * nM + mi + base + ((1 - base) * v) / h, nT * nM, m.name ?? m.uuid?.slice(0, 8) ?? '')
          }
        }
        for (let u = 0; u < w; u += step) {
          const idx = v * w + u
          const d = depth[idx]
          if (!(d > 0)) {
            if (firstVisit) {
              considered++
              mapConsidered++
              noDepth++
            }
            continue
          }
          if (cost[idx] > maxCost) {
            if (firstVisit) {
              considered++
              mapConsidered++
              highCost++
            }
            continue
          }
          const P = unproject(m, u, v, d)
          let own = true
          if (tiled) {
            const ca = Math.floor(P[axKey] * inv)
            if (ca < loH || ca >= hiH) continue
            own = ca >= lo && ca < hi
          }
          if (own) {
            considered++
            mapConsidered++
          }

          // Geometric consistency: reproject into other maps and require a pixel
          // within a `consistencyPx` radius whose depth agrees (relative tolerance).
          // The radius search makes the check robust to sub-pixel reprojection /
          // PatchMatch noise — a single rounded-pixel probe rejected most valid
          // points (and `consistencyPx` was previously inert: added to a world-unit
          // depth tolerance scaled by 1e-3, i.e. ≈0).
          const rad = Math.max(0, Math.round(consistencyPx))
          let agree = checks ? checks.agree[idx] : 0,
            maxAngle = checks ? checks.angle[idx] : 0
          for (let ci = 0; ci < cams.length && !checks; ci++) {
            const c = cams[ci]
            if (c.m === m) continue
            const p = project(c, P.x, P.y, P.z)
            if (!p) continue
            const cu = Math.round(p.u),
              cv = Math.round(p.v)
            const tol = depthTolRel * p.depth
            let hit = false
            for (let dv = -rad; dv <= rad && !hit; dv++) {
              const pv = cv + dv
              if (pv < 0 || pv >= c.m.height) continue
              for (let du = -rad; du <= rad; du++) {
                const pu = cu + du
                if (pu < 0 || pu >= c.m.width) continue
                const od = c.m.depth[pv * c.m.width + pu]
                if (od > 0 && Math.abs(od - p.depth) <= tol) {
                  hit = true
                  break
                }
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
          if (agree < minViews) {
            if (own) failedConsistency++
            continue
          }
          if (minTriAngleDeg > 0 && maxAngle < minTriAngleDeg) {
            if (own) lowParallax++
            continue
          }

          // World-space oriented normal: rotate the converged camera-frame normal
          // (nz<0 ⇒ facing camera ⇒ outward for aerial). No normals (stale cache) ⇒
          // view direction (C − P) normalized — always camera-facing, never skipped.
          let nwx, nwy, nwz
          if (normals) {
            const no = idx * 3
            const nw = rotToWorld(m, normals[no], normals[no + 1], normals[no + 2])
            nwx = nw.x
            nwy = nw.y
            nwz = nw.z
          } else {
            nwx = C.x - P.x
            nwy = C.y - P.y
            nwz = C.z - P.z
          }
          const nm = Math.hypot(nwx, nwy, nwz)
          if (nm > 1e-9) {
            nwx /= nm
            nwy /= nm
            nwz /= nm
          } else {
            nwx = 0
            nwy = 0
            nwz = 1
          }
          // Orient toward the camera that saw it. The kernels only keep n_z < 0 in the
          // camera frame, which is not the same as facing the ray for an off-axis
          // oblique surface — such a plane is only representable as −n, and its
          // homography is identical. Poisson needs outward (camera-facing) normals, and
          // averaging opposite normals in one voxel would cancel them.
          if (nwx * (C.x - P.x) + nwy * (C.y - P.y) + nwz * (C.z - P.z) < 0) {
            nwx = -nwx
            nwy = -nwy
            nwz = -nwz
          }

          // WS4 grazing-angle reject: the incidence angle between the surface normal and
          // the viewing ray (C − P). A grazing (edge-on) surface — thin vegetation shells,
          // silhouette fringes — is seen at ~90° incidence (cosInc ≈ 0), where depth is
          // least reliable. Cull below cos(maxIncidenceDeg). The view-direction fallback
          // normal (no per-pixel normal) equals the viewing ray, so cosInc = 1 and it is
          // never culled — the filter is automatically inert on stale/normal-less maps.
          if (incidenceOn) {
            let vx = C.x - P.x,
              vy = C.y - P.y,
              vz = C.z - P.z
            const vm = Math.hypot(vx, vy, vz)
            if (vm > 1e-9) {
              vx /= vm
              vy /= vm
              vz /= vm
              const cosInc = Math.abs(nwx * vx + nwy * vy + nwz * vz)
              if (cosInc < cosIncGate) {
                if (own) grazing++
                continue
              }
            }
          }

          if (region && !regionContains(region, P.x, P.y, P.z)) {
            if (own) outsideRegion++
            continue
          }

          // Stream straight into the voxel merge — no raw point ever exists.
          const o = idx * 3
          acc.add(P.x, P.y, P.z, rgb[o], rgb[o + 1], rgb[o + 2], nwx, nwy, nwz)
          if (own) {
            kept++
            mapKept++
          }
        }
      }
      counters.considered += considered
      counters.noDepth += noDepth
      counters.highCost += highCost
      counters.failedConsistency += failedConsistency
      counters.kept += kept
      counters.lowParallax += lowParallax
      counters.grazing += grazing
      counters.outsideRegion += outsideRegion
      counters.passMs += now() - tPass
      onLog(
        `Fusion: ${m.name ?? m.uuid?.slice(0, 8) ?? '?'}${tiled ? ` (slab ${ti + 1}/${nT})` : ''} — ${mapKept}/${mapConsidered} px kept ` +
          `(${((100 * mapKept) / Math.max(1, mapConsidered)).toFixed(1)}%)`,
        'debug',
        'Dense',
      )
    }

    // The slab's own cells: merged, then isolated-cell removal judged with the halo
    // as neighbours, then the halo dropped before finalizing.
    const tFinish = now()
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
    // Straight into the cloud's layout, releasing the accumulator on the way.
    const { degenerate, ...part } = acc.finalizeCloud()
    counters.degenerate += degenerate
    acc = null
    counters.finishMs += now() - tFinish
    if (tiled) {
      onLog(
        `Fusion: slab ${ti + 1}/${nT} (${axKey} cells ${Number.isFinite(lo) ? lo : '−∞'}…${Number.isFinite(hi) ? hi : '∞'}) → ` +
          `${slabCells.toLocaleString()} points in ${((now() - tT) / 1000).toFixed(1)}s`,
        'info',
        'Dense',
      )
    }
    if (hooks.onTile) hooks.onTile(part, { index: ti, count: nT })
    else parts.push(part)
  }
  return { parts, counters }
}

// Logs and summary of a fusion run from its (merged) counters; with `parts` (flat
// slabs, in slab order) it also joins the cloud — empty when the slabs went to onTile.
export function finishFusion(plan, counters, parts = [], onLog = () => {}, hooks = {}) {
  const { minViews, maxCost, mergeCell, region, estCells, tiled, bboxStride, slabs, nMaps } = plan
  const { minTriAngleDeg, maxIncidenceDeg, incidenceOn } = plan.gates
  const {
    considered,
    noDepth,
    highCost,
    failedConsistency,
    kept,
    lowParallax,
    grazing,
    outsideRegion,
    mergedCells,
    isolatedRemoved,
    degenerate,
    overflowCells,
    accBytes,
    cells,
    noNormalMaps,
    passMs,
    finishMs,
  } = counters
  const nT = slabs.length
  hooks.onProgress?.(nT * nMaps - 0.02 * nT * nMaps, nT * nMaps, 'Packing points…')

  // Where did the candidate pixels go? (kept + the cull buckets = considered.)
  const pct = (n) => ((100 * n) / Math.max(1, considered)).toFixed(1)
  onLog(
    `Fusion: ${considered} candidate px → ${kept} kept (${pct(kept)}%); culled ` +
      `${noDepth} no-depth (${pct(noDepth)}%), ${highCost} cost>${maxCost} (${pct(highCost)}%), ` +
      `${failedConsistency} <${minViews} views (${pct(failedConsistency)}%)` +
      `${minTriAngleDeg > 0 ? `, ${lowParallax} <${minTriAngleDeg}° parallax (${pct(lowParallax)}%)` : ''}` +
      `${incidenceOn ? `, ${grazing} >${maxIncidenceDeg}° grazing (${pct(grazing)}%)` : ''}` +
      `${region ? `, ${outsideRegion} outside the region (${pct(outsideRegion)}%)` : ''}`,
    'info',
    'Dense',
  )

  // The voxel merge already collapsed the per-source-pixel "shell" duplicates (a
  // surface seen by k views → k coincident points → one averaged cell). Report it.
  if (overflowCells) {
    onLog(
      `Fusion: ${pluralize(overflowCells, 'merged cell')} lay outside the ${bboxStride}-px-sampled scene bounds ` +
        '— merged exactly in the overflow map (thin features the bounds sample missed)',
      'debug',
      'Dense',
    )
  }
  if (mergedCells !== kept) {
    onLog(
      `Fusion: spatial merge cell ${mergeCell.toExponential(2)} — ${kept} → ${mergedCells} pts ` +
        `(−${kept - mergedCells} dupes, ${((100 * (kept - mergedCells)) / Math.max(1, kept)).toFixed(1)}%)`,
      'info',
      'Dense',
    )
  }

  // Audit the pre-flight: how tight was the measured bound, and what did the
  // accumulator actually hold.
  onLog(
    `Fusion: ${mergedCells.toLocaleString()} merged cells vs the measured bound ` +
      `${estCells.toLocaleString()} (${((100 * mergedCells) / Math.max(1, estCells)).toFixed(0)}%); ` +
      `accumulator held ${formatBytes(accBytes)}${tiled ? ' (largest slab)' : ''}`,
    'info',
    'Dense',
  )
  onLog(
    `Fusion timing${plan.workers > 1 ? ` (summed over ${plan.workers} workers)` : ''}: fusion pass ${secs(passMs)} ` +
      `(unproject, gates, merge), finishing slabs ${secs(finishMs)} (isolated cells, packing)`,
    'info',
    'Dense',
  )
  if (isolatedRemoved) {
    onLog(
      `Fusion: isolated-cell removal — dropped ${pluralize(isolatedRemoved, 'lone cell')} ` +
        `(${((100 * isolatedRemoved) / Math.max(1, mergedCells)).toFixed(1)}% of merged)`,
      'info',
      'Dense',
    )
  }

  // The slabs ({ count, pos, col, nrm }) as the flat [x,y,z,r,g,b] + normals that
  // in-process callers read. The worker takes the slabs through onTile instead.
  let flat
  if (!parts.length) flat = Object.assign(new Float32Array(0), { nrm: null })
  else {
    flat = new Float32Array(cells * 6)
    const nrm = new Float32Array(cells * 3)
    let o = 0
    for (const p of parts) {
      for (let i = 0; i < p.count; i++) {
        const d = (o + i) * 6,
          q = i * 3
        flat[d] = p.pos[q]
        flat[d + 1] = p.pos[q + 1]
        flat[d + 2] = p.pos[q + 2]
        flat[d + 3] = p.col[q]
        flat[d + 4] = p.col[q + 1]
        flat[d + 5] = p.col[q + 2]
      }
      nrm.set(p.nrm, o * 3)
      o += p.count
    }
    flat.nrm = nrm
  }
  if (noNormalMaps) {
    onLog(
      `Fusion: ${noNormalMaps}/${nMaps} ${nounFor(nMaps, 'map')} had no per-pixel normals — ` +
        `used view-direction fallback (re-run depth maps to refresh)`,
      'warn',
      'Dense',
    )
  }
  if (degenerate) {
    onLog(
      `Fusion: ${degenerate}/${cells} ${nounFor(cells, 'cell')} had cancelling normals — set to (0,0,1)`,
      'debug',
      'Dense',
    )
  }

  // Q3: a small, persistable summary so successive dense runs are comparable
  // (attached to the returned typed array — non-breaking for callers that iterate).
  const denom = Math.max(1, considered)
  flat.summary = {
    costMedian: plan.costMedian,
    keptPct: (100 * kept) / denom,
    mergeCell,
    estimatedCells: estCells,
    mergedPct: kept ? (100 * (kept - mergedCells)) / kept : 0,
    isolatedRemoved,
    slabs: nT,
    cullBreakdown: {
      noDepthPct: (100 * noDepth) / denom,
      highCostPct: (100 * highCost) / denom,
      lowViewsPct: (100 * failedConsistency) / denom,
      lowParallaxPct: (100 * lowParallax) / denom,
      grazingPct: (100 * grazing) / denom,
      ...(region ? { outsideRegionPct: (100 * outsideRegion) / denom } : {}),
    },
  }
  flat.count = cells
  return flat
}
