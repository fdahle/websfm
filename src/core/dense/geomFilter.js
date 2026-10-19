// The cross-view geometric consistency filter (COLMAP's `filter` pass) over Stage A's
// depth maps: candidate views (exact frustum cull + nearest-first order), the shared
// per-reference kernel (judgeReference), the in-memory and streamed drivers, packed
// masks, the filter's knobs (filterSettings / filterConfig), its log lines and the
// Stage A progress split (geomFilterLoopShare).

import { DENSE_TUNING } from '../tuning.js'
import { DEPTHMAP_DEFAULTS } from '../defaults.user.js'
import { formatBytes } from './memBudget.js'
import { cameraCenter } from '../sfm/geometry.js'
import { sliceCorners, sliceMisses } from './denseGeometry.js'
import { numOpt, boolOpt } from './denseOptions.js'
import { pluralize } from '../textFormat.js'

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
//     wholly behind drops it (camera depth is affine). The 1 px margin (CULL_MARGIN,
//     denseGeometry.js) absorbs rounding between this test and the per-pixel one.
//     Done per map, then per block: one stray
//     far depth (sky) stretches a whole map's slice over every other camera, so a
//     map-level cull alone cuts little on exactly the scenes this filter is for.
//   • ORDER — nearest camera centre first. A pixel is kept as soon as `minConsistent`
//     views agree, and agreeing views are the overlapping, i.e. nearby, ones; in index
//     order a good pixel of map 150 first walked 149 maps that cannot see it. The count
//     that decides the verdict does not depend on order.
const FILTER_BLOCK = 64

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
  const totals = emptyFilterTotals()
  let nCand = 0
  for (let mi = 0; mi < nMaps; mi++) {
    const m = maps[mi]
    const label = m.name ?? m.uuid?.slice(0, 8) ?? ''
    onProgress?.(mi, nMaps, label)
    const { cand, lists, need } = referencePlan(m, mi, maps, centres, cfg, checkViews)
    nCand += cand.length
    if (need < cfg.minConsistent) totals.clampedMaps++
    const depths = new Array(nMaps)
    for (const ci of cand) depths[ci] = maps[ci].depth
    const tMap = Date.now()
    m.filterStats = judgeReference(mi, m, cand, lists, maps, params, centres, cfg, need, checkViews, depths,
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
 * Candidate depth planes are cached in a byte-bounded LRU (`cacheBytes`): before each
 * read, planes the current reference does not need are evicted until the incoming one
 * fits, so the cache never holds more than max(cacheBytes, the current reference's
 * candidate planes) — a reference whose candidates alone exceed the bound still runs,
 * over it by exactly those. (Evicting only after all of a reference's candidates were
 * read let the previous reference's planes sit on top of them: up to ~2× the bound.)
 * `opts.refs` (indices) judges only those references — every reference is judged
 * against the same unfiltered planes, so disjoint subsets run in parallel workers give
 * exactly the full run's verdicts; `opts.summaryLogs: false` leaves the run-level log
 * lines to the caller that merges them (`logFilterTotals`).
 * Returns { masks: Uint8Array per map (bit-packed, 1 = drop), stats: per map, totals,
 * loads, hits, nCand, peakCached } (masks/stats only at the judged indices; peakCached
 * is the cache's high-water mark in bytes).
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
  let cached = 0, peakCached = 0, loads = 0, hits = 0
  // Evict least-recently-used planes outside `keep` until `incoming` more bytes fit.
  const evict = (keep, incoming) => {
    for (const [ci, plane] of cache) {
      if (cached + incoming <= cacheBytes) break
      if (keep.has(ci)) continue
      cache.delete(ci); cached -= plane.byteLength
    }
  }
  // A candidate's depth plane (Float32, width × height — the size the eviction makes
  // room for before the read).
  const depthOf = async (ci, keep) => {
    const hit = cache.get(ci)
    if (hit) { hits++; cache.delete(ci); cache.set(ci, hit); return hit }
    evict(keep, 4 * metas[ci].width * metas[ci].height)
    const plane = await io.loadDepth(ci)
    loads++
    cache.set(ci, plane); cached += plane.byteLength
    if (cached > peakCached) peakCached = cached
    return plane
  }
  const masks = new Array(nMaps), stats = new Array(nMaps)
  const totals = emptyFilterTotals()
  let nCand = 0
  const refs = opts.refs ?? Array.from({ length: nMaps }, (_, i) => i)
  for (let k = 0; k < refs.length; k++) {
    const mi = refs[k]
    const meta = metas[mi]
    const label = meta.name ?? meta.uuid?.slice(0, 8) ?? ''
    onProgress?.(k, refs.length, label)
    const { depth, cost } = await io.loadReference(mi)
    const ref = { ...meta, depth, cost }
    const { cand, lists, need } = referencePlan(ref, mi, metas, centres, cfg, checkViews)
    nCand += cand.length
    if (need < cfg.minConsistent) totals.clampedMaps++
    const depths = new Array(nMaps), keep = new Set(cand)
    for (const ci of cand) depths[ci] = await depthOf(ci, keep)
    const mask = new Uint8Array(meta.width * meta.height)
    const tMap = Date.now()
    stats[mi] = judgeReference(mi, ref, cand, lists, metas, params, centres, cfg, need, checkViews, depths,
      mask, totals, (frac) => onProgress?.(k + frac, refs.length, label))
    logReference(onLog, stats[mi], label, mi, nMaps, cand.length, cfg, tMap)
    masks[mi] = packBits(mask)
  }
  if (opts.summaryLogs !== false) {
    if (checkViews) logFilterCache(onLog, { nMaps, nCand, loads, hits, cacheBytes, cull: cfg.cull })
    logFilterTotals(onLog, totals, nMaps, cfg)
  }
  return { masks, stats, totals, loads, hits, nCand, peakCached }
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
// unset, blank or out-of-range ones) — shared by the worker op and the store that merges
// a split run. minConsistent 0 is the documented "off" (NCC floor only).
export function filterSettings(settings = {}) {
  return {
    maxGeomCost: numOpt(settings.maxGeomCost, DEPTHMAP_DEFAULTS.maxGeomCost, { positive: true }),
    minConsistent: numOpt(settings.minConsistent, DEPTHMAP_DEFAULTS.minConsistent, { int: true, min: 0 }),
    minNcc: numOpt(settings.minNcc, DEPTHMAP_DEFAULTS.minNcc, { min: -1, max: 1 }),
    minGeomAngleDeg: numOpt(settings.minGeomAngleDeg, DEPTHMAP_DEFAULTS.minGeomAngleDeg, { min: 0, max: 90 }),
  }
}

export function filterConfig(opts = {}) {
  const { minNcc, maxGeomCost, minConsistent, minGeomAngleDeg } = filterSettings(opts)
  const cull = boolOpt(opts.cull, true)
  return { minNcc, maxGeomCost, minConsistent, minGeomAngleDeg, cull,
    maxCostGate: 1 - minNcc, // ZNCC ncc ≥ minNcc  ⇔  cost ≤ 1 − minNcc
    angleOn: minGeomAngleDeg > 0, cosMinAngle: Math.cos(minGeomAngleDeg * Math.PI / 180) }
}

// The filter's run totals, zeroed (`clampedMaps`: references whose required view
// count was lowered by requiredConsistentViews). Summed key by key when a split run
// is merged.
export function emptyFilterTotals() {
  return { considered: 0, kept: 0, lowNcc: 0, inconsistent: 0, lowParallax: 0, clampedMaps: 0 }
}

// How many agreeing views one reference needs: `minConsistent`, but never more than
// the other views that overlap it at all (its frustum-cull candidates). Otherwise a
// two-image project — or an image at the survey's edge that overlaps one neighbour —
// has at most 1 possible witness, every pixel fails the default 2 and the depth maps
// come out empty. Clamped per reference, not per pixel or block, so a reference with
// many overlapping views keeps the full requirement everywhere (an edge strip only one
// of them sees is still dropped). Floor 1: a reference nothing overlaps keeps failing
// rather than passing unchecked. 0 stays 0 (the check is off).
export function requiredConsistentViews(minConsistent, nOverlapping) {
  if (!(minConsistent > 0)) return minConsistent
  return Math.min(minConsistent, Math.max(1, nOverlapping))
}

// Which views a reference is checked against, map level and per 64 px block, and how
// many of them must agree (`need`). A lone map has no cross-view evidence — the test
// is meaningless, not "everything fails". `need` is taken from the culled candidate
// count also when the cull is off, so the cull still never changes a verdict.
function referencePlan(ref, mi, others, centres, cfg, checkViews) {
  if (!checkViews) return { cand: [], lists: null, need: cfg.minConsistent }
  const culled = referenceCandidates(ref, mi, others, centres)
  const need = requiredConsistentViews(cfg.minConsistent, culled.length)
  if (!cfg.cull) return { cand: others.map((_, ci) => ci).filter((ci) => ci !== mi), lists: null, need }
  return { cand: culled, lists: blockCandidates(ref, others, culled), need }
}

// The per-pixel verdict for one reference map (the filter's whole kernel, shared by
// the in-memory and the streamed filter). `depths[ci]` is candidate ci's UNFILTERED
// depth plane; `others[ci]` its camera and size. Writes 1 = drop into `mask`,
// accumulates `totals`, returns the map's own counts.
function judgeReference(mi, ref, cand, plan, others, params, centres, cfg, minConsistent, checkViews, depths, mask, totals, onTick) {
  const { width: w, height: h, depth, cost } = ref
  const { maxCostGate, maxGeomCost, angleOn, cosMinAngle } = cfg
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
  if (t.clampedMaps > 0) {
    onLog(`Depth filter: ${t.clampedMaps} of ${pluralize(nMaps, 'map')} ${t.clampedMaps === 1 ? 'overlaps' : 'overlap'} fewer than ${cfg.minConsistent} other views — `
      + 'Consistent views lowered to the number they overlap (at least 1) for those maps', 'info', 'Dense')
  }
  onLog(`Depth filter: ${t.considered} px with depth → ${t.kept} kept (${pct(t.kept)}%); dropped `
    + `${t.lowNcc} NCC<${cfg.minNcc} (${pct(t.lowNcc)}%), `
    + `${t.inconsistent} <${cfg.minConsistent} consistent views @${cfg.maxGeomCost}px (${pct(t.inconsistent)}%)`
    + `${cfg.angleOn ? `, ${t.lowParallax} consistent only at <${cfg.minGeomAngleDeg}° parallax (${pct(t.lowParallax)}%)` : ''}`,
    'info', 'Dense')
}
