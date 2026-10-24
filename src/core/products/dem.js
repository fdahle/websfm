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

import { requestedGsd as requestedGsdFor } from './rasterSize.js'
import { MAX_FLOAT64_XYZ_POINTS, tooManyPointsMessage } from '../bufferLimit.js'
import { DEFAULT_BUDGET_BYTES, formatBytes } from '../dense/memBudget.js'

// Grid coordinates for a cell centre: pixel (col,row) → frame (x,y).
export function cellCenter(grid, col, row) {
  return [grid.originX + (col + 0.5) * grid.gsd, grid.originY - (row + 0.5) * grid.gsd]
}

// Suggest a ground sample distance (frame units/px) that lands roughly one point
// per cell: gsd ≈ √(bboxArea / n). Returns 0 for degenerate input.
export function suggestGsd(points) {
  if (points.length < 2) return 0
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const area = (maxX - minX) * (maxY - minY)
  if (!(area > 0)) return 0
  return Math.sqrt(area / points.length)
}

// Bytes a staged point costs: one Float64 xyz.
export const DEM_STAGE_BYTES_PER_POINT = 24

// Copy a cloud's positions into a fresh Float64 buffer the worker can take by
// transfer (the source cloud is never detached), keeping only the points for
// which `inside(x, y, z, i)` holds when it is given (i: the point's index, for a
// per-point attribute test such as ground-only). The buffer is sized to the
// survivors: a count pass runs first, so a region costs no full-cloud copy. All
// of it is ArrayBuffer memory, so it is checked against the device budget, not
// the V8 heap.
//   cloud: { count, pos } — a dense cloud, or a sparse one's SparsePoints pos column
// Returns { pos: Float64Array(3·count), count, total }.
export function stageDemPoints(cloud, { inside = null, budgetBytes = DEFAULT_BUDGET_BYTES } = {}) {
  const src = cloud.pos
  const total = cloud.count
  const xyz = [0, 0, 0]
  const read = (i) => {
    xyz[0] = src[i * 3]
    xyz[1] = src[i * 3 + 1]
    xyz[2] = src[i * 3 + 2]
  }
  let count = total
  if (inside) {
    count = 0
    for (let i = 0; i < total; i++) {
      read(i)
      if (inside(xyz[0], xyz[1], xyz[2], i)) count++
    }
  }
  const bytes = count * DEM_STAGE_BYTES_PER_POINT
  if (count > MAX_FLOAT64_XYZ_POINTS) {
    throw new Error(
      `${tooManyPointsMessage('The DEM input', count)} A cloud this size builds its DEM from ` +
        'its level-of-detail octree once that exists; or limit the area with Region.',
    )
  }
  if (bytes > budgetBytes) {
    throw new Error(
      `DEM point staging needs ${formatBytes(bytes)} for ${count.toLocaleString()} points, ` +
        `over the ${formatBytes(budgetBytes)} memory budget (Settings ▸ Compute); ` +
        'raise the budget, subsample the cloud or set a region',
    )
  }
  const pos = new Float64Array(count * 3)
  if (!inside && src) {
    pos.set(src.subarray(0, count * 3))
  } else {
    let o = 0
    for (let i = 0; i < total; i++) {
      read(i)
      if (inside && !inside(xyz[0], xyz[1], xyz[2], i)) continue
      pos[o++] = xyz[0]
      pos[o++] = xyz[1]
      pos[o++] = xyz[2]
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
export function coreExtent(
  pos,
  count,
  { bins = 128, quantile = 0.001, densityFraction = 0.02, maxSamples = 200_000 } = {},
) {
  if (!(count >= 2)) return null
  const stride = Math.max(1, Math.floor(count / maxSamples))
  const m = Math.ceil(count / stride)
  const xs = new Float64Array(m),
    ys = new Float64Array(m)
  for (let i = 0, k = 0; i < count && k < m; i += stride, k++) {
    xs[k] = pos[i * 3]
    ys[k] = pos[i * 3 + 1]
  }
  xs.sort()
  ys.sort()
  const lo = Math.floor(quantile * (m - 1)),
    hi = Math.ceil((1 - quantile) * (m - 1))
  if (!(xs[hi] > xs[lo]) || !(ys[hi] > ys[lo])) return null

  // One density pass over a box → the dense sub-box (+1 cell margin). Run twice:
  // the first box spans any far field, so its cells are coarse; the second, over
  // the first result, puts the edges to ~1% of the site.
  function densePass(bx0, bx1, by0, by1) {
    const cw = (bx1 - bx0) / bins,
      ch = (by1 - by0) / bins
    const hist = new Uint32Array(bins * bins)
    for (let i = 0; i < count; i++) {
      const c = Math.floor((pos[i * 3] - bx0) / cw),
        r = Math.floor((pos[i * 3 + 1] - by0) / ch)
      if (c < 0 || r < 0 || c > bins || r > bins) continue
      hist[Math.min(r, bins - 1) * bins + Math.min(c, bins - 1)]++
    }
    const occupied = []
    let total = 0
    for (const v of hist)
      if (v) {
        occupied.push(v)
        total += v
      }
    if (!occupied.length) return null
    // Point-weighted median: walk cells from the densest down until half the
    // points are covered; that cell's count is what a typical point experiences.
    occupied.sort((a, b) => b - a)
    let acc = 0,
      typical = occupied[0]
    for (const v of occupied) {
      acc += v
      typical = v
      if (acc >= total / 2) break
    }
    const threshold = Math.max(1, densityFraction * typical)
    let c0 = bins,
      c1 = -1,
      r0 = bins,
      r1 = -1
    for (let r = 0; r < bins; r++)
      for (let c = 0; c < bins; c++) {
        if (hist[r * bins + c] < threshold) continue
        if (c < c0) c0 = c
        if (c > c1) c1 = c
        if (r < r0) r0 = r
        if (r > r1) r1 = r
      }
    if (c1 < 0) return null
    return [
      bx0 + Math.max(0, c0 - 1) * cw,
      bx0 + Math.min(bins, c1 + 2) * cw,
      by0 + Math.max(0, r0 - 1) * ch,
      by0 + Math.min(bins, r1 + 2) * ch,
    ]
  }
  const first = densePass(xs[lo], xs[hi], ys[lo], ys[hi])
  if (!first) return null
  const box = densePass(...first) ?? first
  const [minX, maxX, minY, maxY] = box
  let inside = 0
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3],
      y = pos[i * 3 + 1]
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) inside++
  }
  return { minX, minY, maxX, maxY, inside }
}

// The grid a DEM of `allPoints` ({x,y,z} in the frame) gets: `opts.bounds` ({ minX,
// minY, maxX, maxY }, e.g. coreExtent) limits it, and points outside are LEFT OUT —
// clamping them into the edge cells would pile far background onto the border. The
// auto GSD (suggestGsd) then reflects the points inside. `opts.maxGrid` (default 4,096,
// Infinity for none) caps the longer side by growing the GSD.
// → { points (the ones inside, iterable, with length), width, height, gsd, originX,
//     originY, requestedGsd } | null
export function demGeometry(allPoints, opts = {}) {
  const { maxGrid = 4096 } = opts
  const b = opts.bounds
  let points = allPoints
  if (b) {
    const isIn = (p) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY
    let n = 0
    for (const p of allPoints) if (isIn(p)) n++
    points = {
      length: n,
      *[Symbol.iterator]() {
        for (const p of allPoints) if (isIn(p)) yield p
      },
    }
  }
  if (points.length < 1) return null

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  if (!(maxX > minX) || !(maxY > minY)) return null

  // A chosen cell size, else the one a chosen long side (px) implies, else auto.
  const spanMax = Math.max(maxX - minX, maxY - minY)
  const requestedGsd = requestedGsdFor(opts, spanMax) || suggestGsd(points)
  if (!(requestedGsd > 0)) return null
  let gsd = requestedGsd
  // Cap the grid: grow gsd so the longer side (ceil(span/gsd)+1) stays ≤ maxGrid.
  if (spanMax / gsd > maxGrid - 1) gsd = spanMax / (maxGrid - 1)

  const width = Math.max(1, Math.ceil((maxX - minX) / gsd) + 1)
  const height = Math.max(1, Math.ceil((maxY - minY) / gsd) + 1)
  // Top-left origin: row 0 is the max-Y edge.
  return { points, width, height, gsd, originX: minX, originY: maxY, requestedGsd }
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
//           mask:Uint8Array (1=has data, incl. filled), support:Uint8Array (255 = a
//           cell points landed in, 0 = filled by interpolation or empty), zMin, zMax,
//           count, filled, holesFilled (of `filled`, the cells `fillHoles` interpolated),
//           aggregate (the one used: a median past the budget becomes the mean) }.
//     fillHoles  — after the radius fill, also interpolate every enclosed nodata
//                  area (fillEnclosedGaps): the ground under removed buildings
export function rasterizeDem(allPoints, opts = {}) {
  const { fillMethod = 'idw', fillRadius = 2, fillHoles = false } = opts
  let { aggregate = 'max' } = opts
  const geom = demGeometry(allPoints, opts)
  if (!geom) return null
  const { points, width, height, gsd, originX, originY } = geom
  const cells = width * height
  // Grid planes (data, measured, mask, the mean path's sum + count) ≈ 24 B/cell;
  // median adds a cell-offset table and one Float64 per point.
  const budget = Number.isFinite(opts.memBudgetBytes) ? opts.memBudgetBytes : DEFAULT_BUDGET_BYTES
  const base = cells * 24 + (fillHoles ? cells * ENCLOSED_FILL_BYTES_PER_CELL : 0)
  // Median is the default; a cloud too big for its per-point buffer takes the mean,
  // which is as unbiased on slopes and needs none (the caller reports the swap).
  if (aggregate === 'median' && base + cells * 4 + points.length * 8 > budget && base <= budget) aggregate = 'mean'
  const need = base + (aggregate === 'median' ? cells * 4 + points.length * 8 : 0)
  if (!Number.isSafeInteger(cells) || need > budget) {
    throw new Error(
      `DEM raster (${width}×${height}) needs ${formatBytes(need)}, over the ` +
        `${formatBytes(budget)} working-memory limit; increase GSD or reduce the grid size`,
    )
  }
  const {
    data,
    measured,
    count,
    filled: radiusFilled,
  } = rasterizeWindow(points, { width, height, gsd, originX, originY }, { aggregate, fillMethod, fillRadius })
  // Direct support, the DEM's record of where it was measured rather than filled.
  const support = measured
  for (let i = 0; i < cells; i++) if (support[i]) support[i] = 255
  let filled = radiusFilled
  const holesFilled = fillHoles ? fillEnclosedGaps(data, width, height) : 0
  filled += holesFilled

  const mask = new Uint8Array(cells)
  let zMin = Infinity,
    zMax = -Infinity
  for (let i = 0; i < cells; i++) {
    if (!Number.isNaN(data[i])) {
      mask[i] = 1
      if (data[i] < zMin) zMin = data[i]
      if (data[i] > zMax) zMax = data[i]
    }
  }
  if (zMin > zMax) {
    zMin = 0
    zMax = 0
  }

  return {
    width,
    height,
    gsd,
    originX,
    originY,
    data,
    mask,
    support,
    zMin,
    zMax,
    count,
    filled,
    holesFilled,
    aggregate,
  }
}

// The support plane of a tiled DEM's overview: each overview cell gets the share of
// its full-resolution DEM cells that points landed in, 0–255 (255 = all measured).
// `scale` full cells per overview cell a side (2^k for COG level k, whose size halves
// with floor, so the last odd row and column fall outside, as in the COG's own level).
// add() takes rasterizeDemBlocks' blocks ({ col0, row0, width, height, data, measured }).
export function createSupportOverview(ovWidth, ovHeight, scale) {
  const measured = new Uint32Array(ovWidth * ovHeight)
  const valid = new Uint32Array(ovWidth * ovHeight)
  return {
    add({ col0, row0, width, height, data, measured: m }) {
      for (let r = 0; r < height; r++) {
        const oy = Math.floor((row0 + r) / scale)
        if (oy >= ovHeight) break
        for (let c = 0; c < width; c++) {
          const ox = Math.floor((col0 + c) / scale)
          if (ox >= ovWidth) break
          const i = r * width + c
          if (Number.isNaN(data[i])) continue
          const o = oy * ovWidth + ox
          valid[o]++
          if (m[i]) measured[o]++
        }
      }
    },
    finish() {
      const out = new Uint8Array(ovWidth * ovHeight)
      for (let i = 0; i < out.length; i++) if (valid[i]) out[i] = Math.round((255 * measured[i]) / valid[i])
      return out
    },
  }
}

// Aggregate `points` into the cells of one grid window ({ width, height, gsd, originX,
// originY }, top-left origin) and fill its holes within `fillRadius`. Points outside
// the window are skipped. A block of a tiled DEM is a window over its core plus a halo
// of `fillRadius` cells: aggregation is per cell and the fill reads only measured cells
// within the radius, so the core comes out exactly as from the whole grid.
// → { data: Float32Array (NaN = nodata), count (measured cells), filled }
export function rasterizeWindow(points, geom, { aggregate = 'max', fillMethod = 'idw', fillRadius = 2 } = {}) {
  const { width, height, gsd, originX, originY } = geom
  const cells = width * height
  const data = new Float32Array(cells).fill(NaN)
  const cellOf = (p) => {
    const col = Math.floor((p.x - originX) / gsd),
      row = Math.floor((originY - p.y) / gsd)
    // A point on the window's far edge (x = originX + width·gsd) belongs to its last cell.
    const c = col === width && p.x - originX <= width * gsd ? width - 1 : col
    const r = row === height && originY - p.y <= height * gsd ? height - 1 : row
    return c >= 0 && c < width && r >= 0 && r < height ? r * width + c : -1
  }

  if (aggregate === 'median') {
    // Counting sort by cell into one typed buffer — no per-cell JS arrays or Map,
    // so it costs ArrayBuffer memory (accounted by the caller), not V8 heap. off[i]
    // ends as cell i's first slot: prefix sums give each cell's end, and the scatter
    // fills every cell from its end downwards.
    const off = new Uint32Array(cells + 1)
    let n = 0
    for (const p of points) {
      const i = cellOf(p)
      if (i >= 0) {
        off[i]++
        n++
      }
    }
    for (let i = 1; i < cells; i++) off[i] += off[i - 1]
    off[cells] = n
    const zs = new Float64Array(n)
    for (const p of points) {
      const i = cellOf(p)
      if (i >= 0) zs[--off[i]] = p.z
    }
    for (let i = 0; i < cells; i++) {
      const a = off[i],
        b = off[i + 1]
      if (b === a) continue
      const seg = zs.subarray(a, b).sort()
      data[i] = seg[(b - a) >> 1]
    }
  } else if (aggregate === 'mean') {
    const sum = new Float64Array(cells)
    const cnt = new Uint32Array(cells)
    for (const p of points) {
      const idx = cellOf(p)
      if (idx >= 0) {
        sum[idx] += p.z
        cnt[idx]++
      }
    }
    for (let i = 0; i < cells; i++) if (cnt[i]) data[i] = sum[i] / cnt[i]
  } else {
    const takeMax = aggregate !== 'min'
    for (const p of points) {
      const idx = cellOf(p)
      if (idx < 0) continue
      const cur = data[idx]
      if (Number.isNaN(cur)) data[idx] = p.z
      else if (takeMax ? p.z > cur : p.z < cur) data[idx] = p.z
    }
  }

  // Validity mask before filling (so IDW reads only measured cells).
  const measured = new Uint8Array(cells)
  let count = 0
  for (let i = 0; i < cells; i++)
    if (!Number.isNaN(data[i])) {
      measured[i] = 1
      count++
    }
  const filled =
    fillMethod !== 'none' && fillRadius > 0 ? fillNodata(data, measured, width, height, fillRadius, fillMethod) : 0
  return { data, measured, count, filled }
}

// A DEM too big for one plane (SAT-3), block by block. `pos` (Float64 xyz in the frame,
// `count` points; those outside `opts.bounds` left out, as demGeometry does) is binned
// by block once; each block's window is its core plus a halo
// of `fillRadius` cells, rasterised by rasterizeWindow, and its core handed to
// `onBlock({ col0, row0, width, height, data, measured })` (awaited, Float32 heights,
// NaN = nodata; measured 1 where points landed) in row-major block order. `geom` is demGeometry's grid (any size). Enclosed
// gaps (fillHoles) need the whole grid and are not filled here.
// → { width, height, gsd, originX, originY, count, filled, zMin, zMax, blocks }
export async function rasterizeDemBlocks(pos, count, geom, opts = {}, { onBlock, onProgress = () => {} } = {}) {
  const { aggregate = 'max', fillMethod = 'idw', fillRadius = 2, blockSize = 2048, bounds = null } = opts
  const { width: W, height: H, gsd, originX, originY } = geom
  const B = blockSize,
    halo = fillMethod !== 'none' ? Math.max(0, fillRadius) : 0
  if (halo > B) throw new Error(`rasterizeDemBlocks: fill radius ${halo} exceeds the block size ${B}`)
  const nbx = Math.ceil(W / B),
    nby = Math.ceil(H / B),
    nBlocks = nbx * nby

  // Bin the points by the block their cell is in (counting sort; outside points dropped).
  const blockOf = new Int32Array(count)
  const start = new Uint32Array(nBlocks + 1)
  for (let i = 0; i < count; i++) {
    const x = pos[3 * i],
      y = pos[3 * i + 1]
    const col = Math.floor((x - originX) / gsd),
      row = Math.floor((originY - y) / gsd)
    if (
      !(col >= 0 && row >= 0 && col < W && row < H) ||
      (bounds && !(x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY))
    ) {
      blockOf[i] = -1
      continue
    }
    const bi = Math.floor(row / B) * nbx + Math.floor(col / B)
    blockOf[i] = bi
    start[bi + 1]++
  }
  for (let k = 0; k < nBlocks; k++) start[k + 1] += start[k]
  const order = new Uint32Array(start[nBlocks])
  {
    const next = start.slice(0, nBlocks)
    for (let i = 0; i < count; i++) if (blockOf[i] >= 0) order[next[blockOf[i]]++] = i
  }

  let measuredCells = 0,
    filled = 0,
    zMin = Infinity,
    zMax = -Infinity
  const pt = { x: 0, y: 0, z: 0 }
  for (let by = 0; by < nby; by++)
    for (let bx = 0; bx < nbx; bx++) {
      const col0 = bx * B,
        row0 = by * B,
        bw = Math.min(B, W - col0),
        bh = Math.min(B, H - row0)
      const ex0 = Math.max(0, col0 - halo),
        ey0 = Math.max(0, row0 - halo)
      const ew = Math.min(W, col0 + bw + halo) - ex0,
        eh = Math.min(H, row0 + bh + halo) - ey0
      // The window's points: this block's and its neighbours' (the halo is ≤ one block).
      // One reused object: rasterizeWindow reads each point before taking the next.
      const sources = []
      for (let ny = Math.max(0, by - 1); ny <= Math.min(nby - 1, by + 1); ny++) {
        for (let nx = Math.max(0, bx - 1); nx <= Math.min(nbx - 1, bx + 1); nx++) {
          const k = ny * nbx + nx
          if (start[k + 1] > start[k]) sources.push(k)
        }
      }
      const points = {
        *[Symbol.iterator]() {
          for (const k of sources)
            for (let j = start[k]; j < start[k + 1]; j++) {
              const i = order[j]
              pt.x = pos[3 * i]
              pt.y = pos[3 * i + 1]
              pt.z = pos[3 * i + 2]
              yield pt
            }
        },
      }
      const win = rasterizeWindow(
        points,
        { width: ew, height: eh, gsd, originX: originX + ex0 * gsd, originY: originY - ey0 * gsd },
        { aggregate, fillMethod, fillRadius },
      )
      const core = new Float32Array(bw * bh)
      const coreMeasured = new Uint8Array(bw * bh)
      const cx = col0 - ex0,
        cy = row0 - ey0
      for (let r = 0; r < bh; r++) {
        const src = (cy + r) * ew + cx
        core.set(win.data.subarray(src, src + bw), r * bw)
        coreMeasured.set(win.measured.subarray(src, src + bw), r * bw)
        for (let c = 0; c < bw; c++) {
          const z = core[r * bw + c]
          if (Number.isNaN(z)) continue
          if (win.measured[src + c]) measuredCells++
          else filled++
          if (z < zMin) zMin = z
          if (z > zMax) zMax = z
        }
      }
      await onBlock?.({ col0, row0, width: bw, height: bh, data: core, measured: coreMeasured })
      onProgress(by * nbx + bx + 1, nBlocks)
    }
  if (zMin > zMax) {
    zMin = 0
    zMax = 0
  }
  return { width: W, height: H, gsd, originX, originY, count: measuredCells, filled, zMin, zMax, blocks: nBlocks }
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
      let wsum = 0,
        vsum = 0
      let nearest = -1,
        nearestD2 = Infinity
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
          if (d2 < nearestD2) {
            nearestD2 = d2
            nearest = nIdx
          }
          const w = 1 / d2
          wsum += w
          vsum += w * data[nIdx]
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

// Working memory of fillEnclosedGaps per grid cell: the exterior mask and queue
// (5 B) plus a pull–push pyramid of Float64 values and Float32 weights (12 B per
// cell, 4/3 of that over all levels).
export const ENCLOSED_FILL_BYTES_PER_CELL = 21

// Fill every ENCLOSED nodata area — one that does not reach the grid border —
// with a smooth surface from the measured cells around it. This is what a DTM
// needs once buildings and trees are removed: the ground under a roof was never
// seen, and a radius-limited fill (fillNodata) leaves a building-sized hole.
// Nodata reaching the border is the edge of the survey and stays nodata, so the
// grid never grows past what was measured.
//
// Method: pull–push (Gortler et al. 1996). Pull averages the grid into a pyramid
// of halved levels, each cell the weighted mean of its 2×2 children with weight
// min(1, Σ child weights), until one cell remains. Push walks back down: a cell's
// value blends its own mean with the bilinearly sampled level above it by its
// weight, so an empty cell takes the coarse surface and a partly empty one a mix.
// Only the enclosed cells of the finest level are written. O(cells), no
// iteration count to choose, and a hole of any size is spanned.
// Writes into `data` (NaN = nodata); returns the number of cells filled.
export function fillEnclosedGaps(data, width, height) {
  const n = width * height
  // The exterior: nodata cells connected to the border through nodata.
  const outside = new Uint8Array(n)
  const queue = new Int32Array(n)
  let head = 0,
    tail = 0
  const seed = (k) => {
    if (!outside[k] && Number.isNaN(data[k])) {
      outside[k] = 1
      queue[tail++] = k
    }
  }
  for (let c = 0; c < width; c++) {
    seed(c)
    seed((height - 1) * width + c)
  }
  for (let r = 0; r < height; r++) {
    seed(r * width)
    seed(r * width + width - 1)
  }
  while (head < tail) {
    const k = queue[head++]
    const r = (k / width) | 0,
      c = k - r * width
    if (c > 0) seed(k - 1)
    if (c < width - 1) seed(k + 1)
    if (r > 0) seed(k - width)
    if (r < height - 1) seed(k + width)
  }
  let enclosed = 0,
    measured = 0
  for (let k = 0; k < n; k++) {
    if (!Number.isNaN(data[k])) measured++
    else if (!outside[k]) enclosed++
  }
  if (!enclosed || !measured) return 0

  // Pull.
  const levels = []
  {
    const val = new Float64Array(n),
      wt = new Float32Array(n)
    for (let k = 0; k < n; k++)
      if (!Number.isNaN(data[k])) {
        val[k] = data[k]
        wt[k] = 1
      }
    levels.push({ w: width, h: height, val, wt })
  }
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const { w, h, val, wt } = levels[levels.length - 1]
    const w2 = Math.ceil(w / 2),
      h2 = Math.ceil(h / 2)
    const v2 = new Float64Array(w2 * h2),
      t2 = new Float32Array(w2 * h2)
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const t = wt[r * w + c]
        if (!t) continue
        const p = (r >> 1) * w2 + (c >> 1)
        v2[p] += t * val[r * w + c]
        t2[p] += t
      }
    }
    for (let p = 0; p < v2.length; p++) {
      if (t2[p] > 0) {
        v2[p] /= t2[p]
        t2[p] = Math.min(1, t2[p])
      }
    }
    levels.push({ w: w2, h: h2, val: v2, wt: t2 })
  }

  // Push: every coarser level is complete before the finer one samples it.
  for (let l = levels.length - 2; l >= 0; l--) {
    const { w, h, val, wt } = levels[l]
    const up = levels[l + 1]
    const finest = l === 0
    for (let r = 0; r < h; r++) {
      // This cell's centre in the coarser level's cell coordinates.
      const fy = Math.min(up.h - 1, Math.max(0, (r + 0.5) / 2 - 0.5))
      const r0 = Math.floor(fy),
        r1 = Math.min(up.h - 1, r0 + 1),
        ty = fy - r0
      for (let c = 0; c < w; c++) {
        const k = r * w + c
        const t = wt[k]
        if (t >= 1) continue
        if (finest && outside[k]) continue
        const fx = Math.min(up.w - 1, Math.max(0, (c + 0.5) / 2 - 0.5))
        const c0 = Math.floor(fx),
          c1 = Math.min(up.w - 1, c0 + 1),
          tx = fx - c0
        const a = up.val[r0 * up.w + c0] * (1 - tx) + up.val[r0 * up.w + c1] * tx
        const b = up.val[r1 * up.w + c0] * (1 - tx) + up.val[r1 * up.w + c1] * tx
        const coarse = a * (1 - ty) + b * ty
        val[k] = t * val[k] + (1 - t) * coarse
        if (!finest) wt[k] = 1
      }
    }
  }
  const fine = levels[0].val
  for (let k = 0; k < n; k++) if (Number.isNaN(data[k]) && !outside[k]) data[k] = fine[k]
  return enclosed
}
