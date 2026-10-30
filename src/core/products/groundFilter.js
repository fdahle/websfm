// Ground classification by cloth simulation (Tools ▸ Point Cloud ▸ Classify
// ground). Pure, no Vue/Pinia/OPFS/DOM — plain data in, plain data out, side
// effects via the injected `onLog` / `onProgress`.
//
// Why it exists: a DEM bins every point, so it is a DSM (roofs, canopy). A bare-
// earth DTM needs to know which points are ground. This labels them with the
// ASPRS LAS classes, so the result is also what GIS tools expect on export:
//   0 never classified (outside the classified extent)
//   1 unclassified     (above the cloth: vegetation, buildings, objects)
//   2 ground           (within `classThreshold` of the cloth)
//   7 low point        (more than `classThreshold` below the cloth: noise)
//
// Method: CSF, Zhang et al. 2016, "An Easy-to-Use Airborne LiDAR Data Filtering
// Method Based on Cloth Simulation". The paper drops a cloth onto the cloud turned
// upside down. Here the cloud stays upright and the cloth rises from beneath it,
// which is the same simulation mirrored in z:
//   1. A grid of particles (spacing `clothResolution`) starts below the lowest
//      point. Each cell's collision height H is the lowest point in it (after a
//      despike of isolated one-cell dips, so a single low outlier does not pin
//      the cloth); cells without points take the nearest measured cell's H.
//   2. Each iteration moves every free particle up under constant "gravity"
//      (Verlet with damping), then pulls it towards its spring neighbours: the
//      8 around it and the 8 two steps away (the reference implementation's
//      structural, shear and bending springs). Two free particles each move
//      ½(1 − 0.4^r) of their height difference, a free one beside a pinned one
//      1 − 0.7^r of it, for rigidness r — the reference code's lookup tables,
//      which are r repeated moves of 0.3. Only the vertical moves (the paper's
//      simplification).
//   3. A particle that reaches H is set to H and pinned. The run stops when no
//      free particle moved more than `convergence`, or after `maxIterations`.
//   4. Optional slope post-processing: pinning spreads from pinned particles to
//      free neighbours whose collision height differs from theirs by less than
//      `slopeThreshold` — continuous ground — so a stiff cloth that settled below
//      a steep flank is pulled onto it. Walls are larger steps and stop it.
//   5. Each point compares its height with the cloth (bilinear between particle
//      centres) and takes its class from the difference.
//
// Units: everything is in frame units and must be metres for the defaults to
// mean anything; the caller refuses model units. Positions are interleaved xyz in
// the PRODUCT FRAME (z = up), as `dem.js` stageDemPoints produces them.
//
// Dense-scale invariant: typed arrays only, no per-point objects; the input is
// never mutated. Cost is O(points) for the cell heights and the classification,
// plus O(particles · iterations) for the cloth (16 springs per particle).

import { coreExtent } from './dem.js'
import { classifyAboveGround } from './pointClasses.js'
import { CLASSIFY_DEFAULTS } from '../defaults.user.js'
import { CLASSIFY_TUNING } from '../tuning.js'

export const CLASS_NEVER = 0
export const CLASS_UNCLASSIFIED = 1
export const CLASS_GROUND = 2
export const CLASS_LOW_POINT = 7

// Verlet constants from the reference implementation (CSF, Cloth.h/Particle.h),
// expressed per iteration: displacement from gravity per step² (in metres, so a
// frame in feet simulates the same cloth) and the share of the previous step's
// velocity lost each step.
const GRAVITY_STEP = 0.2 * 0.65 * 0.65
const DAMPING = 0.01
// The cloth starts this far (m) below the lowest collision height, so every
// particle moves before any can pin.
const START_DEPTH = 1

// Bounds-checked defaults; `classifyGround` documents each option.
export const GROUND_FILTER_LIMITS = {
  minResolution: 1e-6,
  // Particle cap: the cloth's working memory is ~40 B per particle, and its time
  // grows linearly with the particle count. Above this the resolution is coarsened
  // (and the log says so) rather than running for minutes.
  maxParticles: 4_000_000,
}

// Heights of the lowest point per cell, NaN where none fell. Returns Float64Array.
function lowestPerCell(pos, count, grid, inside) {
  const { width, height, x0, y0, res } = grid
  const H = new Float64Array(width * height).fill(NaN)
  for (let i = 0; i < count; i++) {
    if (inside && !inside[i]) continue
    const x = pos[i * 3],
      y = pos[i * 3 + 1],
      z = pos[i * 3 + 2]
    const c = Math.floor((x - x0) / res + 0.5),
      r = Math.floor((y0 - y) / res + 0.5)
    if (c < 0 || c >= width || r < 0 || r >= height) continue
    const k = r * width + c
    if (!(H[k] <= z)) H[k] = z
  }
  return H
}

// Raise isolated dips: a cell more than `threshold` below all but at most one of
// its measured 8-neighbours (at least 5 of them) goes to their median. A single
// point of below-ground noise sets its cell's minimum, and a pinned particle
// there would hold the cloth down around it. A cell beside a roof is not
// isolated (the ground cells along the wall are as low as it is), and a pit
// wider than two cells keeps its low neighbours, so both survive. Reads a copy,
// so the result does not depend on scan order.
function despike(H, width, height, threshold) {
  const src = Float64Array.from(H)
  const nb = new Float64Array(8)
  let raised = 0
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const k = r * width + c
      const h = src[k]
      if (Number.isNaN(h)) continue
      let n = 0,
        near = 0
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr
        if (rr < 0 || rr >= height) continue
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc
          if ((dr === 0 && dc === 0) || cc < 0 || cc >= width) continue
          const v = src[rr * width + cc]
          if (Number.isNaN(v)) continue
          nb[n++] = v
          if (v - h <= threshold) near++
        }
      }
      if (n < 5 || near > 1) continue
      const sorted = nb.subarray(0, n).sort()
      H[k] = n & 1 ? sorted[n >> 1] : 0.5 * (sorted[(n >> 1) - 1] + sorted[n >> 1])
      raised++
    }
  }
  return raised
}

// Fill NaN cells with the value of the nearest measured cell (multi-source BFS
// over 4-neighbours, so "nearest" is in grid steps). Returns a Uint8Array marking
// the measured cells.
function fillNearest(H, width, height) {
  const n = width * height
  const measured = new Uint8Array(n)
  const queue = new Int32Array(n)
  let head = 0,
    tail = 0
  for (let k = 0; k < n; k++) {
    if (!Number.isNaN(H[k])) {
      measured[k] = 1
      queue[tail++] = k
    }
  }
  const seen = Uint8Array.from(measured)
  while (head < tail) {
    const k = queue[head++]
    const r = (k / width) | 0,
      c = k - r * width
    const visit = (j) => {
      if (!seen[j]) {
        seen[j] = 1
        H[j] = H[k]
        queue[tail++] = j
      }
    }
    if (c > 0) visit(k - 1)
    if (c < width - 1) visit(k + 1)
    if (r > 0) visit(k - width)
    if (r < height - 1) visit(k + width)
  }
  return measured
}

// Spring neighbours of a particle, as (dc, dr) offsets: the 8 around it and
// the 8 two steps away.
const SPRINGS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
  [2, 2],
  [-2, -2],
  [2, -2],
  [-2, 2],
]
const SPRING_DC = Int8Array.from(SPRINGS, ([dc]) => dc)
const SPRING_DR = Int8Array.from(SPRINGS, ([, dr]) => dr)

// Run the cloth. Mutates nothing it was given; returns the particle heights and
// how the run ended.
function simulateCloth(H, width, height, opts, onProgress) {
  const { rigidness, maxIterations, convergence, metresPerUnit } = opts
  const gravityStep = GRAVITY_STEP / metresPerUnit
  const n = width * height
  let hMin = Infinity
  for (let k = 0; k < n; k++) if (H[k] < hMin) hMin = H[k]
  const z = new Float64Array(n).fill(hMin - START_DEPTH / metresPerUnit)
  const zOld = Float64Array.from(z)
  const pinned = new Uint8Array(n)
  const offsets = Int32Array.from({ length: 16 }, (_, k) => SPRING_DR[k] * width + SPRING_DC[k])
  const moveBoth = 0.5 * (1 - 0.4 ** rigidness)
  const moveOne = 1 - 0.7 ** rigidness
  let iterations = 0,
    converged = false,
    pinnedCount = 0

  for (let it = 0; it < maxIterations; it++) {
    iterations = it + 1
    // Gravity (pushes up: the cloth rises from beneath the cloud).
    for (let k = 0; k < n; k++) {
      if (pinned[k]) continue
      const cur = z[k]
      z[k] = cur + (cur - zOld[k]) * (1 - DAMPING) + gravityStep
      zOld[k] = cur
    }
    // Springs, visited from both ends like the reference implementation, in a
    // fixed row-major order so a run is reproducible.
    for (let r = 0; r < height; r++) {
      const innerRow = r >= 2 && r < height - 2
      for (let c = 0; c < width; c++) {
        const a = r * width + c
        const pa = pinned[a]
        // Two cells from every edge, all 16 neighbours exist: no bounds tests (the
        // same springs in the same order, so the same cloth).
        const inner = innerRow && c >= 2 && c < width - 2
        for (let s = 0; s < 16; s++) {
          let b
          if (inner) b = a + offsets[s]
          else {
            const cc = c + SPRING_DC[s],
              rr = r + SPRING_DR[s]
            if (cc < 0 || cc >= width || rr < 0 || rr >= height) continue
            b = rr * width + cc
          }
          const pb = pinned[b]
          if (pa && pb) continue
          const d = z[b] - z[a]
          if (!pa && !pb) {
            z[a] += moveBoth * d
            z[b] -= moveBoth * d
          } else if (!pa) z[a] += moveOne * d
          else z[b] -= moveOne * d
        }
      }
    }
    // Collision, and the largest move of any particle still free.
    let maxMove = 0
    for (let k = 0; k < n; k++) {
      if (pinned[k]) continue
      if (z[k] >= H[k]) {
        z[k] = H[k]
        zOld[k] = H[k]
        pinned[k] = 1
        pinnedCount++
        continue
      }
      const move = Math.abs(z[k] - zOld[k])
      if (move > maxMove) maxMove = move
    }
    onProgress?.(iterations / maxIterations)
    // The first iterations accelerate from rest, so only test once moving.
    if (pinnedCount === n || (it > 2 && maxMove < convergence)) {
      converged = true
      break
    }
  }
  return { z, pinned, iterations, converged }
}

// Slope post-processing (the paper's §2.4): a stiff cloth settles below steep
// ground, because its springs hold it near the first cells it pinned. Pinning is
// spread from pinned particles to free 4-neighbours along CONTINUOUS terrain:
// where the two cells' collision heights differ by less than `threshold`, the
// free particle is moved onto its own H and pinned, and the search continues
// from it. A wall or a roof edge is a step larger than that, so it stops there.
// Only measured cells qualify (a filled cell's H is a copy of a neighbour's).
// Returns the number of particles moved.
function snapSlopes(z, pinned, H, measured, width, height, threshold) {
  const n = width * height
  const queue = new Int32Array(n)
  let head = 0,
    tail = 0,
    snapped = 0
  for (let k = 0; k < n; k++) if (pinned[k] && measured[k]) queue[tail++] = k
  while (head < tail) {
    const k = queue[head++]
    const r = (k / width) | 0,
      c = k - r * width
    const visit = (j) => {
      if (pinned[j] || !measured[j] || Math.abs(H[j] - H[k]) >= threshold) return
      z[j] = H[j]
      pinned[j] = 1
      queue[tail++] = j
      snapped++
    }
    if (c > 0) visit(k - 1)
    if (c < width - 1) visit(k + 1)
    if (r > 0) visit(k - width)
    if (r < height - 1) visit(k + width)
  }
  return snapped
}

// Classify the points of a cloud as ground / above ground / low noise.
//   pos   — interleaved xyz in the product frame (z up, metres), Float32/64Array
//   count — number of points
//   opts:
//     clothResolution — particle spacing (m). Coarser spans wider buildings and
//                       misses smaller ground detail; coarsened to `maxParticles`.
//     rigidness       — spring stiffness: 1 steep terrain, 2 rolling relief,
//                       3 flat (stiffest; spans the widest buildings)
//     classThreshold  — max distance from the cloth (m) for a ground point
//     slopeSmoothing  — pin free particles onto steep ground (step 4 above)
//     slopeThreshold  — (m) largest height step between neighbouring cells that
//                       still counts as continuous ground
//     maxIterations, convergence — stopping rule (convergence in m per iteration)
//     metresPerUnit   — metres per frame unit, for the simulation's own constants
//     unitLabel       — the frame unit's name for the log ('m')
//     despikeThreshold — (m) raise single-cell dips deeper than this; 0 = off
//     bounds          — { minX, minY, maxX, maxY }: classify only inside (the
//                       DEM's dense core); points outside stay class 0
//     heights         — also return each point's height above the cloth (`hag`)
// Returns { classes: Uint8Array(count), counts: { ground, unclassified, low,
//   never }, cloth: { width, height, originX, originY, res, z: Float32Array },
//   iterations, converged, pinned, snapped, despiked, hag? (Float32Array, NaN outside
//   the classified extent) }, or null when no point lies in the bounds.
export function classifyGround(pos, count, opts = {}) {
  const {
    clothResolution = 1,
    rigidness = 2,
    classThreshold = 0.5,
    slopeSmoothing = true,
    slopeThreshold = 0.3,
    maxIterations = 500,
    convergence = 0.005,
    despikeThreshold = 1,
    bounds = null,
    heights = false,
    maxParticles = GROUND_FILTER_LIMITS.maxParticles,
    metresPerUnit = 1,
    unitLabel = 'm',
    onLog = null,
    onProgress = null,
  } = opts
  if (!(classThreshold > 0)) throw new Error('classThreshold must be > 0')
  if (!(clothResolution > 0)) throw new Error('clothResolution must be > 0')
  if (!(rigidness >= 1 && rigidness <= 3)) throw new Error('rigidness must be 1, 2 or 3')

  // Extent of the classified points.
  let inside = null
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    n = 0
  if (bounds) inside = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3],
      y = pos[i * 3 + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(pos[i * 3 + 2])) continue
    if (bounds && (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY)) continue
    if (inside) inside[i] = 1
    n++
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (n === 0) return null
  if (!inside && n < count) {
    // Non-finite points are left unclassified (class 0) like out-of-bounds ones.
    inside = new Uint8Array(count)
    for (let i = 0; i < count; i++) {
      inside[i] =
        Number.isFinite(pos[i * 3]) && Number.isFinite(pos[i * 3 + 1]) && Number.isFinite(pos[i * 3 + 2]) ? 1 : 0
    }
  }

  const spanX = Math.max(maxX - minX, 0),
    spanY = Math.max(maxY - minY, 0)
  let res = Math.max(clothResolution, GROUND_FILTER_LIMITS.minResolution)
  // Enough particles that every point lies within half a cell of one.
  const dims = (s) => [Math.floor(spanX / s + 0.5) + 1, Math.floor(spanY / s + 0.5) + 1]
  let [width, height] = dims(res)
  if (width * height > maxParticles) {
    const asked = res
    res = Math.sqrt(((spanX + res) * (spanY + res)) / maxParticles) * 1.01
    ;[width, height] = dims(res)
    while (width * height > maxParticles) {
      res *= 1.05
      ;[width, height] = dims(res)
    }
    onLog?.(
      `Ground filter: cloth resolution ${asked.toPrecision(3)} ${unitLabel} would need more than ` +
        `${maxParticles.toLocaleString()} particles; using ${res.toPrecision(3)} ${unitLabel}`,
    )
  }
  // Particle (c, r) sits at (x0 + c·res, y0 − r·res), the top-left one on the
  // extent's corner, and owns the cell of width `res` centred on it. Indices are
  // taken relative to that corner, so survey-sized coordinates round the same as
  // small ones.
  const grid = { width, height, res, x0: minX, y0: maxY }
  onLog?.(
    `Ground filter: ${n.toLocaleString()} points, cloth ${width}×${height} at ` +
      `${res.toPrecision(3)} ${unitLabel}, rigidness ${rigidness}, ` +
      `class threshold ${+classThreshold.toPrecision(3)} ${unitLabel}`,
  )

  const H = lowestPerCell(pos, count, grid, inside)
  const despiked = despikeThreshold > 0 ? despike(H, width, height, despikeThreshold) : 0
  const measured = fillNearest(H, width, height)

  const sim = simulateCloth(
    H,
    width,
    height,
    { rigidness, maxIterations, convergence, metresPerUnit },
    onProgress ? (f) => onProgress(0.9 * f) : null,
  )
  const snapped = slopeSmoothing ? snapSlopes(sim.z, sim.pinned, H, measured, width, height, slopeThreshold) : 0
  let pinned = 0
  for (let k = 0; k < sim.pinned.length; k++) pinned += sim.pinned[k]

  // Classify against the cloth, bilinear between particle centres.
  const z = sim.z
  const classes = new Uint8Array(count)
  const hag = heights ? new Float32Array(count).fill(NaN) : null
  let ground = 0,
    unclassified = 0,
    low = 0
  const { x0, y0 } = grid
  for (let i = 0; i < count; i++) {
    if (inside && !inside[i]) continue
    const fx = (pos[i * 3] - x0) / res
    const fy = (y0 - pos[i * 3 + 1]) / res
    const c0 = Math.min(width - 1, Math.max(0, Math.floor(fx)))
    const r0 = Math.min(height - 1, Math.max(0, Math.floor(fy)))
    const c1 = Math.min(width - 1, c0 + 1),
      r1 = Math.min(height - 1, r0 + 1)
    const tx = Math.min(1, Math.max(0, fx - c0)),
      ty = Math.min(1, Math.max(0, fy - r0))
    const top = z[r0 * width + c0] * (1 - tx) + z[r0 * width + c1] * tx
    const bot = z[r1 * width + c0] * (1 - tx) + z[r1 * width + c1] * tx
    const d = pos[i * 3 + 2] - (top * (1 - ty) + bot * ty)
    if (hag) hag[i] = d
    if (d > classThreshold) {
      classes[i] = CLASS_UNCLASSIFIED
      unclassified++
    } else if (d < -classThreshold) {
      classes[i] = CLASS_LOW_POINT
      low++
    } else {
      classes[i] = CLASS_GROUND
      ground++
    }
  }
  onProgress?.(1)
  onLog?.(
    `Ground filter: ${sim.converged ? 'converged' : 'stopped'} after ${sim.iterations} iterations; ` +
      `${pinned.toLocaleString()} of ${(width * height).toLocaleString()} particles on the cloud` +
      `${snapped ? ` (${snapped.toLocaleString()} snapped on slopes)` : ''}` +
      `${despiked ? `, ${despiked.toLocaleString()} isolated low cells raised` : ''}`,
  )
  onLog?.(
    `Ground filter: ${ground.toLocaleString()} ground, ${unclassified.toLocaleString()} above ground, ` +
      `${low.toLocaleString()} low points${count - n ? `, ${(count - n).toLocaleString()} outside the extent` : ''}`,
  )

  return {
    classes,
    counts: { ground, unclassified, low, never: count - n },
    cloth: { width, height, originX: x0 - res / 2, originY: y0 + res / 2, res, z: Float32Array.from(z) },
    iterations: sim.iterations,
    converged: sim.converged,
    pinned,
    snapped,
    despiked,
    ...(hag ? { hag } : {}),
  }
}

// Classify a dense cloud ({ count, pos }, SfM or file coordinates) in a product
// frame: the Tools ▸ Classify ground entry point.
//   frame — a projection frame (frameSpec.js frameFromSpec) whose z is up, or null
//           for a cloud whose own z is already up (an imported survey cloud)
//   opts  — classifyGround's options in METRES, plus:
//     metresPerUnit — metres per frame unit (a georeference in US feet: 0.3048)
//     extent        — 'core' (the DEM's dense core, dem.js coreExtent) | 'all'
//     budgetBytes   — memory budget for the staged frame positions (24 B/point)
//     aboveGround   — vegetation and buildings among the points above the cloth
//                     (pointClasses.js classifyAboveGround's options, lengths in
//                     metres), or null for ground only
// Returns classifyGround's result (null when no point is usable), with
// `heightAboveGround` (Float32Array, metres above the cloth per point, NaN outside the
// classified extent) and `aboveGround` (classifyAboveGround's result) when it ran.
export function classifyCloudGround(cloud, frame, opts = {}) {
  const { metresPerUnit = 1, extent = 'core', budgetBytes = Infinity, onLog = null, aboveGround = null, ...rest } = opts
  if (!(metresPerUnit > 0)) throw new Error('metresPerUnit must be > 0')
  const { count, pos } = cloud
  // The staged frame positions (24 B a point) and the heights above ground (4 B).
  const bytes = count * 28
  if (bytes > budgetBytes) {
    throw new Error(
      `Ground filter needs ${Math.ceil(bytes / 2 ** 20).toLocaleString()} MiB for ${count.toLocaleString()} ` +
        'points, over the memory budget (Settings ▸ Compute); raise the budget or subsample the cloud',
    )
  }
  let framed = pos
  if (frame) {
    framed = new Float64Array(count * 3)
    const p = [0, 0, 0]
    for (let i = 0; i < count; i++) {
      p[0] = pos[i * 3]
      p[1] = pos[i * 3 + 1]
      p[2] = pos[i * 3 + 2]
      const q = frame.fromSfm(p)
      framed[i * 3] = q[0]
      framed[i * 3 + 1] = q[1]
      framed[i * 3 + 2] = q[2]
    }
  }
  let bounds = null
  if (extent === 'core') {
    bounds = coreExtent(framed, count)
    if (bounds && bounds.inside < count) {
      onLog?.(
        `Ground filter: classifying the cloud's dense core; ${(count - bounds.inside).toLocaleString()} ` +
          'points outside it stay never classified (class 0)',
      )
    }
  }
  // Lengths are set in metres and the simulation runs in frame units.
  const toUnits = (m) => m / metresPerUnit
  const unitLabel = metresPerUnit === 1 ? 'm' : (rest.unitLabel ?? 'units')
  const classesAbove = !!(aboveGround && (aboveGround.vegetation || aboveGround.buildings))
  const result = classifyGround(framed, count, {
    ...rest,
    clothResolution: toUnits(rest.clothResolution ?? 1),
    classThreshold: toUnits(rest.classThreshold ?? 0.5),
    slopeThreshold: toUnits(rest.slopeThreshold ?? 0.3),
    convergence: toUnits(rest.convergence ?? 0.005),
    despikeThreshold: toUnits(rest.despikeThreshold ?? 1),
    metresPerUnit,
    unitLabel,
    bounds,
    onLog,
    heights: true,
  })
  if (!result) return result
  // Height above ground in metres, whatever the frame's unit: a point attribute. The
  // class rules read it first, in frame units; then the one array is scaled in place.
  const heightAboveGround = result.hag
  delete result.hag
  const toMetres = () => {
    if (metresPerUnit !== 1) for (let i = 0; i < count; i++) heightAboveGround[i] *= metresPerUnit
  }
  if (!classesAbove) {
    toMetres()
    return { ...result, heightAboveGround }
  }
  // Lengths in metres; the run converts them to frame units.
  const a = { ...CLASSIFY_TUNING, ...CLASSIFY_DEFAULTS, ...aboveGround }
  const above = classifyAboveGround(framed, count, result.classes, heightAboveGround, cloud.col ?? null, {
    ...a,
    voxel: toUnits(a.voxel),
    radius: toUnits(a.radius),
    lowVegetationMax: toUnits(a.lowVegetationMax),
    mediumVegetationMax: toUnits(a.mediumVegetationMax),
    minBuildingHeight: toUnits(a.minBuildingHeight),
    minBuildingArea: a.minBuildingArea / (metresPerUnit * metresPerUnit),
    onProgress: null,
  })
  const c = above.counts
  onLog?.(
    `Classify points: ${above.voxels.toLocaleString()} voxels above ground` +
      (aboveGround.buildings
        ? `; ${above.buildingSegments.toLocaleString()} of ${above.segments.toLocaleString()} planar segments are buildings (${c.building.toLocaleString()} points)`
        : '') +
      (aboveGround.vegetation
        ? `; vegetation ${c.low.toLocaleString()} low, ${c.medium.toLocaleString()} medium, ${c.high.toLocaleString()} high` +
          (above.colour ? '' : ' (no colour: geometry only)')
        : ''),
  )
  toMetres()
  return { ...result, heightAboveGround, aboveGround: above }
}
