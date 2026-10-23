// Stage B's plan: every pre-pass over the depth maps before the consistency pass —
// cost statistics, the auto merge cell, scene bounds, the measured cell estimate —
// the memory preflight and the slab layout (planFusionSlabs), plus fusion's per-pixel
// gates. The plan object fusionPlanSteps returns is structured-cloned to slab workers:
// keep it plain data (objects, arrays, numbers incl. ±Infinity slab edges, typed
// arrays) — no functions or class instances. The slab pass and the runners are fusion.js.

import { DENSE_TUNING } from '../tuning.js'
import { normalizeRegion, regionContains } from '../products/region.js'
import { DENSE_FUSE_DEFAULTS } from '../defaults.user.js'
import {
  projectDensifyPeakBytes,
  densifyInputBytes,
  formatBytes,
  maxFusionTileCells,
  DENSIFY_CLOUD_BYTES_PER_CELL,
  MAX_BUDGET_BYTES,
  MAX_ACCUMULATOR_CELLS,
  MAX_CLOUD_POINTS,
} from './memBudget.js'
import { unprojectPixel, sliceCorners, sliceMisses } from './denseGeometry.js'
import { cameraCenter } from '../sfm/geometry.js'
import { mix32, clampCellForBounds } from './voxelAccumulator.js'
import { numOpt, boolOpt } from './denseOptions.js'
import { pluralize } from '../textFormat.js'

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
const knownValidCounts = (maps) => maps.length > 0 && maps.every((m) => !m.depth && Number.isInteger(m.validPx))

function* fusionCostSteps(maps, { maxSamples = DENSE_TUNING.fuseCostMaxSamples } = {}) {
  // The true valid count → a stride that caps the sample budget. Saved maps record it
  // (validPx, depthCoverage's count of depth > 0); resident ones are scanned for it.
  let totalValid = 0
  if (knownValidCounts(maps)) for (const m of maps) totalValid += m.validPx
  else
    for (let mi = 0; mi < maps.length; mi++) {
      const m = yield { light: mi }
      const { depth } = m
      for (let i = 0; i < depth.length; i++) if (depth[i] > 0) totalValid++
    }
  if (!totalValid) return { n: 0, p70: 0, median: 0 }
  const stride = Math.max(1, Math.floor(totalValid / maxSamples))
  const samples = new Float32Array(Math.ceil(totalValid / stride) + 1)
  let s = 0,
    vi = 0
  for (let mi = 0; mi < maps.length; mi++) {
    const m = yield { light: mi }
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

// ── The map-request protocol (fusion's generators ↔ their runners) ─────────────
// Every Stage B pass is a generator, so one body serves resident and streamed maps:
//   • yield mi (a number)  ⇒ the runner sends back map `mi` ({ width, height, K, R, t,
//     depth, cost, rgb?, normals? }). runWithMaps answers from a resident array;
//     fusion.js fuseDepthMapsStreamed answers with `await loadMap(mi)`.
//   • yield { light: mi }  ⇒ the same map, of which only { width, height, K, R, t, depth,
//     cost } will be read (every pre-pass here). A streamed runner may load just those
//     (hooks.loadLight): at High a map's colour and normals are 2/3 of its bytes, and
//     the pre-passes read every map five times.
//   • yield a check request (an object; only fusion.js fusionSlabSteps, only when
//     hooks.streaming) { mi, m, minViews, minTriAngleDeg, maxCost, depthTolRel,
//     consistencyPx, step, slab, slabIndex, slabCount, plan: { visits, corners } }
//     ⇒ the streamed runner runs the consistency check for reference `mi` and sends
//     back { agree: Uint32Array(w·h), angle: Float64Array(w·h) }. The runner plans its
//     comparison cache from `plan` when slabIndex changes and then consumes that plan
//     in order, so a slab must issue exactly one request per map of plan.visits, in
//     visits order (its nextUse positions are visits × each reference's cull).
// The generator's return value is the pass's result.
export function runWithMaps(iterator, maps) {
  let step = iterator.next()
  while (!step.done) step = iterator.next(maps[typeof step.value === 'number' ? step.value : step.value.light])
  return step.value
}
export function fusionCostStats(maps, options = {}) {
  return runWithMaps(fusionCostSteps(maps, options), maps)
}

// Auto voxel size for the spatial merge: the median ground-sample-distance across
// maps (median valid depth / fx = the world-space span of one pixel). One cell ≈ one
// pixel footprint, so cross-view overlap dedupes without discarding real resolution.
// Per map here (the bounds pass calls it, so it costs no read of its own), the median
// of the per-map values in mergeCellOf. Quickselect on a reused Float32Array: boxing
// every valid depth into a JS array and sorting it took ~0.5 s a map, three of quarry's
// four silent planning minutes. Same element of rank ⌊n/2⌋, so the same cell.
function mapGsd(m, scratch) {
  const { depth } = m
  const fx = m.K?.fx || 0
  if (!(fx > 0)) return null
  if (scratch.buf.length < depth.length) scratch.buf = new Float32Array(depth.length)
  const ds = scratch.buf
  let n = 0
  for (let i = 0; i < depth.length; i++) if (depth[i] > 0) ds[n++] = depth[i]
  if (!n) return null
  return selectRank(ds, n, n >> 1) / fx
}
function mergeCellOf(gsds) {
  if (!gsds.length) return 0
  gsds.sort((a, b) => a - b)
  return gsds[gsds.length >> 1]
}

// The value of rank k (0-based, ascending) among a[0..n): Hoare-partition quickselect,
// reorders a in place.
function selectRank(a, n, k) {
  let lo = 0,
    hi = n - 1
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1]
    let i = lo,
      j = hi
    while (i <= j) {
      while (a[i] < pivot) i++
      while (a[j] > pivot) j--
      if (i <= j) {
        const t = a[i]
        a[i] = a[j]
        a[j] = t
        i++
        j--
      }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else break
  }
  return a[k]
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
  let level = 0,
    mask = 0,
    candidates = 0
  const seen = new Map() // sampled cell hash → its cell index along the tile axis
  const k = tile ? 'xyz'[tile.axis] : null
  const mapLo = new Float64Array(maps.length).fill(Infinity),
    mapHi = new Float64Array(maps.length).fill(-Infinity)
  const corners = withCorners ? new Array(maps.length).fill(null) : null
  for (let mi = 0; mi < maps.length; mi++) {
    const m = yield { light: mi }
    const { width: w, height: h, depth, cost } = m
    let lo = Infinity,
      hi = -Infinity
    for (let v = 0; v < h; v += step) {
      for (let u = 0; u < w; u += step) {
        const idx = v * w + u,
          d = depth[idx]
        if (!(d > 0) || cost[idx] > maxCost) continue
        const P = unprojectPixel(m, u, v, d)
        const ia = k ? Math.floor(P[k] * inv) : 0
        if (ia < lo) lo = ia
        if (ia > hi) hi = ia
        if (region && !regionContains(region, P.x, P.y, P.z)) continue
        candidates++
        const ix = Math.floor(P.x * inv) | 0,
          iy = Math.floor(P.y * inv) | 0,
          iz = Math.floor(P.z * inv) | 0
        const h1 = mix32(mix32(mix32(ix) ^ iy) ^ iz)
        if ((h1 & mask) !== 0) continue
        const h2 = mix32(mix32(mix32(iz ^ 0x5bd1e995) ^ ix) ^ iy) & 0x1fffff
        const key = h1 * 2097152 + h2
        if (!seen.has(key)) seen.set(key, ia)
        if (seen.size > sampleCap) {
          level++
          mask = (2 ** level - 1) | 0
          for (const sk of seen.keys()) if ((Math.floor(sk / 2097152) & mask) !== 0) seen.delete(sk)
        }
      }
    }
    mapLo[mi] = lo
    mapHi[mi] = hi
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
// The views each map's consistency check may use when there are more overlapping maps
// than `maxViews` (DENSE_TUNING.fuseMaxViews): of the maps whose frustum reaches its
// depth slice (`corners`, the cull both fusion runners apply), the nearest cameras
// whose baseline gives `minTriAngleDeg` at the slice's mean depth first, then the
// nearest of the rest. A pixel is settled by its nearest few agreeing views, but one
// that fails was compared with every overlapping map: on 58 film maps at High (~50
// each, 108 MB a plane) that was 2,380 plane reads, 17 of fusion's 22 min. Per map an
// Int32Array of view indices, or null where the cap does not bite. Pure.
export function fusionViews(maps, corners, { maxViews, minTriAngleDeg = 0, rad = 0 }) {
  const centres = maps.map((m) => cameraCenter(m))
  return maps.map((_, mi) => {
    const cs = corners[mi]
    if (!cs) return new Int32Array(0)
    const c = centres[mi]
    const d2 = (ci) => (centres[ci][0] - c[0]) ** 2 + (centres[ci][1] - c[1]) ** 2 + (centres[ci][2] - c[2]) ** 2
    const cand = []
    for (let ci = 0; ci < maps.length; ci++) if (ci !== mi && !sliceMisses(cs, maps[ci], rad + 1)) cand.push(ci)
    if (cand.length <= maxViews) return null
    cand.sort((a, b) => d2(a) - d2(b) || a - b)
    const depth = cs.reduce((acc, P) => acc + Math.hypot(P.x - c[0], P.y - c[1], P.z - c[2]), 0) / cs.length
    const minBase = minTriAngleDeg > 0 ? 2 * depth * Math.tan((minTriAngleDeg * Math.PI) / 360) : 0
    const wide = cand.filter((ci) => Math.sqrt(d2(ci)) >= minBase),
      narrow = cand.filter((ci) => Math.sqrt(d2(ci)) < minBase)
    return Int32Array.from([...wide, ...narrow].slice(0, maxViews))
  })
}

export function planFusionSlabs(hist, cap) {
  const idx = [...hist.keys()].sort((a, b) => a - b)
  const slabs = []
  let start = -Infinity,
    cur = 0
  for (const ia of idx) {
    const c = hist.get(ia)
    if (cur > 0 && cur + c > cap) {
      slabs.push({ lo: start, hi: ia, cells: cur })
      start = ia
      cur = 0
    }
    cur += c
  }
  slabs.push({ lo: start, hi: Infinity, cells: cur })
  return slabs
}

// Fusion's per-pixel gates, read through the engine-boundary checks (numOpt): a blank,
// non-finite or out-of-range value takes its DENSE_FUSE_DEFAULTS / tuning value, and
// `step` is an integer ≥ 1 — the slab loops advance by it.
export function fusionGates(opts = {}) {
  // depthTolRel/step are user-facing (DENSE_FUSE_DEFAULTS); consistencyPx is internal (tuning.js).
  const consistencyPx = numOpt(opts.consistencyPx, DENSE_TUNING.consistencyPx, { min: 0, max: 64 })
  const depthTolRel = numOpt(opts.depthTolRel, DENSE_FUSE_DEFAULTS.depthTolPct / 100, { positive: true, max: 1 })
  const step = numOpt(opts.step, DENSE_FUSE_DEFAULTS.step, { int: true, min: 1, max: 1024 })
  // WS4 geometric filters (0 disables each).
  const minTriAngleDeg = numOpt(opts.minTriAngleDeg, DENSE_FUSE_DEFAULTS.minTriAngleDeg, { min: 0, max: 90 })
  const maxIncidenceDeg = numOpt(opts.maxIncidenceDeg, DENSE_FUSE_DEFAULTS.maxIncidenceDeg, { min: 0, max: 180 })
  const removeIsolated = boolOpt(opts.removeIsolated, DENSE_FUSE_DEFAULTS.removeIsolated)
  // cos of the incidence gate; ≤0 or ≥90 ⇒ disabled (cosInc ≥ 0 always passes).
  const incidenceOn = maxIncidenceDeg > 0 && maxIncidenceDeg < 90
  const cosIncGate = incidenceOn ? Math.cos((maxIncidenceDeg * Math.PI) / 180) : -1
  return { consistencyPx, depthTolRel, step, minTriAngleDeg, maxIncidenceDeg, removeIsolated, incidenceOn, cosIncGate }
}

// The pre-passes read every map once per pass (cost count, cost samples, bounds, cell
// estimate and, tiled + streamed, the slab outlines) and log nothing in between: on
// quarry's 347 saved maps that was minutes of a bar with no news. `hooks.onPlanProgress
// (done, total, label, fraction)` hears each read: done/total within the current pass,
// fraction over the whole plan (the last pass is only planned when streaming, so an
// untiled plan ends with a short jump; a re-plan at a coarser step re-counts).
// The plan's share of a fusion progress bar: on quarry (347 saved maps) the pre-passes
// are roughly a quarter of Stage B once the merge-cell pass stopped sorting boxed depths.
export const FUSION_PLAN_SHARE = 0.25
const PLAN_PASS_LABELS = [
  'cost statistics',
  'cost statistics',
  'scene bounds',
  'measuring the cloud size',
  'slab outlines',
]
export function* fusionPlanSteps(maps, opts, onLog, hooks = {}) {
  const report = hooks.onPlanProgress,
    n = maps.length
  const steps = planSteps(maps, opts, onLog, hooks)
  if (!report || !n) return yield* steps
  // The first cost pass is skipped when the maps record their valid counts.
  const skip = knownValidCounts(maps) ? 1 : 0
  const passes = (hooks.streaming ? 5 : 4) - skip
  let reads = 0,
    r = steps.next()
  while (!r.done) {
    const map = yield r.value
    if (typeof r.value === 'number' || r.value?.light !== undefined) {
      const pass = (Math.floor(reads / n) % passes) + skip
      reads++
      report(
        ((reads - 1) % n) + 1,
        n,
        `Planning fusion (${pass + 1 - skip}/${passes}): ${PLAN_PASS_LABELS[pass]}`,
        Math.min(0.99, reads / (n * passes)),
      )
    }
    r = steps.next(map)
  }
  return r.value
}

function* planSteps(maps, opts, onLog, hooks) {
  const gates = fusionGates(opts)
  const { consistencyPx, depthTolRel, step, removeIsolated } = gates

  // Cost histogram (sampled, one sort): the summary median and the weak-signal check.
  const costStats = yield* fusionCostSteps(maps)

  // Defaults when the user hasn't overridden them (null, or blank / out of range): minViews
  // = min(2, nMaps−1) so a 2-image project can still fuse (needs 1 agreeing view); maxCost
  // = the fixed default (fusionCostSteps says why it no longer adapts to the data);
  // Infinity is an explicit "no cost gate".
  const minViews = numOpt(opts.minViews, Math.max(1, Math.min(2, maps.length - 1)), { int: true, min: 1 })
  const maxCost = opts.maxCost === Infinity ? Infinity : numOpt(opts.maxCost, DENSE_FUSE_DEFAULTS.maxCost, { min: 0 })
  onLog(
    `Fusion: valid-pixel cost median ${costStats.median.toFixed(2)}, p70 ${costStats.p70.toFixed(2)} ` +
      `(${costStats.n} px)`,
    'info',
    'Dense',
  )
  // A real ZNCC match is ≥ ~0.55 (cost ≤ 0.45). A p70 above 0.55 means the
  // photoconsistency signal is weak across the whole set: the problem is upstream of
  // fusion, so say so.
  if (costStats.p70 > 0.55) {
    onLog(
      `Fusion: weak cost distribution — p70 ${costStats.p70.toFixed(2)} > 0.55 (most pixels match at ZNCC < 0.45). ` +
        'Check intrinsics / window size / working resolution.',
      'warn',
      'Dense',
    )
  }

  onLog(
    `Fusion: ${pluralize(maps.length, 'map')}, minViews ${minViews}, maxCost ${maxCost}, ` +
      `depth tol ${(depthTolRel * 100).toFixed(1)}%, consistency ±${consistencyPx}px, step ${step}px`,
    'info',
    'Dense',
  )

  // Scene bounds from a coarse valid-depth grid (fuseBboxStride-th row/col of each
  // map) — enough to size the voxel-key packing without a full unprojection pass.
  // The same read gives each map's GSD when the merge cell is automatic (mapGsd).
  // mergeCell: null ⇒ auto (median GSD); ≤0 ⇒ "disabled" — streamed as a tiny cell so
  // the flat output ≈ raw count but never a per-point object list (a true no-merge
  // would resurrect the OOM).
  const mergeOpt = numOpt(opts.mergeCell, null) // blank / non-finite ⇒ auto
  const gsds = mergeOpt > 0 ? null : [],
    gsdScratch = { buf: new Float32Array(0) }
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }
  const bboxStride = DENSE_TUNING.fuseBboxStride
  for (let mi = 0; mi < maps.length; mi++) {
    const m = yield { light: mi }
    if (gsds) {
      const g = mapGsd(m, gsdScratch)
      if (g != null) gsds.push(g)
    }
    const { width: w, height: h, depth } = m
    for (let v = 0; v < h; v += bboxStride) {
      for (let u = 0; u < w; u += bboxStride) {
        const d = depth[v * w + u]
        if (!(d > 0)) continue
        const P = unprojectPixel(m, u, v, d)
        if (P.x < bounds.minX) bounds.minX = P.x
        if (P.x > bounds.maxX) bounds.maxX = P.x
        if (P.y < bounds.minY) bounds.minY = P.y
        if (P.y > bounds.maxY) bounds.maxY = P.y
        if (P.z < bounds.minZ) bounds.minZ = P.z
        if (P.z > bounds.maxZ) bounds.maxZ = P.z
      }
    }
  }
  const hasBounds = Number.isFinite(bounds.minX)
  if (!hasBounds) {
    bounds.minX = bounds.minY = bounds.minZ = 0
    bounds.maxX = bounds.maxY = bounds.maxZ = 0
  }

  // Merge cell in world units (≈ one ground-sample-distance), clamped up if the
  // packed key would overflow float64.
  let mergeCell = mergeOpt != null ? mergeOpt : mergeCellOf(gsds)
  if (!(mergeCell > 0)) {
    const auto = mergeCellOf(gsds)
    mergeCell = (auto > 0 ? auto : 1) * 1e-3
    onLog(
      `Fusion: merge disabled — streaming near-unmerged at cell ${mergeCell.toExponential(2)} ` +
        `(flat output, no raw point objects)`,
      'warn',
      'Dense',
    )
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
  const maxViews = numOpt(opts.maxViews, DENSE_TUNING.fuseMaxViews, { int: true, min: 0 })
  const capViews = maxViews > 0 && maps.length - 1 > maxViews
  const est = yield* fusionCellEstimateSteps(maps, {
    cell: mergeCell,
    step,
    maxCost,
    region,
    sampleCap: DENSE_TUNING.fuseEstimateSampleCap,
    tile: { axis },
    withCorners: !!hooks.streaming || capViews,
  })
  const views = capViews
    ? fusionViews(maps, est.corners, {
        maxViews,
        minTriAngleDeg: gates.minTriAngleDeg,
        rad: Math.max(0, Math.round(gates.consistencyPx)),
      })
    : null
  const margin = est.level > 0 ? DENSE_TUNING.fuseEstimateMargin : 1
  const estCells = Math.ceil(est.cells * margin)
  // Per worker: its maps (streamed: the largest reference + its check buffers) and,
  // streamed, its comparison cache (memBudget.js densifyInputBytes).
  const inputBytes =
    densifyInputBytes(maps, { streamed: !!hooks.streaming }) + (hooks.streaming ? (opts.cacheBytes ?? 0) : 0)
  let proj = projectDensifyPeakBytes({ inputBytes, cells: estCells })
  // Never more than a tab can hold (memBudget.js), whatever the caller passed.
  const budget = opts.memBudgetBytes > 0 ? Math.min(opts.memBudgetBytes, MAX_BUDGET_BYTES) : 0
  onLog(
    `Fusion: measured ${est.candidates.toLocaleString()} candidate px → ≤ ${estCells.toLocaleString()} ` +
      `merge cells at ${mergeCell.toExponential(2)}${est.level ? ` (hash-sampled 1/${2 ** est.level}, +${Math.round((DENSE_TUNING.fuseEstimateMargin - 1) * 100)}% margin)` : ' (exact)'}; ` +
      `projected peak ≈ ${formatBytes(proj.total)} (input ${formatBytes(proj.input)} + accumulator ` +
      `${formatBytes(proj.accumulator)})` +
      (budget ? ` vs budget ${formatBytes(budget)}` : ''),
    'info',
    'Dense',
  )
  const scaledHist = () => new Map([...est.hist].map(([ia, c]) => [ia, c * margin]))
  let slabs = [{ lo: -Infinity, hi: Infinity, cells: estCells }]
  let workers = 1
  // Whatever the budget, no slab may need an accumulator past MAX_ACCUMULATOR_CELLS (its
  // index table would pass the browser's largest ArrayBuffer); a tiled slab's capacity
  // carries a 5% margin over its estimate (fusionSlabSteps). Both browser limits can be
  // lowered through `opts.limits` (tests: no test scene reaches the real ones).
  const maxAccCells = opts.limits?.accumulatorCells ?? MAX_ACCUMULATOR_CELLS
  const maxCloudPoints = opts.limits?.cloudPoints ?? MAX_CLOUD_POINTS
  const slabMax = Math.floor(maxAccCells / 1.05)
  const onePieceFits = estCells <= maxAccCells
  // Parallel (`opts.parallel` workers, each running whole slabs): about one slab per
  // worker, each small enough that every worker can hold one slab's accumulator beside
  // the finished slabs.
  const parallel = Math.max(1, Math.floor(opts.parallel ?? 1))
  if (parallel > 1 && est.hist.size > 1) {
    const cap = maxFusionTileCells({ inputBytes, cells: estCells, budget: budget || Infinity, workers: parallel })
    // One slab per worker, balanced by cells: every extra cut makes the maps that span
    // it read and unprojected once more (17 slabs on quarry ran slower than one).
    const planned = cap > 0 ? planFusionSlabs(scaledHist(), Math.min(cap, Math.ceil(estCells / parallel), slabMax)) : []
    if (planned.length > 1) {
      const largest = Math.max(...planned.map((s) => s.cells))
      const parProj = projectDensifyPeakBytes({
        inputBytes,
        cells: estCells,
        tileCells: largest,
        workers: Math.min(parallel, planned.length),
      })
      if (!budget || parProj.total <= budget) {
        slabs = planned
        proj = parProj
        workers = Math.min(parallel, planned.length)
        onLog(
          `Fusion: ${slabs.length} slabs along ${axKey} on ${workers} workers (≤ ${Math.ceil(largest).toLocaleString()} cells each); ` +
            `projected peak ≈ ${formatBytes(proj.total)} (accumulators ${formatBytes(proj.accumulator)} + finished slabs ` +
            `${formatBytes(proj.finished)}; joining ${formatBytes(proj.assemble)})`,
          'info',
          'Dense',
        )
      }
    }
  }
  // Over budget in one piece: build the cloud slab by slab, so only one slab's
  // accumulator is resident beside the finished slabs (already in the cloud's 27 B
  // layout). The cloud itself still has to fit, twice while the slabs are joined.
  if (workers === 1 && ((budget && proj.total > budget) || !onePieceFits)) {
    const cap = Math.min(budget ? maxFusionTileCells({ inputBytes, cells: estCells, budget }) : estCells, slabMax)
    if (cap > 0) {
      const planned = planFusionSlabs(scaledHist(), cap)
      const largest = Math.max(...planned.map((s) => s.cells))
      const tiledProj = projectDensifyPeakBytes({ inputBytes, cells: estCells, tileCells: largest })
      if (planned.length > 1 && (!budget || tiledProj.total <= budget)) {
        slabs = planned
        proj = tiledProj
        onLog(
          `Fusion: one piece would need ${formatBytes(projectDensifyPeakBytes({ inputBytes, cells: estCells }).total)} — ` +
            `fusing in ${slabs.length} slabs along ${axKey} (≤ ${Math.ceil(largest).toLocaleString()} cells each); ` +
            `projected peak ≈ ${formatBytes(proj.total)} (accumulator ${formatBytes(proj.accumulator)} + finished slabs ` +
            `${formatBytes(proj.finished)}; joining ${formatBytes(proj.assemble)})`,
          'info',
          'Dense',
        )
      }
    }
  }
  // Over budget even in slabs, or past what the browser can hold at all (a cloud whose
  // positions would not fit one ArrayBuffer, or a piece too large for one accumulator
  // that the scene gives no room to split): coarsen the sample grid before refusing.
  // Stage A has already been paid for (37 min on Casa Grande's 1978 film at High), and a
  // refusal left the user with 0 points and a DEM from the sparse cloud; a cloud at ¼ the
  // pixels is the useful outcome. Each doubling quarters the candidates; the plan is
  // re-measured, not extrapolated, because overlapping views share merge cells.
  // `autoStep: false` keeps the old refusal.
  const overBudget = budget && proj.total > budget
  const tooLarge = estCells > maxCloudPoints || (!onePieceFits && slabs.length === 1)
  const why = tooLarge
    ? `${estCells.toLocaleString()} merge cells are more than the browser can hold in one cloud ` +
      `(${maxCloudPoints.toLocaleString()} points; one piece at most ${maxAccCells.toLocaleString()} cells)`
    : `projected peak ${formatBytes(proj.total)} exceeds the budget ${formatBytes(budget)}`
  const autoStepMax = DENSE_TUNING.fuseAutoStepMax ?? 4
  if ((overBudget || tooLarge) && opts.autoStep !== false && step * 2 <= autoStepMax) {
    onLog(
      `Fusion: ${why} at sample step ${step}px — re-planning at step ${step * 2}px (¼ the pixels) instead of refusing`,
      'warn',
      'Dense',
    )
    return yield* planSteps(maps, { ...opts, step: step * 2 }, onLog, hooks)
  }
  if (tooLarge) {
    onLog(`Fusion: ${why}.`, 'error', 'Dense')
    onLog(
      'Fusion: aborting before the consistency pass. Raise the point-density sample step, set a Region around ' +
        'the subject (Tools ▸ Model), raise the merge cell, or build depth maps at a lower Quality.',
      'error',
      'Dense',
    )
    return { refused: { ...proj, budget, mergeCell, maxCloudPoints } }
  }
  if (overBudget) {
    onLog(
      `Fusion: projected peak ${formatBytes(proj.total)} exceeds the budget ${formatBytes(budget)} even in slabs ` +
        `(the cloud alone is ${formatBytes(estCells * DENSIFY_CLOUD_BYTES_PER_CELL)}).`,
      'error',
      'Dense',
    )
    onLog(
      'Fusion: aborting before the consistency pass — projected memory exceeds the budget. ' +
        'Raise the point-density sample step to 2 (¼ the pixels), set a Region around the subject ' +
        '(Tools ▸ Model), or build depth maps at a lower Quality; or raise the memory budget ' +
        `(Settings ▸ Compute, at most ${formatBytes(MAX_BUDGET_BYTES)}) if the machine has the RAM.`,
      'error',
      'Dense',
    )
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
    const inv = 1 / mergeCell,
      k = 'xyz'[axis]
    slabCorners = slabs.map(() => new Array(nM).fill(null))
    for (let mi = 0; mi < nM; mi++) {
      if (!(est.mapLo[mi] <= est.mapHi[mi])) continue
      const m = yield { light: mi }
      const { width: w, height: h, depth, cost } = m
      const box = slabs.map(() => [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]) // u0 u1 v0 v1 d0 d1
      for (let v = 0; v < h; v += step) {
        for (let u = 0; u < w; u += step) {
          const idx = v * w + u,
            d = depth[idx]
          if (!(d > 0) || cost[idx] > maxCost) continue
          const ca = Math.floor(unprojectPixel(m, u, v, d)[k] * inv)
          for (let ti = 0; ti < slabs.length; ti++) {
            if (ca < slabs[ti].lo - halo || ca >= slabs[ti].hi + halo) continue
            const b = box[ti]
            if (u < b[0]) b[0] = u
            if (u > b[1]) b[1] = u
            if (v < b[2]) b[2] = v
            if (v > b[3]) b[3] = v
            if (d < b[4]) b[4] = d
            if (d > b[5]) b[5] = d
          }
        }
      }
      box.forEach((b, ti) => {
        if (!(b[5] > 0)) return
        const cs = []
        for (const d of [b[4], b[5]])
          for (const u of [b[0], b[1]]) for (const v of [b[2], b[3]]) cs.push(unprojectPixel(m, u, v, d))
        slabCorners[ti][mi] = cs
      })
    }
  }
  return {
    nMaps: nM,
    gates,
    minViews,
    maxCost,
    costMedian: costStats.median,
    bounds,
    bboxStride,
    mergeCell,
    region,
    axis,
    slabs,
    tiled,
    halo,
    workers,
    visits,
    firstSlab,
    estCells,
    slabCorners,
    views,
    est: { mapLo: est.mapLo, mapHi: est.mapHi, corners: hooks.streaming ? est.corners : null },
  }
}
