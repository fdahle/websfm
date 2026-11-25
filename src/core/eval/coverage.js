// Pure top-down coverage/overlap binning for the Quality Report ▸ Coverage section
// (PLAN-eval-quality-hub WS4). Answers "where is my survey thin" — bins tie points
// into an XY grid and reports, per cell, the point count and the MAX view count
// (how many images see that patch of ground; 2 = bare minimum, ≥3 comfortable).
//
// No Vue/Pinia/DOM. Points + camera centres in a chosen 2D frame (the caller picks
// SfM or the local-vertical georef frame and passes already-projected x,y), plain
// typed-array grid out — the section paints it to a canvas.

import { fillArray } from '../bigArray.js'

// points: SparsePoints (x, y are the planar coords; viewCount the views). cams: [{ x, y }] camera centres (same frame). opts:
//   { targetCells = 60 } — approx number of cells along the longer axis.
// → { cols, rows, cellSize, minX, minY, count:Uint32Array, maxViews:Uint16Array,
//     maxCount, cams:[{x,y}], bbox:{minX,minY,maxX,maxY} }
// count[r*cols+c] = tie points in the cell; maxViews = largest view count seen there.
export function coverageGrid(points, cams = [], opts = {}) {
  const targetCells = opts.targetCells || 60
  const pts = points
  if (!pts?.length) {
    return {
      cols: 0,
      rows: 0,
      cellSize: 0,
      minX: 0,
      minY: 0,
      count: new Uint32Array(0),
      maxViews: new Uint16Array(0),
      maxCount: 0,
      cams: cams.map((c) => ({ x: c.x, y: c.y })),
      bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    }
  }

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const x = pts.x(i),
      y = pts.y(i)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const spanX = Math.max(1e-9, maxX - minX)
  const spanY = Math.max(1e-9, maxY - minY)
  const cellSize = Math.max(spanX, spanY) / targetCells
  const cols = Math.max(1, Math.ceil(spanX / cellSize))
  const rows = Math.max(1, Math.ceil(spanY / cellSize))

  const count = new Uint32Array(cols * rows)
  const maxViews = new Uint16Array(cols * rows)
  let maxCount = 0
  for (let i = 0; i < n; i++) {
    const c = Math.min(cols - 1, Math.floor((pts.x(i) - minX) / cellSize))
    const r = Math.min(rows - 1, Math.floor((pts.y(i) - minY) / cellSize))
    const idx = r * cols + c
    count[idx]++
    if (count[idx] > maxCount) maxCount = count[idx]
    const v = pts.viewCount(i)
    if (v > maxViews[idx]) maxViews[idx] = v
  }

  return {
    cols,
    rows,
    cellSize,
    minX,
    minY,
    count,
    maxViews,
    maxCount,
    cams: cams.map((c) => ({ x: c.x, y: c.y })),
    bbox: { minX, minY, maxX, maxY },
  }
}

// Photo overlap for Quality Report ▸ Coverage (aerial projects): how many photos see each
// patch of ground, as Metashape's image-overlap map shows it. Unlike coverageGrid it counts
// photos, not tie points: a patch two photos cover and matching found nothing on still
// reads 2, and a long track from the next strip does not make a two-photo patch look like
// three. Where only two photos see the ground, the dense cloud has a single other view to
// confirm each depth.
//
// The ground is the tie points' surface: each cell's height is the median of the points
// in it, empty cells take their neighbours' (and, far from any point, the median of all).
// Each cell centre on that surface is projected into every photo, counted when it lands in
// front of the camera and inside its frame. The photo's lens is ignored (its distortion is
// folded into the keypoints; a few pixels at the frame's edge do not change a count).
//
// points: SparsePoints (x, y planar, z up). cameras: [{ R, t, K, width?, height? }] in the
// same frame (width / height default to twice the principal point).
// opts: { targetCells = 240 } along the longer axis.
// → { cols, rows, cellSize, minX, minY, views: Uint16Array (photos per cell), maxViews,
//     shares: { one, two, threePlus } (fractions of the cells at least one photo sees),
//     cams: [{ x, y }] }
export function overlapGrid(points, cameras, opts = {}) {
  const target = opts.targetCells || 240
  const n = points?.length ?? 0
  const cams = (cameras ?? []).filter((c) => c?.R && c?.t && c?.K)
  const empty = {
    cols: 0,
    rows: 0,
    cellSize: 0,
    minX: 0,
    minY: 0,
    views: new Uint16Array(0),
    maxViews: 0,
    shares: { one: 0, two: 0, threePlus: 0 },
    cams: [],
  }
  if (!n || !cams.length) return empty

  // The ground's extent: the tie points between their 0.5th and 99.5th percentile on
  // each axis (a few stray points far off must not stretch the map), grown by 5 %.
  const xs = new Float64Array(n),
    ys = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    xs[i] = points.x(i)
    ys[i] = points.y(i)
  }
  const sx = Float64Array.from(xs).sort(),
    sy = Float64Array.from(ys).sort()
  const q = (a, f) => a[Math.min(n - 1, Math.max(0, Math.floor(f * (n - 1))))]
  let minX = q(sx, 0.005),
    maxX = q(sx, 0.995),
    minY = q(sy, 0.005),
    maxY = q(sy, 0.995)
  const padX = 0.05 * Math.max(maxX - minX, 1e-9),
    padY = 0.05 * Math.max(maxY - minY, 1e-9)
  minX -= padX
  maxX += padX
  minY -= padY
  maxY += padY
  const cellSize = Math.max(maxX - minX, maxY - minY) / target
  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize)),
    rows = Math.max(1, Math.ceil((maxY - minY) / cellSize))
  const N = cols * rows

  // Ground height per cell: the median z of its points.
  const cellOf = new Int32Array(n)
  const counts = new Uint32Array(N)
  for (let i = 0; i < n; i++) {
    const c = Math.floor((xs[i] - minX) / cellSize),
      r = Math.floor((ys[i] - minY) / cellSize)
    cellOf[i] = c < 0 || c >= cols || r < 0 || r >= rows ? -1 : r * cols + c
    if (cellOf[i] >= 0) counts[cellOf[i]]++
  }
  const start = new Uint32Array(N + 1)
  for (let k = 0; k < N; k++) start[k + 1] = start[k] + counts[k]
  const zs = new Float64Array(start[N])
  const fill = start.slice(0, N)
  for (let i = 0; i < n; i++) if (cellOf[i] >= 0) zs[fill[cellOf[i]]++] = points.z(i)
  const ground = fillArray(new Float64Array(N), NaN)
  for (let k = 0; k < N; k++) {
    if (!counts[k]) continue
    const s = zs.subarray(start[k], start[k + 1]).sort()
    ground[k] = s[s.length >> 1]
  }
  const all = zs.slice().sort()
  const zMedian = all.length ? all[all.length >> 1] : 0
  // Empty cells: the mean of their filled neighbours, grown outwards a ring at a time.
  for (let pass = 0; pass < 8; pass++) {
    const next = ground.slice()
    let changed = false
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const k = r * cols + c
        if (!Number.isNaN(ground[k])) continue
        let sum = 0,
          m = 0
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr,
              cc = c + dc
            if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue
            const g = ground[rr * cols + cc]
            if (!Number.isNaN(g)) {
              sum += g
              m++
            }
          }
        }
        if (m) {
          next[k] = sum / m
          changed = true
        }
      }
    }
    ground.set(next)
    if (!changed) break
  }
  for (let k = 0; k < N; k++) if (Number.isNaN(ground[k])) ground[k] = zMedian

  // Count the photos per cell. Each photo only tests the cells its frame can reach: its
  // corner rays met with the median ground plane give that box (grown by a quarter); a
  // photo whose corner rays miss the plane (looking at the horizon) tests every cell.
  const views = new Uint16Array(N)
  const centres = []
  for (const cam of cams) {
    const { R, t, K } = cam
    const w = cam.width ?? 2 * K.cx,
      h = cam.height ?? 2 * K.cy
    const C = [0, 1, 2].map((j) => -(R[0][j] * t[0] + R[1][j] * t[1] + R[2][j] * t[2]))
    centres.push({ x: C[0], y: C[1] })
    let c0 = 0,
      c1 = cols - 1,
      r0 = 0,
      r1 = rows - 1
    const hits = []
    for (const [u, v] of [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ]) {
      const dc = [(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1]
      const d = [0, 1, 2].map((j) => R[0][j] * dc[0] + R[1][j] * dc[1] + R[2][j] * dc[2])
      if (!(d[2] < -1e-9) || !(C[2] > zMedian)) break
      const s = (zMedian - C[2]) / d[2]
      hits.push([C[0] + s * d[0], C[1] + s * d[1]])
    }
    if (hits.length === 4) {
      let x0 = Infinity,
        x1 = -Infinity,
        y0 = Infinity,
        y1 = -Infinity
      for (const [x, y] of hits) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
      const gx = 0.25 * (x1 - x0),
        gy = 0.25 * (y1 - y0)
      c0 = Math.max(0, Math.floor((x0 - gx - minX) / cellSize))
      c1 = Math.min(cols - 1, Math.floor((x1 + gx - minX) / cellSize))
      r0 = Math.max(0, Math.floor((y0 - gy - minY) / cellSize))
      r1 = Math.min(rows - 1, Math.floor((y1 + gy - minY) / cellSize))
    }
    for (let r = r0; r <= r1; r++) {
      const y = minY + (r + 0.5) * cellSize
      for (let c = c0; c <= c1; c++) {
        const k = r * cols + c
        const x = minX + (c + 0.5) * cellSize,
          z = ground[k]
        const zc = R[2][0] * x + R[2][1] * y + R[2][2] * z + t[2]
        if (!(zc > 1e-9)) continue
        const u = (K.fx * (R[0][0] * x + R[0][1] * y + R[0][2] * z + t[0])) / zc + K.cx
        if (u < 0 || u >= w) continue
        const v = (K.fy * (R[1][0] * x + R[1][1] * y + R[1][2] * z + t[1])) / zc + K.cy
        if (v < 0 || v >= h) continue
        if (views[k] < 65535) views[k]++
      }
    }
  }

  let seen = 0,
    one = 0,
    two = 0,
    maxViews = 0
  for (let k = 0; k < N; k++) {
    const v = views[k]
    if (!v) continue
    seen++
    if (v === 1) one++
    else if (v === 2) two++
    if (v > maxViews) maxViews = v
  }
  const share = (m) => (seen ? m / seen : 0)
  return {
    cols,
    rows,
    cellSize,
    minX,
    minY,
    views,
    maxViews,
    shares: { one: share(one), two: share(two), threePlus: share(seen - one - two) },
    cams: centres,
  }
}
