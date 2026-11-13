// Colouring an orthophoto window from one depth map and its photo (core/products/ortho.js):
// the run defaults, the grid's projection quantities (the affine linearisation of
// toSfm, each map's footprint per cell), the per-cell visibility test and colour
// sample, and finishing a window. Pure; the map shape and conventions are ortho.js's.

import { WIN_TILE, projectInto, samplePhoto } from './orthoWindow.js'
import { orthoRunSettings } from '../runSettings.js'

// What an option left out means: the user defaults in run units (core/runSettings.js),
// never a second copy of them here.
export const RUN_DEFAULTS = orthoRunSettings()

/**
 * Every product frame's `toSfm` is affine (local / scaled-local / a georeference
 * similarity), so the map-major loop — which revisits every cell once PER MAP —
 * need not call it, and allocate an array, N_maps × N_cells times. Probe it about
 * the grid's own centre (so survey-sized coordinates don't cost precision) and
 * check the linearisation against the corners of the grid's 3D box. Returns
 * `{ c0, P0, A }` (A row-major 3×3: P = P0 + A·(c − c0)) or null if `toSfm` is not
 * affine to within 1e-9 of the box size, in which case the caller calls it directly.
 */

export function affineToSfm(toSfm, lo, hi) {
  const fit = fitAffineToSfm(toSfm, lo, hi)
  return fit.err <= 1e-9 * Math.max(1, fit.size) ? { c0: fit.c0, P0: fit.P0, A: fit.A } : null
}

// The affine of toSfm at the centre of box lo..hi (its finite-difference Jacobian),
// with its largest miss at the box's corners (`err`, SfM units: for a smooth frame such
// as a projected CRS with the curvature restored, the miss grows with the square of the
// distance from the centre, so the corners hold it) and the box's extent in SfM (`size`).
function fitAffineToSfm(toSfm, lo, hi) {
  const c0 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  const P0 = toSfm(c0)
  const A = new Float64Array(9)
  for (let k = 0; k < 3; k++) {
    const c = c0.slice()
    c[k] += 1
    const Pk = toSfm(c)
    for (let r = 0; r < 3; r++) A[r * 3 + k] = Pk[r] - P0[r]
  }
  let size = 0,
    err = 0
  for (let corner = 0; corner < 8; corner++) {
    const c = [corner & 1 ? hi[0] : lo[0], corner & 2 ? hi[1] : lo[1], corner & 4 ? hi[2] : lo[2]]
    const P = toSfm(c),
      d = [c[0] - c0[0], c[1] - c0[1], c[2] - c0[2]]
    for (let r = 0; r < 3; r++) {
      const lin = P0[r] + A[r * 3] * d[0] + A[r * 3 + 1] * d[1] + A[r * 3 + 2] * d[2]
      err = Math.max(err, Math.abs(lin - P[r]))
      size = Math.max(size, Math.abs(P[r] - P0[r]))
    }
  }
  return { c0, P0, A, err, size }
}

// What a whole ortho grid fixes for every cell, from its height range (zLo..zHi over
// the cells with a height) and their mean height zMid: the affine linearisation of
// `toSfm` over the grid's 3D box (affineToSfm), and each map's footprint per cell
// (`mapPxPerCell`: the grid centre and its east neighbour, projected; a footprint, not
// a visibility test, so the centre needn't be seen). Both are GRID quantities — a tiled
// run computes them once for the whole ortho, never per block, which is what keeps
// its cells bit-identical to a single pass.
// Depth-map pixels per ortho cell for map m at height zMid — what the photo loader's
// decode scale follows (workers/ops/products.js makePhotoLoader), for a preflight.
export function orthoMapPxPerCell(geom, toSfm, zMid) {
  return gridProjection(geom, toSfm, zMid + 1, zMid, zMid).mapPxPerCell
}

export function gridProjection({ width, height, gsd, originX, originY }, toSfm, zLo, zHi, zMid) {
  const affine =
    zLo <= zHi
      ? affineToSfm(toSfm, [originX, originY - height * gsd, zLo], [originX + width * gsd, originY, zHi])
      : null
  const cx = originX + (width / 2) * gsd,
    cy = originY - (height / 2) * gsd
  const P0 = toSfm([cx, cy, zMid]),
    P1 = toSfm([cx + gsd, cy, zMid])
  const mapPxPerCell = (m) => {
    const a = projectInto(m, P0),
      b = projectInto(m, P1)
    return a && b ? Math.hypot(b.u - a.u, b.v - a.v) : null
  }
  // The frame's up axis in SfM coordinates (unit), for the mosaic's view angle.
  let up
  if (affine) up = [affine.A[2], affine.A[5], affine.A[8]]
  else {
    const Pz = toSfm([cx, cy, zMid + 1])
    up = [Pz[0] - P0[0], Pz[1] - P0[1], Pz[2] - P0[2]]
  }
  const un = Math.hypot(up[0], up[1], up[2]) || 1
  // A frame with no exact affine (a projected CRS, the Earth's curvature restored) is
  // smooth: over a block or a 64-cell tile an affine fitted there misses by far less than
  // a cell. `local(box)` fits one at a grid box ([x0, x1, y0, y1, z0, z1]) → { c0, P0, A,
  // err, pad, box }: `box` grown by `pad` in every grid unit, enough that the affine image
  // of the grown box holds every true point of the box (err over the affine's least
  // stretch, doubled), so a cull with it skips nothing the exact frame would see. An
  // exact frame returns its affine with no pad.
  const local = ([x0, x1, y0, y1, z0, z1]) => {
    if (affine) return { ...affine, err: 0, pad: 0, box: [x0, x1, y0, y1, z0, z1] }
    const fit = fitAffineToSfm(toSfm, [x0, y0, z0], [x1, y1, z1])
    const col = (k) => Math.hypot(fit.A[k], fit.A[3 + k], fit.A[6 + k])
    const pad = (2 * fit.err) / Math.max(1e-12, Math.min(col(0), col(1), col(2)))
    return {
      c0: fit.c0,
      P0: fit.P0,
      A: fit.A,
      err: fit.err,
      pad,
      stretch: col(0),
      box: [x0 - pad, x1 + pad, y0 - pad, y1 + pad, z0 - pad, z1 + pad],
    }
  }
  return { affine, local, mapPxPerCell, up: [up[0] / un, up[1] / un, up[2] / un] }
}

// The map-major kernel: colour the cells of one window of the ortho grid from map m
// (index mi). `win` = { x0, y0, w, h } (the window's cells in the GRID, so cell
// centres are the grid's own) with its per-cell planes, stride w: heights `data` +
// `mask`, output `rgba`, and the blend's state — `scores` ('best', with `labels`) or
// `sums` ('average'). Each cell is independent of every other, so a window computes
// exactly what the same cells compute in a whole-grid pass.
export function colourFromMap(win, grid, m, photo, mi, affine, toSfm, opts, scratch) {
  const { x0, y0, w, h, data, mask, rgba, scores, sums, labels } = win
  const { gsd, originX, originY } = grid
  const { depthTolRel = RUN_DEFAULTS.depthTolRel, maxCost = RUN_DEFAULTS.maxCost } = opts
  const { P, px } = scratch
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const idx = r * w + c
      if (!mask[idx]) continue
      const col = x0 + c,
        row = y0 + r
      const x = originX + (col + 0.5) * gsd,
        y = originY - (row + 0.5) * gsd,
        z = data[idx]
      // The frame's affine, else the cell's tile's (winTiles), else the exact frame.
      const aff =
        affine ?? win.tiles?.cellAff?.[Math.floor(r / WIN_TILE) * win.tiles.nx + Math.floor(c / WIN_TILE)] ?? null
      if (aff) {
        const { c0, P0, A } = aff,
          dx = x - c0[0],
          dy = y - c0[1],
          dz = z - c0[2]
        P[0] = P0[0] + A[0] * dx + A[1] * dy + A[2] * dz
        P[1] = P0[1] + A[3] * dx + A[4] * dy + A[5] * dz
        P[2] = P0[2] + A[6] * dx + A[7] * dy + A[8] * dz
      } else {
        const q = toSfm([x, y, z])
        P[0] = q[0]
        P[1] = q[1]
        P[2] = q[2]
      }
      const p = projectInto(m, P)
      if (!p) continue
      const u = Math.round(p.u),
        v = Math.round(p.v)
      if (u < 0 || v < 0 || u >= m.width || v >= m.height) continue
      const i = v * m.width + u,
        stored = m.depth[i],
        cost = m.cost ? m.cost[i] : 0
      if (!(stored > 0) || Math.abs(stored - p.depth) > depthTolRel * p.depth || cost > maxCost) continue
      const score = cost + 1e-6 * p.depth,
        o = idx * 4
      if (photo) {
        const q = photo.map ? photo.map(p.u, p.v) : { x: p.u, y: p.v }
        // Pixel centres at integers: the photo spans [−½, size − ½].
        if (!(q.x >= -0.5 && q.y >= -0.5 && q.x <= photo.width - 0.5 && q.y <= photo.height - 0.5)) continue
        samplePhoto(photo, q.x, q.y, px)
      } else {
        const c3 = i * 3
        px[0] = m.rgb[c3]
        px[1] = m.rgb[c3 + 1]
        px[2] = m.rgb[c3 + 2]
      }
      if (sums) {
        const wt = 1 / (cost + 1e-3)
        sums[o] += wt * px[0]
        sums[o + 1] += wt * px[1]
        sums[o + 2] += wt * px[2]
        sums[o + 3] += wt
      } else if (score < scores[idx]) {
        scores[idx] = score
        rgba[o] = px[0]
        rgba[o + 1] = px[1]
        rgba[o + 2] = px[2]
        rgba[o + 3] = 255
        if (labels) labels[idx] = mi
      }
    }
}

// Resolve 'average' sums to colours over the whole window; return how many cells of
// the core rect [cx, cx+cw) × [cy, cy+ch) (window coords) received a colour.
export function finishWindow(win, cx, cy, cw, ch) {
  const { w, h, rgba, sums } = win
  if (sums) {
    for (let i = 0, n = w * h; i < n; i++) {
      const o = i * 4
      if (sums[o + 3] > 0) {
        rgba[o] = Math.round(sums[o] / sums[o + 3])
        rgba[o + 1] = Math.round(sums[o + 1] / sums[o + 3])
        rgba[o + 2] = Math.round(sums[o + 2] / sums[o + 3])
        rgba[o + 3] = 255
      }
    }
  }
  return countColoured(rgba, w, cx, cy, cw, ch)
}

export function countColoured(rgba, w, cx, cy, cw, ch) {
  let n = 0
  for (let r = cy; r < cy + ch; r++) for (let c = cx; c < cx + cw; c++) if (rgba[(r * w + c) * 4 + 3]) n++
  return n
}
