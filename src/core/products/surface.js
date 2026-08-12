// Surface grids for orthorectification — pure, no Vue/Pinia/OPFS/DOM.
//
// An orthophoto needs a HEIGHT PER GROUND CELL, not a DEM specifically:
// core/products/ortho.js walks a grid { width, height, gsd, originX, originY,
// data, mask } and reprojects each cell's 3D point into the cached depth maps.
// The DEM is only one way to build that grid, and it is the holey one — its mask
// comes from binned cloud points, so every gap in the cloud becomes a transparent
// cell in the ortho. This module builds the same grid shape from the other
// surfaces the app already has (Metashape's Build Orthomosaic ▸ Surface):
//   - mesh  — the screened-Poisson mesh (watertight, so the mask is dense inside
//             the hull; this is the fix for a sparse ortho)
//   - plane — a least-squares plane through the cloud (flat scenes: sea ice, an
//             ice shelf, a nadir strip over level ground)
// plus `resampleSurface`, which decouples the ortho's GSD from the surface's — a
// coarse surface is plenty for reprojection while the ortho wants image detail.
//
// Everything here works in FRAME coordinates (x,y = ground plane, z = height;
// see projection.js) — the same space rasterizeDem() rasterises in, and grids
// come out in the same top-left-origin (row 0 = max-Y) convention so they drop
// straight into orthorectify()/the GeoTIFF writers.

// Hard cap on the longer grid side (matches dem.js); gsd is grown to respect it.
const MAX_GRID = 4096

// Allocate an empty (all-nodata) grid covering [minX,maxX]×[minY,maxY].
// Returns null for a degenerate extent. `gsd` may be grown to honour maxGrid.
function makeGrid(minX, minY, maxX, maxY, gsd, maxGrid = MAX_GRID) {
  if (!(maxX > minX) || !(maxY > minY) || !(gsd > 0)) return null
  const spanMax = Math.max(maxX - minX, maxY - minY)
  if (spanMax / gsd > maxGrid - 1) gsd = spanMax / (maxGrid - 1)
  const width = Math.max(1, Math.ceil((maxX - minX) / gsd) + 1)
  const height = Math.max(1, Math.ceil((maxY - minY) / gsd) + 1)
  return {
    width, height, gsd,
    originX: minX,
    originY: maxY, // top-left origin: row 0 is the max-Y edge
    data: new Float32Array(width * height).fill(NaN),
  }
}

// Derive mask/zMin/zMax/count from a filled `data` plane. Mirrors the tail of
// rasterizeDem so every surface reports the same fields (`filled` is 0 here —
// none of these surfaces hole-fill; a mesh/plane has no holes to fill).
function finalize(g, extra = {}) {
  const cells = g.width * g.height
  const mask = new Uint8Array(cells)
  let zMin = Infinity, zMax = -Infinity, count = 0
  for (let i = 0; i < cells; i++) {
    const v = g.data[i]
    if (!Number.isNaN(v)) {
      mask[i] = 1; count++
      if (v < zMin) zMin = v
      if (v > zMax) zMax = v
    }
  }
  if (zMin > zMax) { zMin = 0; zMax = 0 }
  return { ...g, mask, zMin, zMax, count, filled: 0, ...extra }
}

// gsd ≈ √(area / n): roughly one sample per cell. Same rule as dem.suggestGsd,
// expressed over an extent + a count so a mesh can use its vertex count.
function suggestGsdFor(minX, minY, maxX, maxY, n) {
  const area = (maxX - minX) * (maxY - minY)
  if (!(area > 0) || !(n > 1)) return 0
  return Math.sqrt(area / n)
}

// ── Mesh ─────────────────────────────────────────────────────────────────────

// Rasterise an indexed triangle mesh into a height grid (a z-buffer render from
// straight above). `mesh`: { pos: Float32Array(3·nVerts) in FRAME coords,
// idx: Uint32Array(3·nTris) }.
//   opts: { gsd (0 = auto from vertex density), maxGrid, bounds }
// Overlapping triangles collapse by MAX height — the same top-surface (DSM)
// convention as the DEM's default aggregate, so an overhang never shadows the
// roof above it.
// Returns a grid { width, height, gsd, originX, originY, data, mask, zMin, zMax,
// count, filled, triangles } or null.
export function meshSurface(mesh, opts = {}, onProgress = () => {}) {
  const pos = mesh?.pos
  const idx = mesh?.idx
  const nTri = Math.floor((idx?.length ?? 0) / 3)
  if (!pos || !nTri) return null

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const nVerts = Math.floor(pos.length / 3)
  for (let i = 0; i < nVerts; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  if (opts.bounds) ({ minX, minY, maxX, maxY } = opts.bounds)

  const gsd = opts.gsd > 0 ? opts.gsd : suggestGsdFor(minX, minY, maxX, maxY, nVerts)
  const g = makeGrid(minX, minY, maxX, maxY, gsd, opts.maxGrid ?? MAX_GRID)
  if (!g) return null
  const { width, height, data } = g
  const cell = g.gsd, ox = g.originX, oy = g.originY

  for (let t = 0; t < nTri; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3
    const x0 = pos[a], y0 = pos[a + 1], z0 = pos[a + 2]
    const x1 = pos[b], y1 = pos[b + 1], z1 = pos[b + 2]
    const x2 = pos[c], y2 = pos[c + 1], z2 = pos[c + 2]

    // Signed area × 2; a degenerate (edge-on from above) triangle covers no cell
    // centre, and its barycentric solve would divide by ~0.
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    if (!(Math.abs(det) > 1e-20)) continue

    // Cell-centre convention: centre(col) = ox + (col+0.5)·cell, and
    // centre(row) = oy − (row+0.5)·cell, so invert for the covered index range.
    const triMinX = Math.min(x0, x1, x2), triMaxX = Math.max(x0, x1, x2)
    const triMinY = Math.min(y0, y1, y2), triMaxY = Math.max(y0, y1, y2)
    const colLo = Math.max(0, Math.ceil((triMinX - ox) / cell - 0.5))
    const colHi = Math.min(width - 1, Math.floor((triMaxX - ox) / cell - 0.5))
    const rowLo = Math.max(0, Math.ceil((oy - triMaxY) / cell - 0.5))
    const rowHi = Math.min(height - 1, Math.floor((oy - triMinY) / cell - 0.5))
    if (colLo > colHi || rowLo > rowHi) continue

    for (let row = rowLo; row <= rowHi; row++) {
      const py = oy - (row + 0.5) * cell
      const base = row * width
      for (let col = colLo; col <= colHi; col++) {
        const px = ox + (col + 0.5) * cell
        // Barycentric containment. The −1e-9 slack lets a centre exactly on a
        // shared edge land in both triangles; max-blending makes that harmless.
        const l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / det
        if (l0 < -1e-9) continue
        const l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / det
        if (l1 < -1e-9) continue
        const l2 = 1 - l0 - l1
        if (l2 < -1e-9) continue
        const z = l0 * z0 + l1 * z1 + l2 * z2
        const i = base + col
        const cur = data[i]
        if (Number.isNaN(cur) || z > cur) data[i] = z
      }
    }
    if ((t & 0xffff) === 0) onProgress(t, nTri)
  }
  onProgress(nTri, nTri)
  return finalize(g, { triangles: nTri })
}

// ── Plane ────────────────────────────────────────────────────────────────────

// Least-squares plane z = a·x + b·y + c through `points` ({x,y,z} in frame
// coords). Fitted on coordinates centred at the point mean (the raw normal
// equations are badly conditioned when x,y are large projected coordinates —
// e.g. UTM eastings — and the fit silently loses precision), then shifted back.
//   opts.robust (default true): refit once after dropping points beyond
//   2.5 · 1.4826 · MAD of the first fit, so a few blunders (or a building) don't
//   tilt a ground plane.
// Returns { a, b, c, rms, n, dropped } or null.
export function fitPlane(points, opts = {}) {
  const { robust = true } = opts
  const n0 = points?.length ?? 0
  if (n0 < 3) return null

  let mx = 0, my = 0
  for (const p of points) { mx += p.x; my += p.y }
  mx /= n0; my /= n0

  // Solve over a subset (`use` = null ⇒ all points).
  const solve = (use) => {
    let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0, sz = 0, n = 0
    for (let i = 0; i < n0; i++) {
      if (use && !use[i]) continue
      const p = points[i]
      const x = p.x - mx, y = p.y - my, z = p.z
      sxx += x * x; sxy += x * y; syy += y * y
      sxz += x * z; syz += y * z; sz += z; n++
    }
    if (n < 3) return null
    const det = sxx * syy - sxy * sxy
    const cz = sz / n
    // Collinear / single-column support: no gradient is determined, so fall back
    // to the horizontal plane through the mean height rather than a wild tilt.
    if (!(Math.abs(det) > 1e-12 * (sxx * syy + 1))) return { a: 0, b: 0, cz, n }
    return {
      a: (sxz * syy - syz * sxy) / det,
      b: (syz * sxx - sxz * sxy) / det,
      cz, n,
    }
  }

  let fit = solve(null)
  if (!fit) return null
  let dropped = 0

  if (robust) {
    const res = new Float64Array(n0)
    const abs = new Float64Array(n0)
    for (let i = 0; i < n0; i++) {
      const p = points[i]
      res[i] = p.z - (fit.a * (p.x - mx) + fit.b * (p.y - my) + fit.cz)
      abs[i] = Math.abs(res[i])
    }
    const sorted = Float64Array.from(abs).sort()
    const mad = sorted[sorted.length >> 1]
    if (mad > 0) {
      const cut = 2.5 * 1.4826 * mad
      const use = new Uint8Array(n0)
      let kept = 0
      for (let i = 0; i < n0; i++) if (abs[i] <= cut) { use[i] = 1; kept++ }
      if (kept >= 3 && kept < n0) {
        const refit = solve(use)
        if (refit) { fit = refit; dropped = n0 - kept }
      }
    }
  }

  let ss = 0
  for (const p of points) {
    const r = p.z - (fit.a * (p.x - mx) + fit.b * (p.y - my) + fit.cz)
    ss += r * r
  }
  return {
    a: fit.a,
    b: fit.b,
    // Shift the centred intercept back to frame origin.
    c: fit.cz - fit.a * mx - fit.b * my,
    rms: Math.sqrt(ss / n0),
    n: fit.n,
    dropped,
  }
}

// Build a height grid from a plane fitted through `points` ({x,y,z} in frame
// coords). Every cell gets a height, so the mask is fully dense — which is the
// point: on a flat scene this turns a holey ortho into a complete one.
//   opts: { gsd (0 = auto), maxGrid, bounds, robust }
// Returns the grid plus the fit as `plane` { a, b, c, rms, n, dropped }.
export function planeSurface(points, opts = {}) {
  const plane = fitPlane(points, opts)
  if (!plane) return null

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }
  if (opts.bounds) ({ minX, minY, maxX, maxY } = opts.bounds)

  const gsd = opts.gsd > 0 ? opts.gsd : suggestGsdFor(minX, minY, maxX, maxY, points.length)
  const g = makeGrid(minX, minY, maxX, maxY, gsd, opts.maxGrid ?? MAX_GRID)
  if (!g) return null

  const { width, height, data } = g
  for (let row = 0; row < height; row++) {
    const y = g.originY - (row + 0.5) * g.gsd
    for (let col = 0; col < width; col++) {
      const x = g.originX + (col + 0.5) * g.gsd
      data[row * width + col] = plane.a * x + plane.b * y + plane.c
    }
  }
  return finalize(g, { plane })
}

// ── Resampling ───────────────────────────────────────────────────────────────

// Resample a height grid to a different cell size over the same extent — this is
// what lets the ortho run at image resolution over a coarse surface. Heights are
// bilinear over the valid neighbours; the NEAREST source cell must be valid, so
// the mask never grows outward past the surface's real edge (a plain weighted
// average over whatever is in range would smear nodata boundaries by a cell).
// Returns a fresh grid, or the input unchanged when the cell size already matches.
export function resampleSurface(grid, gsd, opts = {}) {
  if (!grid || !(gsd > 0)) return grid
  if (Math.abs(gsd - grid.gsd) <= 1e-9 * grid.gsd) return grid

  const minX = grid.originX
  const maxY = grid.originY
  const maxX = minX + grid.width * grid.gsd
  const minY = maxY - grid.height * grid.gsd
  const g = makeGrid(minX, minY, maxX, maxY, gsd, opts.maxGrid ?? MAX_GRID)
  if (!g) return grid

  const sw = grid.width, sh = grid.height, sd = grid.data, sm = grid.mask
  for (let row = 0; row < g.height; row++) {
    const y = g.originY - (row + 0.5) * g.gsd
    // Continuous source cell-centre coordinates of this target centre.
    const fy = (grid.originY - y) / grid.gsd - 0.5
    const r0 = Math.floor(fy), wy = fy - r0
    for (let col = 0; col < g.width; col++) {
      const x = g.originX + (col + 0.5) * g.gsd
      const fx = (x - grid.originX) / grid.gsd - 0.5
      const c0 = Math.floor(fx), wx = fx - c0

      const nr = Math.min(sh - 1, Math.max(0, Math.round(fy)))
      const nc = Math.min(sw - 1, Math.max(0, Math.round(fx)))
      if (!sm[nr * sw + nc]) continue // outside the surface — stays nodata

      let wsum = 0, vsum = 0
      for (let dr = 0; dr < 2; dr++) {
        const rr = r0 + dr
        if (rr < 0 || rr >= sh) continue
        for (let dc = 0; dc < 2; dc++) {
          const cc = c0 + dc
          if (cc < 0 || cc >= sw) continue
          const si = rr * sw + cc
          if (!sm[si]) continue
          const w = (dr ? wy : 1 - wy) * (dc ? wx : 1 - wx)
          if (!(w > 0)) continue
          wsum += w; vsum += w * sd[si]
        }
      }
      g.data[row * g.width + col] = wsum > 0 ? vsum / wsum : sd[nr * sw + nc]
    }
  }
  return finalize(g)
}
