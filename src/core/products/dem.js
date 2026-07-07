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

// Rasterise `points` ({x,y,z} in the frame) into a height grid.
//   opts:
//     gsd        — cell size in frame units; auto (suggestGsd) when omitted
//     aggregate  — 'max'(default DSM) | 'min' | 'mean' | 'median'
//     fillRadius — cells; IDW hole-fill search radius (0 = no fill)
//     maxGrid    — hard cap on the longer grid side; gsd is grown to respect it
// Returns { width, height, gsd, originX, originY, data:Float32Array (NaN=nodata),
//           mask:Uint8Array (1=has data, incl. filled), zMin, zMax, count, filled }.
export function rasterizeDem(points, opts = {}) {
  const { aggregate = 'max', fillRadius = 2, maxGrid = 4096 } = opts
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
  const data = new Float32Array(cells).fill(NaN)

  const colOf = (x) => Math.min(width - 1, Math.max(0, Math.floor((x - originX) / gsd)))
  const rowOf = (y) => Math.min(height - 1, Math.max(0, Math.floor((originY - y) / gsd)))

  if (aggregate === 'median') {
    // Per-cell buckets — heavier, so gated to reasonable grids by maxGrid above.
    const buckets = new Map()
    for (const p of points) {
      const idx = rowOf(p.y) * width + colOf(p.x)
      let arr = buckets.get(idx)
      if (!arr) { arr = []; buckets.set(idx, arr) }
      arr.push(p.z)
    }
    for (const [idx, arr] of buckets) {
      arr.sort((a, b) => a - b)
      data[idx] = arr[arr.length >> 1]
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
  if (fillRadius > 0) filled = idwFill(data, measured, width, height, fillRadius)

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
function idwFill(data, measured, width, height, radius) {
  let filled = 0
  const r2 = radius * radius
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col
      if (measured[idx]) continue
      let wsum = 0, vsum = 0
      for (let dr = -radius; dr <= radius; dr++) {
        const rr = row + dr
        if (rr < 0 || rr >= height) continue
        for (let dc = -radius; dc <= radius; dc++) {
          const cc = col + dc
          if (cc < 0 || cc >= width) continue
          const d2 = dr * dr + dc * dc
          if (d2 === 0 || d2 > r2) continue
          const nIdx = rr * width + cc
          if (!measured[nIdx]) continue
          const w = 1 / d2
          wsum += w; vsum += w * data[nIdx]
        }
      }
      if (wsum > 0) { data[idx] = vsum / wsum; filled++ }
    }
  }
  return filled
}
