// DEM (Digital Elevation / Surface Model) rasterisation — pure, no
// Vue/Pinia/OPFS/DOM. Turns a point set already expressed in a projection frame
// (x,y = ground plane, z = height; see projection.js / georef.js) into a regular
// height grid.
//
// The grid is a top-left-origin raster (row 0 = max-Y / north), so it drops
// straight into an ImageData/GeoTIFF without a flip. Each cell aggregates the
// heights of the points that fall in it (max ⇒ a DSM top surface by default);
// empty cells are filled by inverse-distance weighting within a small radius and
// otherwise left as NaN (nodata).

import { DEFAULT_BUDGET_BYTES, formatBytes } from '../dense/memBudget.js'

// Grid coordinates for a cell centre: pixel (col,row) → frame (x,y).
export function cellCenter(grid, col, row) {
  return [grid.originX + (col + 0.5) * grid.gsd, grid.originY - (row + 0.5) * grid.gsd]
}

// Suggest a ground sample distance (frame units/px) that lands roughly one point
// per cell: gsd ≈ √(bboxArea / n). Returns 0 for degenerate input.
export function suggestGsd(points) {
  if (points.length < 2) return 0
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }
  const area = (maxX - minX) * (maxY - minY)
  if (!(area > 0)) return 0
  return Math.sqrt(area / points.length)
}

// Bytes a staged point costs: one Float64 xyz.
export const DEM_STAGE_BYTES_PER_POINT = 24

// Copy a cloud's positions into a fresh Float64 buffer the worker can take by
// transfer (the source cloud is never detached), keeping only the points for
// which `inside(x, y, z)` holds when it is given. The buffer is sized to the
// survivors: a count pass runs first, so a region costs no full-cloud copy. All
// of it is ArrayBuffer memory, so it is checked against the device budget, not
// the V8 heap.
//   cloud: a dense cloud ({ count, pos }) or a sparse one ({ points: [{x,y,z}] })
// Returns { pos: Float64Array(3·count), count, total }.
export function stageDemPoints(cloud, { inside = null, budgetBytes = DEFAULT_BUDGET_BYTES } = {}) {
  const src = cloud.pos ?? null, pts = cloud.points
  const total = src ? cloud.count : pts.length
  const xyz = [0, 0, 0]
  const read = src
    ? (i) => { xyz[0] = src[i * 3]; xyz[1] = src[i * 3 + 1]; xyz[2] = src[i * 3 + 2] }
    : (i) => { const p = pts[i]; xyz[0] = p.x; xyz[1] = p.y; xyz[2] = p.z }
  let count = total
  if (inside) {
    count = 0
    for (let i = 0; i < total; i++) { read(i); if (inside(xyz[0], xyz[1], xyz[2])) count++ }
  }
  const bytes = count * DEM_STAGE_BYTES_PER_POINT
  if (bytes > budgetBytes) {
    throw new Error(`DEM point staging needs ${formatBytes(bytes)} for ${count.toLocaleString()} points, `
      + `over the ${formatBytes(budgetBytes)} memory budget (Settings ▸ Compute); `
      + 'raise the budget, subsample the cloud or set a region')
  }
  const pos = new Float64Array(count * 3)
  if (!inside && src) {
    pos.set(src.subarray(0, count * 3))
  } else {
    let o = 0
    for (let i = 0; i < total; i++) {
      read(i)
      if (inside && !inside(xyz[0], xyz[1], xyz[2])) continue
      pos[o++] = xyz[0]; pos[o++] = xyz[1]; pos[o++] = xyz[2]
    }
  }
  return { pos, count, total }
}

// The DENSE CORE of a cloud's footprint: the box a product covers by default.
// The raw min/max is not it — an oblique capture sees far past its site (St
// Nazaire's −26° frames reach nearly to the horizon), and a handful of far points
// stretch the grid, coarsen the auto GSD and leave most cells empty. Far
// background thins out per area, so a density test separates it:
//   1. per-axis [q, 1−q] quantiles drop extreme flyers;
//   2. a bins×bins histogram over that box counts points per cell (twice: the
//      second pass over the first result, for site-scale edge resolution);
//   3. the core is the bounding box (+1 cell) of the cells holding at least
//      `densityFraction` of the density a typical POINT sits in (the point-
//      weighted median cell count) — a sparse but real site edge stays, a thin far
//      field goes. Not a cell percentile: when thin background occupies most
//      cells, any cell percentile is itself background and the test cuts nothing;
//      and not the max, which one dense blob would inflate until it cut the site.
// pos: interleaved xyz in FRAME coordinates (only x, y are read); count points.
// → { minX, minY, maxX, maxY, inside } or null for degenerate input.
export function coreExtent(pos, count, { bins = 128, quantile = 0.001, densityFraction = 0.02, maxSamples = 200_000 } = {}) {
  if (!(count >= 2)) return null
  const stride = Math.max(1, Math.floor(count / maxSamples))
  const m = Math.ceil(count / stride)
  const xs = new Float64Array(m), ys = new Float64Array(m)
  for (let i = 0, k = 0; i < count && k < m; i += stride, k++) { xs[k] = pos[i * 3]; ys[k] = pos[i * 3 + 1] }
  xs.sort(); ys.sort()
  const lo = Math.floor(quantile * (m - 1)), hi = Math.ceil((1 - quantile) * (m - 1))
  if (!(xs[hi] > xs[lo]) || !(ys[hi] > ys[lo])) return null

  // One density pass over a box → the dense sub-box (+1 cell margin). Run twice:
  // the first box spans any far field, so its cells are coarse; the second, over
  // the first result, puts the edges to ~1% of the site.
  function densePass(bx0, bx1, by0, by1) {
    const cw = (bx1 - bx0) / bins, ch = (by1 - by0) / bins
    const hist = new Uint32Array(bins * bins)
    for (let i = 0; i < count; i++) {
      const c = Math.floor((pos[i * 3] - bx0) / cw), r = Math.floor((pos[i * 3 + 1] - by0) / ch)
      if (c < 0 || r < 0 || c > bins || r > bins) continue
      hist[Math.min(r, bins - 1) * bins + Math.min(c, bins - 1)]++
    }
    const occupied = []
    let total = 0
    for (const v of hist) if (v) { occupied.push(v); total += v }
    if (!occupied.length) return null
    // Point-weighted median: walk cells from the densest down until half the
    // points are covered; that cell's count is what a typical point experiences.
    occupied.sort((a, b) => b - a)
    let acc = 0, typical = occupied[0]
    for (const v of occupied) { acc += v; typical = v; if (acc >= total / 2) break }
    const threshold = Math.max(1, densityFraction * typical)
    let c0 = bins, c1 = -1, r0 = bins, r1 = -1
    for (let r = 0; r < bins; r++) for (let c = 0; c < bins; c++) {
      if (hist[r * bins + c] < threshold) continue
      if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r
    }
    if (c1 < 0) return null
    return [bx0 + Math.max(0, c0 - 1) * cw, bx0 + Math.min(bins, c1 + 2) * cw,
      by0 + Math.max(0, r0 - 1) * ch, by0 + Math.min(bins, r1 + 2) * ch]
  }
  const first = densePass(xs[lo], xs[hi], ys[lo], ys[hi])
  if (!first) return null
  const box = densePass(...first) ?? first
  const [minX, maxX, minY, maxY] = box
  let inside = 0
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1]
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) inside++
  }
  return { minX, minY, maxX, maxY, inside }
}

// Rasterise `points` ({x,y,z} in the frame) into a height grid.
//   opts:
//     gsd        — cell size in frame units; auto (suggestGsd) when omitted
//     aggregate  — 'max'(default DSM) | 'min' | 'mean' | 'median'
//     fillMethod — 'none' | 'nearest' | 'idw' (default)
//     fillRadius — cells; hole-fill search radius (0 = no fill)
//     maxGrid    — hard cap on the longer grid side; gsd is grown to respect it
//     memBudgetBytes — working-memory budget for the grid (+ median buffers);
//                  the caller subtracts anything it already holds (the points)
// Returns { width, height, gsd, originX, originY, data:Float32Array (NaN=nodata),
//           mask:Uint8Array (1=has data, incl. filled), zMin, zMax, count, filled }.
export function rasterizeDem(allPoints, opts = {}) {
  const { aggregate = 'max', fillMethod = 'idw', fillRadius = 2, maxGrid = 4096 } = opts
  // `bounds` ({ minX, minY, maxX, maxY }, e.g. coreExtent) limits the grid; points
  // outside are LEFT OUT — clamping them into the edge cells would pile far
  // background onto the border. The auto GSD then reflects the points inside.
  const b = opts.bounds
  let points = allPoints
  if (b) {
    const isIn = (p) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY
    let n = 0
    for (const p of allPoints) if (isIn(p)) n++
    points = { length: n, *[Symbol.iterator]() { for (const p of allPoints) if (isIn(p)) yield p } }
  }
  if (points.length < 1) return null

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }
  if (!(maxX > minX) || !(maxY > minY)) return null

  let gsd = opts.gsd > 0 ? opts.gsd : suggestGsd(points)
  if (!(gsd > 0)) return null
  // Cap the grid: grow gsd so the longer side (ceil(span/gsd)+1) stays ≤ maxGrid.
  const spanMax = Math.max(maxX - minX, maxY - minY)
  if (spanMax / gsd > maxGrid - 1) gsd = spanMax / (maxGrid - 1)

  const width = Math.max(1, Math.ceil((maxX - minX) / gsd) + 1)
  const height = Math.max(1, Math.ceil((maxY - minY) / gsd) + 1)
  const originX = minX
  const originY = maxY // top-left origin: row 0 is the max-Y edge

  const cells = width * height
  // Grid planes (data, measured, mask, the mean path's sum + count) ≈ 24 B/cell;
  // median adds a cell-offset table and one Float64 per point.
  const budget = Number.isFinite(opts.memBudgetBytes) ? opts.memBudgetBytes : DEFAULT_BUDGET_BYTES
  const need = cells * 24 + (aggregate === 'median' ? cells * 4 + points.length * 8 : 0)
  if (!Number.isSafeInteger(cells) || need > budget) {
    throw new Error(`DEM raster (${width}×${height}) needs ${formatBytes(need)}, over the `
      + `${formatBytes(budget)} working-memory limit; increase GSD or reduce the grid size`)
  }
  const data = new Float32Array(cells).fill(NaN)

  const colOf = (x) => Math.min(width - 1, Math.max(0, Math.floor((x - originX) / gsd)))
  const rowOf = (y) => Math.min(height - 1, Math.max(0, Math.floor((originY - y) / gsd)))

  if (aggregate === 'median') {
    // Counting sort by cell into one typed buffer — no per-cell JS arrays or Map,
    // so it costs ArrayBuffer memory (accounted above), not V8 heap. off[i] ends
    // as cell i's first slot: prefix sums give each cell's end, and the scatter
    // fills every cell from its end downwards.
    const n = points.length
    const off = new Uint32Array(cells + 1)
    for (const p of points) off[rowOf(p.y) * width + colOf(p.x)]++
    for (let i = 1; i < cells; i++) off[i] += off[i - 1]
    off[cells] = n
    const zs = new Float64Array(n)
    for (const p of points) zs[--off[rowOf(p.y) * width + colOf(p.x)]] = p.z
    for (let i = 0; i < cells; i++) {
      const a = off[i], b = off[i + 1]
      if (b === a) continue
      const seg = zs.subarray(a, b).sort()
      data[i] = seg[(b - a) >> 1]
    }
  } else if (aggregate === 'mean') {
    const sum = new Float64Array(cells)
    const cnt = new Uint32Array(cells)
    for (const p of points) {
      const idx = rowOf(p.y) * width + colOf(p.x)
      sum[idx] += p.z; cnt[idx]++
    }
    for (let i = 0; i < cells; i++) if (cnt[i]) data[i] = sum[i] / cnt[i]
  } else {
    const takeMax = aggregate !== 'min'
    for (const p of points) {
      const idx = rowOf(p.y) * width + colOf(p.x)
      const cur = data[idx]
      if (Number.isNaN(cur)) data[idx] = p.z
      else if (takeMax ? p.z > cur : p.z < cur) data[idx] = p.z
    }
  }

  // Validity mask before filling (so IDW reads only measured cells).
  const measured = new Uint8Array(cells)
  let count = 0
  for (let i = 0; i < cells; i++) if (!Number.isNaN(data[i])) { measured[i] = 1; count++ }

  let filled = 0
  if (fillMethod !== 'none' && fillRadius > 0) {
    filled = fillNodata(data, measured, width, height, fillRadius, fillMethod)
  }

  const mask = new Uint8Array(cells)
  let zMin = Infinity, zMax = -Infinity
  for (let i = 0; i < cells; i++) {
    if (!Number.isNaN(data[i])) {
      mask[i] = 1
      if (data[i] < zMin) zMin = data[i]
      if (data[i] > zMax) zMax = data[i]
    }
  }
  if (zMin > zMax) { zMin = 0; zMax = 0 }

  return { width, height, gsd, originX, originY, data, mask, zMin, zMax, count, filled }
}

// Fill nodata cells by inverse-distance weighting over measured cells within
// `radius` (in cells). Writes into `data` but reads only `measured`, so filled
// cells never seed further fills. Returns the number of cells filled.
export function fillNodata(data, measured, width, height, radius, method = 'idw') {
  let filled = 0
  const r = Math.max(0, Math.floor(radius))
  const r2 = r * r
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col
      if (measured[idx]) continue
      let wsum = 0, vsum = 0
      let nearest = -1, nearestD2 = Infinity
      for (let dr = -r; dr <= r; dr++) {
        const rr = row + dr
        if (rr < 0 || rr >= height) continue
        for (let dc = -r; dc <= r; dc++) {
          const cc = col + dc
          if (cc < 0 || cc >= width) continue
          const d2 = dr * dr + dc * dc
          if (d2 === 0 || d2 > r2) continue
          const nIdx = rr * width + cc
          if (!measured[nIdx]) continue
          if (d2 < nearestD2) { nearestD2 = d2; nearest = nIdx }
          const w = 1 / d2
          wsum += w; vsum += w * data[nIdx]
        }
      }
      if (nearest >= 0) {
        data[idx] = method === 'nearest' ? data[nearest] : vsum / wsum
        filled++
      }
    }
  }
  return filled
}
