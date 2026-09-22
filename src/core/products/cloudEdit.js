// Pure point-cloud editing: crop, filter, merge. No Vue/Pinia/OPFS/DOM — plain
// data in, plain data out, side effects via an injected `onLog`.
//
// Scope: these operate on **flat** clouds only — `{ count, pos:Float32Array(3N),
// col?:Uint8Array(3N), nrm?:Float32Array(3N) }`, i.e. `kind:'dense'` (computed or
// imported). A sparse cloud is deliberately NOT editable here: its points carry the
// per-point view-tracks that dense/ortho/COLMAP-export read, and dropping points
// would silently invalidate the depth-map staleness stamp and the track statistics.
// Cropping the *model* is a different operation from cropping a *product*.
//
// Every function returns a NEW flat cloud and never mutates its input, so the store
// can add the result alongside the source (non-destructive, matching how an
// `imported` cloud is never overwritten by a re-fuse).
//
// Dense-scale invariant, as everywhere else in this codebase: never materialize a
// per-point object list. Selection is a Uint8Array mask + a compacting copy; the
// voxel paths stream into `createVoxelAccumulator` exactly as fusion does.

import { createVoxelAccumulator } from '../dense/mvs.js'

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Point count of a flat cloud (tolerates a missing `count`). */
export function cloudCount(cloud) {
  if (!cloud?.pos) return 0
  return cloud.count ?? Math.floor(cloud.pos.length / 3)
}

/**
 * Axis-aligned bounds of a flat cloud, or null when empty. Returned as a plain
 * object so it round-trips through `postMessage` and prefills the crop modal.
 */
export function cloudBounds(cloud) {
  const n = cloudCount(cloud)
  if (!n) return null
  const { pos } = cloud
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  return { minX, minY, minZ, maxX, maxY, maxZ }
}

/**
 * Build a new flat cloud from a keep-mask. `kept` is the mask's popcount (passed in
 * because every caller already knows it — recounting a 25 M mask is not free).
 * Colour/normals are carried through only when the source had them.
 */
export function selectPoints(cloud, keep, kept) {
  const n = cloudCount(cloud)
  const src = cloud.pos, sc = cloud.col || null, sn = cloud.nrm || null
  const pos = new (cloud.pos.constructor)(kept * 3)
  const col = sc ? new Uint8Array(kept * 3) : null
  const nrm = sn ? new Float32Array(kept * 3) : null
  let o = 0
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue
    const s = i * 3, d = o * 3
    pos[d] = src[s]; pos[d + 1] = src[s + 1]; pos[d + 2] = src[s + 2]
    if (col) { col[d] = sc[s]; col[d + 1] = sc[s + 1]; col[d + 2] = sc[s + 2] }
    if (nrm) { nrm[d] = sn[s]; nrm[d + 1] = sn[s + 1]; nrm[d + 2] = sn[s + 2] }
    o++
  }
  return { count: kept, pos, ...(col ? { col } : {}), ...(nrm ? { nrm } : {}) }
}

// Largest packed cell key we allow: keys are float64 integers, so the per-axis cell
// counts' product must stay exactly representable. Matches the constraint
// createVoxelAccumulator's caller enforces via clampCellForBounds.
const MAX_CELLS = 2 ** 50

/**
 * Grow `cell` until the bbox's packed cell-key space fits in MAX_CELLS. Returns the
 * usable cell size. A caller that passes a pathologically small cell for a
 * CRS-sized bbox gets a coarser grid rather than key collisions.
 */
export function clampGridCell(bounds, cell) {
  let c = cell > 0 ? cell : 1
  for (let guard = 0; guard < 64; guard++) {
    const nx = Math.floor((bounds.maxX - bounds.minX) / c) + 3
    const ny = Math.floor((bounds.maxY - bounds.minY) / c) + 3
    const nz = Math.floor((bounds.maxZ - bounds.minZ) / c) + 3
    if (nx * ny * nz <= MAX_CELLS) return c
    c *= 2
  }
  return c
}

/**
 * Uniform spatial hash over a flat cloud, as three typed arrays (a counting sort)
 * plus a `Map<packedKey → compact cell id>`. This is the dense-safe alternative to
 * a `Map<key, number[]>`: one Int32Array per point instead of an array object per
 * occupied cell. Returns { cell, cellOf, start, order, keyOf, idOfKey, cellCount }.
 *   - `cellOf[i]`  compact cell id of point i
 *   - points of cell c are `order[start[c] .. start[c+1])`
 *   - `keyOf(x,y,z)` packs world coords to the key `idOfKey` resolves
 */
export function buildSpatialGrid(cloud, bounds, cell) {
  const n = cloudCount(cloud)
  const { pos } = cloud
  const c = clampGridCell(bounds, cell)
  const inv = 1 / c
  const bx = Math.floor(bounds.minX * inv) - 1
  const by = Math.floor(bounds.minY * inv) - 1
  const bz = Math.floor(bounds.minZ * inv) - 1
  const nx = Math.floor(bounds.maxX * inv) - Math.floor(bounds.minX * inv) + 3
  const ny = Math.floor(bounds.maxY * inv) - Math.floor(bounds.minY * inv) + 3
  const nz = Math.floor(bounds.maxZ * inv) - Math.floor(bounds.minZ * inv) + 3
  const clamp = (i, hi) => (i < 0 ? 0 : (i >= hi ? hi - 1 : i))
  const keyAt = (ix, iy, iz) => (clamp(ix - bx, nx) * ny + clamp(iy - by, ny)) * nz + clamp(iz - bz, nz)

  const idOfKey = new Map()
  const cellOf = new Int32Array(n)
  const ix = new Int32Array(n), iy = new Int32Array(n), iz = new Int32Array(n)
  let cellCount = 0
  for (let i = 0; i < n; i++) {
    const gx = Math.floor(pos[i * 3] * inv)
    const gy = Math.floor(pos[i * 3 + 1] * inv)
    const gz = Math.floor(pos[i * 3 + 2] * inv)
    ix[i] = gx; iy[i] = gy; iz[i] = gz
    const key = keyAt(gx, gy, gz)
    let id = idOfKey.get(key)
    if (id === undefined) { id = cellCount++; idOfKey.set(key, id) }
    cellOf[i] = id
  }
  // Counting sort into per-cell contiguous runs.
  const start = new Int32Array(cellCount + 1)
  for (let i = 0; i < n; i++) start[cellOf[i] + 1]++
  for (let c2 = 0; c2 < cellCount; c2++) start[c2 + 1] += start[c2]
  const fill = start.slice(0, cellCount)
  const order = new Int32Array(n)
  for (let i = 0; i < n; i++) order[fill[cellOf[i]]++] = i

  return { cell: c, cellOf, start, order, cellCount, gx: ix, gy: iy, gz: iz, keyAt, idOfKey }
}

/**
 * Median nearest-point spacing estimate, used to auto-size a grid cell when the
 * caller gives none. Derived from density (bbox volume / N) rather than an actual
 * nearest-neighbour sweep — that would cost as much as the filter it sizes. A
 * degenerate (planar or single-point) bbox falls back through the non-zero extents.
 */
export function estimateSpacing(bounds, n) {
  if (!(n > 1)) return 0
  const ex = Math.max(bounds.maxX - bounds.minX, 0)
  const ey = Math.max(bounds.maxY - bounds.minY, 0)
  const ez = Math.max(bounds.maxZ - bounds.minZ, 0)
  const dims = [ex, ey, ez].filter((e) => e > 0)
  if (!dims.length) return 0
  const vol = dims.reduce((a, b) => a * b, 1)
  return Math.pow(vol / n, 1 / dims.length)
}

// ── Crop ─────────────────────────────────────────────────────────────────────

/**
 * Keep points inside an axis-aligned box (or outside it, with `invert`). Bounds are
 * inclusive; a null/undefined component means "unbounded on that side", so a
 * Z-only crop needs no X/Y numbers.
 *
 * opts: { min: [x,y,z], max: [x,y,z], invert = false }
 */
export function cropCloud(cloud, { min = [], max = [], invert = false } = {}, onLog) {
  const n = cloudCount(cloud)
  if (!n) return { count: 0, pos: new Float32Array(0) }
  const lo = [0, 1, 2].map((i) => (Number.isFinite(min[i]) ? min[i] : -Infinity))
  const hi = [0, 1, 2].map((i) => (Number.isFinite(max[i]) ? max[i] : Infinity))
  const { pos } = cloud
  const keep = new Uint8Array(n)
  let kept = 0
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    const inside = x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2]
    if (inside !== invert) { keep[i] = 1; kept++ }
  }
  onLog?.(`Crop: kept ${kept.toLocaleString()} of ${n.toLocaleString()} points`
    + `${invert ? ' (outside box)' : ''}`, 'info', 'Products')
  return selectPoints(cloud, keep, kept)
}

// ── Filters ──────────────────────────────────────────────────────────────────

/**
 * Statistical outlier removal. For each point, take the mean distance to its `k`
 * nearest neighbours; drop points whose mean exceeds `mean + stdRatio·σ` over the
 * whole cloud. The classic PCL filter, and the right tool for the sparse haze of
 * flyers a fusion leaves behind — a real surface point sits in a dense neighbourhood,
 * a flyer does not.
 *
 * Neighbours come from a uniform grid sized to ~2× the estimated point spacing, so
 * the 27-cell gather usually holds well over k candidates. A point that finds NO
 * neighbour at all is dropped outright (it cannot contribute a distance to the
 * statistics, and it is by definition the most isolated thing in the cloud).
 *
 * opts: { k = 12, stdRatio = 1.5, cell = 0 (auto) }
 */
export function statisticalOutlierFilter(cloud, { k = 12, stdRatio = 1.5, cell = 0 } = {}, onLog) {
  const n = cloudCount(cloud)
  if (n < 3) return selectPoints(cloud, new Uint8Array(n).fill(1), n)
  const bounds = cloudBounds(cloud)
  const spacing = estimateSpacing(bounds, n)
  const grid = buildSpatialGrid(cloud, bounds, cell > 0 ? cell : Math.max(spacing * 2, 1e-9))
  const { pos } = cloud
  const { start, order, keyAt, idOfKey, gx, gy, gz } = grid

  const kk = Math.max(1, Math.floor(k))
  const best = new Float64Array(kk) // k smallest squared distances, ascending
  const mean = new Float64Array(n)
  const lonely = new Uint8Array(n)

  for (let i = 0; i < n; i++) {
    let found = 0
    best.fill(Infinity)
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const id = idOfKey.get(keyAt(gx[i] + dx, gy[i] + dy, gz[i] + dz))
          if (id === undefined) continue
          for (let s = start[id]; s < start[id + 1]; s++) {
            const j = order[s]
            if (j === i) continue
            const ddx = pos[j * 3] - x, ddy = pos[j * 3 + 1] - y, ddz = pos[j * 3 + 2] - z
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz
            if (d2 >= best[kk - 1]) continue
            // Insertion into the ascending k-list (kk is small; a heap is not worth it).
            let p = kk - 1
            while (p > 0 && best[p - 1] > d2) { best[p] = best[p - 1]; p-- }
            best[p] = d2
            found++
          }
        }
      }
    }
    if (!found) { lonely[i] = 1; continue }
    const m = Math.min(found, kk)
    let sum = 0
    for (let p = 0; p < m; p++) sum += Math.sqrt(best[p])
    mean[i] = sum / m
  }

  // Cloud-wide mean/σ over the points that had neighbours.
  let cnt = 0, s1 = 0, s2 = 0
  for (let i = 0; i < n; i++) { if (lonely[i]) continue; cnt++; s1 += mean[i]; s2 += mean[i] * mean[i] }
  const mu = cnt ? s1 / cnt : 0
  const sigma = cnt ? Math.sqrt(Math.max(s2 / cnt - mu * mu, 0)) : 0
  const limit = mu + stdRatio * sigma

  const keep = new Uint8Array(n)
  let kept = 0
  for (let i = 0; i < n; i++) {
    if (lonely[i]) continue
    if (mean[i] <= limit) { keep[i] = 1; kept++ }
  }
  onLog?.(`Filter (outlier): mean neighbour distance ${mu.toFixed(4)} ±${sigma.toFixed(4)}, `
    + `limit ${limit.toFixed(4)} → kept ${kept.toLocaleString()} of ${n.toLocaleString()}`, 'info', 'Products')
  return selectPoints(cloud, keep, kept)
}

/**
 * Remove points sitting in sparsely-occupied grid cells — the standalone version of
 * the dense accumulator's `filterIsolated`. Unlike that one it does NOT merge: it
 * scores occupancy on a grid and then keeps the original points, so this is a
 * cleanup, not a resample.
 *
 * A cell is kept when it holds > `maxSupport` points (a well-supported cell is never
 * a floater) or when at least `minNeighbors` of its 26 neighbours are occupied.
 *
 * opts: { cell = 0 (auto: 4× spacing), minNeighbors = 2, maxSupport = 2 }
 */
export function removeIsolated(cloud, { cell = 0, minNeighbors = 2, maxSupport = 2 } = {}, onLog) {
  const n = cloudCount(cloud)
  if (!n) return { count: 0, pos: new Float32Array(0) }
  const bounds = cloudBounds(cloud)
  const auto = Math.max(estimateSpacing(bounds, n) * 4, 1e-9)
  const grid = buildSpatialGrid(cloud, bounds, cell > 0 ? cell : auto)
  const { start, order, keyAt, idOfKey, cellCount, cellOf, gx, gy, gz } = grid

  // One representative point per cell gives us the cell's grid indices.
  const rep = new Int32Array(cellCount)
  for (let i = 0; i < n; i++) rep[cellOf[i]] = i

  const cellKeep = new Uint8Array(cellCount)
  for (let c = 0; c < cellCount; c++) {
    const size = start[c + 1] - start[c]
    if (size > maxSupport) { cellKeep[c] = 1; continue }
    const i = rep[c]
    let neigh = 0
    for (let dx = -1; dx <= 1 && neigh < minNeighbors; dx++) {
      for (let dy = -1; dy <= 1 && neigh < minNeighbors; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue
          if (idOfKey.get(keyAt(gx[i] + dx, gy[i] + dy, gz[i] + dz)) !== undefined) {
            neigh++
            if (neigh >= minNeighbors) break
          }
        }
      }
    }
    if (neigh >= minNeighbors) cellKeep[c] = 1
  }

  const keep = new Uint8Array(n)
  let kept = 0
  for (let i = 0; i < n; i++) if (cellKeep[cellOf[i]]) { keep[i] = 1; kept++ }
  onLog?.(`Filter (isolated): cell ${grid.cell.toFixed(4)} → kept ${kept.toLocaleString()} `
    + `of ${n.toLocaleString()} points`, 'info', 'Products')
  return selectPoints(cloud, keep, kept)
}

// Rec. 709 luma of an 8-bit RGB triple (0–255). The brightness a colour range gates on.
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/**
 * Keep points inside an elevation band and/or a brightness band. Cheap, and the
 * fastest way to strip a remembered ground plane or a blown-out sky remnant that
 * survived the geometric gates. Null bounds are unbounded; a cloud with no colour
 * ignores the brightness bounds entirely (rather than dropping everything).
 *
 * opts: { zMin, zMax, lumaMin, lumaMax } (all nullable)
 */
export function filterRange(cloud, { zMin = null, zMax = null, lumaMin = null, lumaMax = null } = {}, onLog) {
  const n = cloudCount(cloud)
  if (!n) return { count: 0, pos: new Float32Array(0) }
  const { pos } = cloud
  const col = cloud.col || null
  const z0 = Number.isFinite(zMin) ? zMin : -Infinity
  const z1 = Number.isFinite(zMax) ? zMax : Infinity
  const l0 = col && Number.isFinite(lumaMin) ? lumaMin : -Infinity
  const l1 = col && Number.isFinite(lumaMax) ? lumaMax : Infinity
  if (!col && (Number.isFinite(lumaMin) || Number.isFinite(lumaMax)))
    onLog?.('Filter (range): cloud has no colour — brightness bounds ignored', 'warn', 'Products')

  const keep = new Uint8Array(n)
  let kept = 0
  for (let i = 0; i < n; i++) {
    const z = pos[i * 3 + 2]
    if (z < z0 || z > z1) continue
    if (col) {
      const l = luma(col[i * 3], col[i * 3 + 1], col[i * 3 + 2])
      if (l < l0 || l > l1) continue
    }
    keep[i] = 1; kept++
  }
  onLog?.(`Filter (range): kept ${kept.toLocaleString()} of ${n.toLocaleString()} points`, 'info', 'Products')
  return selectPoints(cloud, keep, kept)
}

/**
 * Voxel downsample: one averaged point per world-space cell. Streams into the same
 * accumulator fusion uses, shifted to a cell-aligned origin near the bbox so the
 * Float32 finalize keeps precision on CRS-sized coordinates (identical reasoning to
 * `prepareCloudForExport`). Normals are averaged and renormalized when present.
 *
 * opts: { cell } — cell <= 0 returns the cloud unchanged.
 */
export function voxelDownsample(cloud, { cell = 0 } = {}, onLog) {
  const n = cloudCount(cloud)
  if (!n || !(cell > 0)) return cloud
  const b = cloudBounds(cloud)
  const c = clampGridCell(b, cell)
  const shift = [Math.floor(b.minX / c) * c, Math.floor(b.minY / c) * c, Math.floor(b.minZ / c) * c]
  const acc = createVoxelAccumulator(c, {
    minX: b.minX - shift[0], minY: b.minY - shift[1], minZ: b.minZ - shift[2],
    maxX: b.maxX - shift[0], maxY: b.maxY - shift[1], maxZ: b.maxZ - shift[2],
  })
  const { pos } = cloud
  const sc = cloud.col || null, sn = cloud.nrm || null
  for (let i = 0; i < n; i++) {
    const s = i * 3
    acc.add(
      pos[s] - shift[0], pos[s + 1] - shift[1], pos[s + 2] - shift[2],
      sc ? sc[s] : 200, sc ? sc[s + 1] : 200, sc ? sc[s + 2] : 200,
      sn ? sn[s] : 0, sn ? sn[s + 1] : 0, sn ? sn[s + 2] : 0,
    )
  }
  const flat = acc.finalizeFlat()
  const m = flat.length / 6
  const outPos = new (cloud.pos.constructor)(m * 3)
  const outCol = sc ? new Uint8Array(m * 3) : null
  for (let i = 0; i < m; i++) {
    const s = i * 6, d = i * 3
    outPos[d] = flat[s] + shift[0]; outPos[d + 1] = flat[s + 1] + shift[1]; outPos[d + 2] = flat[s + 2] + shift[2]
    if (outCol) { outCol[d] = flat[s + 3]; outCol[d + 1] = flat[s + 4]; outCol[d + 2] = flat[s + 5] }
  }
  const outNrm = sn ? acc.finalizeNormals().nrm : null
  onLog?.(`Filter (voxel ${c}): ${m.toLocaleString()} of ${n.toLocaleString()} points kept`, 'info', 'Products')
  return { count: m, pos: outPos, ...(outCol ? { col: outCol } : {}), ...(outNrm ? { nrm: outNrm } : {}) }
}

/**
 * Filter dispatch — one entry point so the worker op and the modal share a vocabulary.
 * `methods` is an ordered list; each runs on the previous one's output, which is what
 * lets "voxel then outlier" cost a fraction of "outlier then voxel".
 *
 * opts: { methods: ['range'|'voxel'|'isolated'|'sor'], range, voxel, isolated, sor }
 */
export function filterCloud(cloud, opts = {}, onLog) {
  const methods = opts.methods?.length ? opts.methods : []
  let out = cloud
  for (const m of methods) {
    if (m === 'range') out = filterRange(out, opts.range || {}, onLog)
    else if (m === 'voxel') out = voxelDownsample(out, opts.voxel || {}, onLog)
    else if (m === 'isolated') out = removeIsolated(out, opts.isolated || {}, onLog)
    else if (m === 'sor') out = statisticalOutlierFilter(out, opts.sor || {}, onLog)
    else onLog?.(`Filter: unknown method "${m}" — skipped`, 'warn', 'Products')
  }
  // Never hand the caller its own input back as "the result" — it would alias the
  // source cloud's buffers into a second store entry.
  if (out === cloud) return selectPoints(cloud, new Uint8Array(cloudCount(cloud)).fill(1), cloudCount(cloud))
  return out
}

// ── Merge ────────────────────────────────────────────────────────────────────

/**
 * Concatenate flat clouds into one, optionally voxel-deduping the result (the
 * principled way to handle the double-density seam where two overlapping clouds
 * meet). Coordinates are taken verbatim — merge assumes the inputs already share a
 * frame, exactly as `importCloud` does; there is no CRS reprojection here.
 *
 * Colour is emitted when ANY input has it (missing inputs fill neutral grey);
 * normals only when EVERY input has them — a partial normal field would silently
 * mislead Poisson, which reads them as oriented evidence.
 *
 * opts: { cell = 0 }
 */
export function mergeClouds(clouds, { cell = 0 } = {}, onLog) {
  const list = (clouds || []).filter((c) => cloudCount(c) > 0)
  if (!list.length) return { count: 0, pos: new Float32Array(0) }
  const total = list.reduce((s, c) => s + cloudCount(c), 0)
  const anyCol = list.some((c) => c.col)
  const allNrm = list.every((c) => c.nrm)
  if (!allNrm && list.some((c) => c.nrm))
    onLog?.('Merge: normals dropped (not every input cloud has them)', 'info', 'Products')

  const PositionArray = list.some(c => c.pos instanceof Float64Array) ? Float64Array : Float32Array
  const pos = new PositionArray(total * 3)
  const col = anyCol ? new Uint8Array(total * 3) : null
  const nrm = allNrm ? new Float32Array(total * 3) : null
  let o = 0
  for (const c of list) {
    const n = cloudCount(c)
    pos.set(c.pos.subarray(0, n * 3), o * 3)
    if (col) {
      if (c.col) col.set(c.col.subarray(0, n * 3), o * 3)
      else col.fill(200, o * 3, (o + n) * 3)
    }
    if (nrm) nrm.set(c.nrm.subarray(0, n * 3), o * 3)
    o += n
  }
  onLog?.(`Merge: ${list.length} clouds → ${total.toLocaleString()} points`, 'info', 'Products')
  const merged = { count: total, pos, ...(col ? { col } : {}), ...(nrm ? { nrm } : {}) }
  return cell > 0 ? voxelDownsample(merged, { cell }, onLog) : merged
}
