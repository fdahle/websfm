// Reprojecting a raster into another CRS — pure: the caller supplies the two point
// transforms (proj4 in the export worker, workers/ops/export.js warpRaster), so this
// module never loads a CRS. Used to export a DEM or orthophoto in a CRS other than the
// one it was built in (plan-dense-past-one-tab P5).
//
// Grids are pixel-is-area, as every computed raster: cell (col, row) covers
// [originX + col·gsd, originX + (col+1)·gsd] × [originY − (row+1)·gsd, originY − row·gsd],
// its centre half a cell in. Source positions below are in source PIXEL units with
// integer values at cell centres (u = (x − originX) / gsd − ½), which is what a
// bilinear sample needs.

const EDGE_SAMPLES = 64

/** The output grid for warping `src` ({ width, height, gsd, originX, originY }) with
 *  `forward(x, y) → [x, y]` (source CRS → target CRS): the bounding box of the source
 *  outline (each edge densified, so a curved edge still bounds), and a cell of the same
 *  ground size as the source's at its centre unless `gsd` is given. Throws when the
 *  outline does not transform (outside the target CRS's domain). */
export function warpGrid(src, forward, { gsd = 0 } = {}) {
  const { width: W, height: H, gsd: g, originX: ox, originY: oy } = src
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity
  const add = (x, y) => {
    const [tx, ty] = forward(x, y)
    if (!Number.isFinite(tx) || !Number.isFinite(ty))
      throw new Error("the raster's outline lies outside the target CRS")
    if (tx < minX) minX = tx
    if (tx > maxX) maxX = tx
    if (ty < minY) minY = ty
    if (ty > maxY) maxY = ty
  }
  for (let k = 0; k <= EDGE_SAMPLES; k++) {
    const t = k / EDGE_SAMPLES
    add(ox + t * W * g, oy)
    add(ox + t * W * g, oy - H * g)
    add(ox, oy - t * H * g)
    add(ox + W * g, oy - t * H * g)
  }
  let cell = gsd
  if (!(cell > 0)) {
    // The source centre cell's image is a parallelogram; keep its area.
    const cx = ox + (W * g) / 2,
      cy = oy - (H * g) / 2
    const p0 = forward(cx, cy),
      px = forward(cx + g, cy),
      py = forward(cx, cy - g)
    cell = Math.sqrt(Math.abs((px[0] - p0[0]) * (py[1] - p0[1]) - (px[1] - p0[1]) * (py[0] - p0[0])))
  }
  if (!(cell > 0)) throw new Error('the raster has no extent in the target CRS')
  return {
    width: Math.max(1, Math.ceil((maxX - minX) / cell)),
    height: Math.max(1, Math.ceil((maxY - minY) / cell)),
    gsd: cell,
    originX: minX,
    originY: maxY,
  }
}

/** For the output cells [col0, col0+w) × [row0, row0+h) of grid `out`, where each lands
 *  in `src`, in source pixel units (NaN outside the inverse's domain). `inverse(x, y)`:
 *  target CRS → source CRS. The inverse runs on a lattice every `step` cells and is
 *  interpolated between; where that misses the exact position by more than `tol` px at
 *  a lattice cell's centre, the lattice is refined, down to every cell.
 *  → { sx: Float64Array, sy: Float64Array, step } */
export function warpSourceCoords(out, src, inverse, col0, row0, w, h, { step = 16, tol = 0.1 } = {}) {
  const exact = (c, r) => {
    const [x, y] = inverse(out.originX + (col0 + c + 0.5) * out.gsd, out.originY - (row0 + r + 0.5) * out.gsd)
    return [(x - src.originX) / src.gsd - 0.5, (src.originY - y) / src.gsd - 0.5]
  }
  for (let s = Math.max(1, Math.floor(step)); ; s = Math.max(1, s >> 1)) {
    const res = s === 1 ? null : latticeCoords(exact, w, h, s, tol)
    if (res) return { ...res, step: s }
    if (s === 1) {
      const sx = new Float64Array(w * h),
        sy = new Float64Array(w * h)
      for (let r = 0; r < h; r++)
        for (let c = 0; c < w; c++) {
          const [u, v] = exact(c, r)
          sx[r * w + c] = Number.isFinite(u) ? u : NaN
          sy[r * w + c] = Number.isFinite(v) ? v : NaN
        }
      return { sx, sy, step: 1 }
    }
  }
}

// Interpolated positions from a lattice every `s` cells (its last node on the last cell),
// or null when a lattice cell's centre is off by more than `tol` px (or a node failed).
function latticeCoords(exact, w, h, s, tol) {
  const nodes = (n) => {
    const a = []
    for (let i = 0; i < n - 1; i += s) a.push(i)
    a.push(n - 1)
    return a
  }
  const cs = nodes(w),
    rs = nodes(h),
    nx = cs.length
  const lu = new Float64Array(nx * rs.length),
    lv = new Float64Array(nx * rs.length)
  for (let j = 0; j < rs.length; j++)
    for (let i = 0; i < nx; i++) {
      const [u, v] = exact(cs[i], rs[j])
      if (!Number.isFinite(u) || !Number.isFinite(v)) return null
      lu[j * nx + i] = u
      lv[j * nx + i] = v
    }
  const at = (arr, i, j, fx, fy) => {
    const a = arr[j * nx + i],
      b = arr[j * nx + Math.min(i + 1, nx - 1)]
    const c = arr[Math.min(j + 1, rs.length - 1) * nx + i],
      d = arr[Math.min(j + 1, rs.length - 1) * nx + Math.min(i + 1, nx - 1)]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
  }
  const frac = (n, k) => {
    const span = n[k + 1] - n[k]
    return span > 0 ? span : 1
  }
  // The check: each lattice cell's centre, exact against interpolated.
  for (let j = 0; j < rs.length - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const c = (cs[i] + cs[i + 1]) / 2,
        r = (rs[j] + rs[j + 1]) / 2
      const [u, v] = exact(c, r)
      if (!Number.isFinite(u) || !Number.isFinite(v)) return null
      const fx = (c - cs[i]) / frac(cs, i),
        fy = (r - rs[j]) / frac(rs, j)
      if (Math.hypot(at(lu, i, j, fx, fy) - u, at(lv, i, j, fx, fy) - v) > tol) return null
    }
  const sx = new Float64Array(w * h),
    sy = new Float64Array(w * h)
  for (let j = 0, r = 0; r < h; r++) {
    while (j < rs.length - 2 && r >= rs[j + 1]) j++
    const fy = rs.length > 1 ? (r - rs[j]) / frac(rs, j) : 0
    for (let i = 0, c = 0; c < w; c++) {
      while (i < nx - 2 && c >= cs[i + 1]) i++
      const fx = nx > 1 ? (c - cs[i]) / frac(cs, i) : 0
      sx[r * w + c] = at(lu, i, j, fx, fy)
      sy[r * w + c] = at(lv, i, j, fx, fy)
    }
  }
  return { sx, sy }
}

/** The source window [x0, x1) × [y0, y1) the positions reach (with the bilinear
 *  neighbour), clipped to the source; null when they reach none of it. */
export function sourceWindow(sx, sy, src) {
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity
  for (let i = 0; i < sx.length; i++) {
    const u = sx[i],
      v = sy[i]
    if (!(u >= -0.5 && v >= -0.5 && u <= src.width - 0.5 && v <= src.height - 0.5)) continue
    if (u < x0) x0 = u
    if (u > x1) x1 = u
    if (v < y0) y0 = v
    if (v > y1) y1 = v
  }
  if (x0 > x1) return null
  return {
    x0: Math.max(0, Math.floor(x0)),
    y0: Math.max(0, Math.floor(y0)),
    x1: Math.min(src.width, Math.floor(x1) + 2),
    y1: Math.min(src.height, Math.floor(y1) + 2),
  }
}

/** Sample a window of an RGBA source (`data`, `ww` × `wh`, its top-left at source pixel
 *  `x0`, `y0`) at the positions, into `out` (RGBA). Bilinear where all four neighbours
 *  are opaque, else the nearest cell's colour when it is opaque, else transparent;
 *  `nearest` samples the nearest cell everywhere. */
export function sampleRgbaWarp(data, ww, wh, x0, y0, sx, sy, out, { nearest = false } = {}) {
  for (let i = 0; i < sx.length; i++) {
    const o = i * 4
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0
    const u = sx[i] - x0,
      v = sy[i] - y0
    if (!(u >= -0.5 && v >= -0.5 && u <= ww - 0.5 && v <= wh - 0.5)) continue
    const ni = (Math.min(wh - 1, Math.max(0, Math.round(v))) * ww + Math.min(ww - 1, Math.max(0, Math.round(u)))) * 4
    const c0 = Math.max(0, Math.min(ww - 1, Math.floor(u))),
      r0 = Math.max(0, Math.min(wh - 1, Math.floor(v)))
    const c1 = Math.min(ww - 1, c0 + 1),
      r1 = Math.min(wh - 1, r0 + 1)
    const a = (r0 * ww + c0) * 4,
      b = (r0 * ww + c1) * 4,
      c = (r1 * ww + c0) * 4,
      d = (r1 * ww + c1) * 4
    if (!nearest && data[a + 3] && data[b + 3] && data[c + 3] && data[d + 3]) {
      const fx = Math.min(1, Math.max(0, u - c0)),
        fy = Math.min(1, Math.max(0, v - r0))
      for (let k = 0; k < 4; k++) {
        out[o + k] =
          (data[a + k] * (1 - fx) + data[b + k] * fx) * (1 - fy) + (data[c + k] * (1 - fx) + data[d + k] * fx) * fy
      }
    } else if (data[ni + 3]) {
      out[o] = data[ni]
      out[o + 1] = data[ni + 1]
      out[o + 2] = data[ni + 2]
      out[o + 3] = data[ni + 3]
    }
  }
}

/** The same for a Float32 height window (NaN = nodata): bilinear where all four
 *  neighbours have a height, else the nearest cell's height, else NaN. */
export function sampleHeightsWarp(data, ww, wh, x0, y0, sx, sy, out, { nearest = false } = {}) {
  for (let i = 0; i < sx.length; i++) {
    out[i] = NaN
    const u = sx[i] - x0,
      v = sy[i] - y0
    if (!(u >= -0.5 && v >= -0.5 && u <= ww - 0.5 && v <= wh - 0.5)) continue
    const n = data[Math.min(wh - 1, Math.max(0, Math.round(v))) * ww + Math.min(ww - 1, Math.max(0, Math.round(u)))]
    const c0 = Math.max(0, Math.min(ww - 1, Math.floor(u))),
      r0 = Math.max(0, Math.min(wh - 1, Math.floor(v)))
    const c1 = Math.min(ww - 1, c0 + 1),
      r1 = Math.min(wh - 1, r0 + 1)
    const a = data[r0 * ww + c0],
      b = data[r0 * ww + c1],
      c = data[r1 * ww + c0],
      d = data[r1 * ww + c1]
    if (!nearest && Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d)) {
      const fx = Math.min(1, Math.max(0, u - c0)),
        fy = Math.min(1, Math.max(0, v - r0))
      out[i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
    } else if (Number.isFinite(n)) out[i] = n
  }
}
