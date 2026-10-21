// Orthophoto by true image reprojection — pure, no Vue/Pinia/OPFS/DOM.
//
// Given a DEM (a height per ground cell) we know each cell's full 3D position, so
// an orthophoto is: for every DEM cell, take its ground point, look at which
// source images actually SEE it (not occluded), and sample their colour. This is
// real orthorectification (relief displacement removed via the DEM), unlike a
// simple nadir paste.
//
// The clever reuse: the dense pipeline already produced, per image, a depth map
// (working-res depth + cost + RGB planes; see core/dense/mvs.js / the depthMaps cache).
// Those depth planes ARE per-image z-buffers, so occlusion is a cheap lookup —
// no re-rendering. A cell is visible in image m iff it reprojects to a pixel
// whose stored depth equals the cell's own depth-from-camera (within tolerance);
// a nearer stored depth means something occludes it.
//
// Each map: { uuid, width, height, K:{fx,fy,cx,cy}, R, t,
//             depth:Float32Array, cost:Float32Array, rgb:Uint8Array(w*h*3) }.
// Conventions match geometry.js (x_cam = R·x_world + t; K working-res).
import { sampleRgbaBilinear } from './undistort.js'
import { srgbToLinear, linearToSrgb, fitGains, gainSampleClipped, growable } from './colourGains.js'
import { sampleSurfaceWindow } from './surface.js'
import { createOrthoStats } from '../eval/orthoStats.js'
import { formatBytes } from '../formatBytes.js'
import { seamGrid, seamSampleCol, createSeamSurvey, addSeamCandidate, solveSeams, SEAM_CUT_CELLS, SEAM_CANDIDATES } from './seamCut.js'
import { MULTIBAND_LEVELS, MULTIBAND_BYTES_PER_CELL, multibandReach, createMultiband, multibandBegin, multibandAdd, multibandFinish } from './multiband.js'

// Project a world point into a map, requiring it in front of the camera.
// Returns { u, v, depth } (u,v continuous px) or null.
function projectInto(m, P) {
  const { R, t, K } = m
  const zc = R[2][0] * P[0] + R[2][1] * P[1] + R[2][2] * P[2] + t[2]
  if (!(zc > 1e-9)) return null
  const xc = R[0][0] * P[0] + R[0][1] * P[1] + R[0][2] * P[2] + t[0]
  const yc = R[1][0] * P[0] + R[1][1] * P[1] + R[1][2] * P[2] + t[1]
  return { u: K.fx * (xc / zc) + K.cx, v: K.fy * (yc / zc) + K.cy, depth: zc }
}

// The highest matching cost left in the depth maps, given the settings of the run that
// built them (the Stage A summary's `settings`). The cross-view filter's Minimum NCC
// floor zeroes the depth wherever cost > 1 − minNcc (dense/geomFilter.js filterConfig),
// and a pixel without depth never sees a cell, so an ortho `maxCost` at or above this
// ceiling removes nothing. null when the run skipped the filter or is not known.
export function orthoCostCeiling(depthSettings) {
  if (!depthSettings?.geomConsistency || !Number.isFinite(depthSettings.minNcc)) return null
  return 1 - depthSettings.minNcc
}

// Sample the colour for one ground point P (SfM world coords) by reprojecting it
// into every map, testing occlusion against each map's depth plane, and combining
// the visible views.
//   opts: { depthTolRel=0.02, blend='best'|'average', maxCost=Infinity }
// Returns [r,g,b] (0..255) or null when no view sees the point.
export function sampleOrtho(P, maps, opts = {}) {
  return pickOrthoView(P, maps, opts)?.rgb ?? null
}

// sampleOrtho plus the index of the map that supplied the colour (`mi`, the label;
// -1 for 'average', which mixes every visible view).
function pickOrthoView(P, maps, opts) {
  const { depthTolRel = 0.02, blend = 'best', maxCost = Infinity } = opts
  let best = null           // { score, rgb, mi }
  let wsum = 0, r = 0, g = 0, b = 0  // for 'average'

  for (let mi = 0; mi < maps.length; mi++) {
    const m = maps[mi]
    const p = projectInto(m, P)
    if (!p) continue
    const u = Math.round(p.u), v = Math.round(p.v)
    if (u < 0 || v < 0 || u >= m.width || v >= m.height) continue
    const idx = v * m.width + u
    const stored = m.depth[idx]
    if (!(stored > 0)) continue                              // no surface here
    // Occlusion: the cell's distance to this camera must match the map's own
    // surface distance. A stored depth closer than p.depth ⇒ something in front.
    if (Math.abs(stored - p.depth) > depthTolRel * p.depth) continue
    const cost = m.cost ? m.cost[idx] : 0
    if (cost > maxCost) continue

    const o = idx * 3
    const rgb = [m.rgb[o], m.rgb[o + 1], m.rgb[o + 2]]
    // Quality: lower matching cost is better; nearer view (smaller depth) breaks
    // ties (finer ground resolution). Combine into a single "smaller = better".
    const score = cost + 1e-6 * p.depth

    if (blend === 'average') {
      const w = 1 / (cost + 1e-3)
      wsum += w; r += w * rgb[0]; g += w * rgb[1]; b += w * rgb[2]
    } else if (!best || score < best.score) {
      best = { score, rgb, mi }
    }
  }

  if (blend === 'average') {
    if (wsum <= 0) return null
    return { rgb: [Math.round(r / wsum), Math.round(g / wsum), Math.round(b / wsum)], mi: -1 }
  }
  return best
}

// The per-cell source label (Uint16Array): which map coloured the cell, NO_LABEL where
// none did. Only 'best' has one ('average' mixes every visible view), and only below
// 65,535 maps — otherwise null.
export const NO_LABEL = 0xffff
const newLabels = (n, opts, nMaps) =>
  opts.blend !== 'average' && nMaps < NO_LABEL ? new Uint16Array(n).fill(NO_LABEL) : null

// 'mosaic' (plan-ortho-mosaic O2–O4) exists only in the tiled path: its label map,
// seam feathering and gains need the block halo and the whole-grid gain pass there.
function refuseMosaic(opts) {
  if (opts.blend === 'mosaic') throw new Error("blend 'mosaic' is computed by orthorectifyTiled only")
}

// Fill small transparent holes that lie INSIDE the selected surface. Reads only
// original sampled pixels, so interpolation cannot propagate across a large gap
// one radius at a time or grow beyond the DEM/mesh footprint.
export function fillOrthoGaps(rgba, surfaceMask, width, height, radius, method = 'idw') {
  const r = Math.max(0, Math.floor(radius))
  if (!r || method === 'none') return 0
  const sampled = new Uint8Array(width * height)
  for (let i = 0; i < sampled.length; i++) sampled[i] = rgba[i * 4 + 3] > 0 ? 1 : 0

  let filled = 0
  const r2 = r * r
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col
      if (!surfaceMask[i] || sampled[i]) continue
      let nearest = -1, nearestD2 = Infinity, wsum = 0, rs = 0, gs = 0, bs = 0
      for (let dr = -r; dr <= r; dr++) {
        const rr = row + dr
        if (rr < 0 || rr >= height) continue
        for (let dc = -r; dc <= r; dc++) {
          const cc = col + dc
          if (cc < 0 || cc >= width) continue
          const d2 = dr * dr + dc * dc
          if (!d2 || d2 > r2) continue
          const ni = rr * width + cc
          if (!sampled[ni]) continue
          if (d2 < nearestD2) { nearestD2 = d2; nearest = ni }
          const w = 1 / d2, o = ni * 4
          wsum += w; rs += w * rgba[o]; gs += w * rgba[o + 1]; bs += w * rgba[o + 2]
        }
      }
      if (nearest < 0) continue
      const o = i * 4
      if (method === 'nearest') {
        const no = nearest * 4
        rgba[o] = rgba[no]; rgba[o + 1] = rgba[no + 1]; rgba[o + 2] = rgba[no + 2]
      } else {
        rgba[o] = Math.round(rs / wsum); rgba[o + 1] = Math.round(gs / wsum); rgba[o + 2] = Math.round(bs / wsum)
      }
      rgba[o + 3] = 255
      filled++
    }
  }
  return filled
}

// Orthorectify a whole DEM grid into an RGBA raster aligned to it. `toSfm` maps a
// frame coord [x,y,z] back to SfM world (frame.toSfm); `cellCenter(grid,col,row)`
// gives the ground XY. Cells with no height (mask 0) or no visible view become
// transparent.
//   grid: from dem.rasterizeDem ({ width, height, gsd, originX, originY, data, mask })
// Returns { width, height, rgba:Uint8ClampedArray(w*h*4), covered, labels } where
// `covered` is the number of cells that received a colour and `labels` the source
// map per sampled cell (see NO_LABEL; gap-filled cells stay unlabelled).
export function orthorectify(grid, maps, toSfm, opts = {}, onProgress = () => {}) {
  refuseMosaic(opts)
  const { width, height, gsd, originX, originY, data, mask } = grid
  const rgba = new Uint8ClampedArray(width * height * 4)
  const labels = newLabels(width * height, opts, maps.length)
  let covered = 0
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col
      const o = idx * 4
      if (!mask[idx]) continue
      const x = originX + (col + 0.5) * gsd
      const y = originY - (row + 0.5) * gsd
      const P = toSfm([x, y, data[idx]])
      const view = pickOrthoView(P, maps, opts)
      if (!view) continue
      const { rgb } = view
      rgba[o] = rgb[0]; rgba[o + 1] = rgb[1]; rgba[o + 2] = rgb[2]; rgba[o + 3] = 255
      if (labels) labels[idx] = view.mi
      covered++
    }
    if (row % 32 === 0) onProgress(row, height)
  }
  const sampled = covered
  const filled = fillOrthoGaps(rgba, mask, width, height, opts.fillRadius ?? 2, opts.fillMethod ?? 'idw')
  covered += filled
  onProgress(height, height)
  return { width, height, rgba, covered, sampled, filled, labels }
}

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
    const c = c0.slice(); c[k] += 1
    const Pk = toSfm(c)
    for (let r = 0; r < 3; r++) A[r * 3 + k] = Pk[r] - P0[r]
  }
  let size = 0, err = 0
  for (let corner = 0; corner < 8; corner++) {
    const c = [corner & 1 ? hi[0] : lo[0], corner & 2 ? hi[1] : lo[1], corner & 4 ? hi[2] : lo[2]]
    const P = toSfm(c), d = [c[0] - c0[0], c[1] - c0[1], c[2] - c0[2]]
    for (let r = 0; r < 3; r++) {
      const lin = P0[r] + A[r * 3] * d[0] + A[r * 3 + 1] * d[1] + A[r * 3 + 2] * d[2]
      err = Math.max(err, Math.abs(lin - P[r]))
      size = Math.max(size, Math.abs(P[r] - P0[r]))
    }
  }
  return { c0, P0, A, err, size }
}

// Map-major counterpart: identical selection/weights, one decoded map resident.
//
// `loadImage(mi, map)` (optional) returns the map's SOURCE photo for colour:
// `{ data: RGBA, width, height, map }`, where `map(u, v)` takes a depth-map pixel to
// the photo's raw pixel (core/sfm/displayFrame.js makeSampleMap — the same chain dense
// used to build the map; null = identity). The depth map then only decides visibility,
// and colour is bilinear at the photo's full resolution instead of nearest from the
// map's working-resolution rgb plane (plan-ortho-mosaic O1). Return null for a map
// to fall back to its rgb plane. Without loadImage the output equals orthorectify().
// Its third argument is how many depth-map pixels one ortho cell spans in that map
// (measured at the grid centre; null when the centre does not project), so the loader
// can decode the photo no finer than the ortho can use.
export async function orthorectifyStreamed(grid, metas, loadMap, toSfm, opts = {}, onProgress = () => {}, loadImage = null) {
  refuseMosaic(opts)
  const { width, height, data, mask } = grid
  const n = width * height, rgba = new Uint8ClampedArray(n * 4)
  const average = opts.blend === 'average'
  // Per-cell state is a real cost at MAX_GRID (16.8 M cells): allocate only what
  // the chosen blend reads — 8 B/cell for 'best', 32 B/cell for 'average'.
  const scores = average ? null : new Float64Array(n).fill(Infinity)
  const sums = average ? new Float64Array(n * 4) : null
  const labels = newLabels(n, opts, metas.length)
  let zLo = Infinity, zHi = -Infinity, zMid = 0
  for (let i = 0, k = 0; i < n; i++) {
    if (!mask[i]) continue
    const z = data[i]
    if (z < zLo) zLo = z
    if (z > zHi) zHi = z
    zMid += (z - zMid) / ++k
  }
  const { affine, mapPxPerCell } = gridProjection(grid, toSfm, zLo, zHi, zMid)
  const win = { x0: 0, y0: 0, w: width, h: height, data, mask, rgba, scores, sums, labels }
  const scratch = { P: [0, 0, 0], px: new Float32Array(4) }
  for (let mi = 0; mi < metas.length; mi++) {
    const m = await loadMap(mi)
    const photo = loadImage ? await loadImage(mi, m, mapPxPerCell(m)) : null
    colourFromMap(win, grid, m, photo, mi, affine, toSfm, opts, scratch)
    onProgress(mi + 1, metas.length)
  }
  const sampled = finishWindow(win, 0, 0, width, height)
  const filled = fillOrthoGaps(rgba, mask, width, height, opts.fillRadius ?? 2, opts.fillMethod ?? 'idw')
  return { width, height, rgba, covered: sampled + filled, sampled, filled, labels }
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

function gridProjection({ width, height, gsd, originX, originY }, toSfm, zLo, zHi, zMid) {
  const affine = zLo <= zHi ? affineToSfm(toSfm,
    [originX, originY - height * gsd, zLo], [originX + width * gsd, originY, zHi]) : null
  const cx = originX + (width / 2) * gsd, cy = originY - (height / 2) * gsd
  const P0 = toSfm([cx, cy, zMid]), P1 = toSfm([cx + gsd, cy, zMid])
  const mapPxPerCell = (m) => {
    const a = projectInto(m, P0), b = projectInto(m, P1)
    return a && b ? Math.hypot(b.u - a.u, b.v - a.v) : null
  }
  // The frame's up axis in SfM coordinates (unit), for the mosaic's view angle.
  let up
  if (affine) up = [affine.A[2], affine.A[5], affine.A[8]]
  else { const Pz = toSfm([cx, cy, zMid + 1]); up = [Pz[0] - P0[0], Pz[1] - P0[1], Pz[2] - P0[2]] }
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
    return { c0: fit.c0, P0: fit.P0, A: fit.A, err: fit.err, pad, stretch: col(0),
      box: [x0 - pad, x1 + pad, y0 - pad, y1 + pad, z0 - pad, z1 + pad] }
  }
  return { affine, local, mapPxPerCell, up: [up[0] / un, up[1] / un, up[2] / un] }
}

// The map-major kernel: colour the cells of one window of the ortho grid from map m
// (index mi). `win` = { x0, y0, w, h } (the window's cells in the GRID, so cell
// centres are the grid's own) with its per-cell planes, stride w: heights `data` +
// `mask`, output `rgba`, and the blend's state — `scores` ('best', with `labels`) or
// `sums` ('average'). Each cell is independent of every other, so a window computes
// exactly what the same cells compute in a whole-grid pass.
function colourFromMap(win, grid, m, photo, mi, affine, toSfm, opts, scratch) {
  const { x0, y0, w, h, data, mask, rgba, scores, sums, labels } = win
  const { gsd, originX, originY } = grid
  const { depthTolRel = 0.02, maxCost = Infinity } = opts
  const { P, px } = scratch
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const idx = r * w + c
    if (!mask[idx]) continue
    const col = x0 + c, row = y0 + r
    const x = originX + (col + 0.5) * gsd, y = originY - (row + 0.5) * gsd, z = data[idx]
    // The frame's affine, else the cell's tile's (winTiles), else the exact frame.
    const aff = affine ?? win.tiles?.cellAff?.[Math.floor(r / WIN_TILE) * win.tiles.nx + Math.floor(c / WIN_TILE)] ?? null
    if (aff) {
      const { c0, P0, A } = aff, dx = x - c0[0], dy = y - c0[1], dz = z - c0[2]
      P[0] = P0[0] + A[0] * dx + A[1] * dy + A[2] * dz
      P[1] = P0[1] + A[3] * dx + A[4] * dy + A[5] * dz
      P[2] = P0[2] + A[6] * dx + A[7] * dy + A[8] * dz
    } else {
      const q = toSfm([x, y, z]); P[0] = q[0]; P[1] = q[1]; P[2] = q[2]
    }
    const p = projectInto(m, P)
    if (!p) continue
    const u = Math.round(p.u), v = Math.round(p.v)
    if (u < 0 || v < 0 || u >= m.width || v >= m.height) continue
    const i = v * m.width + u, stored = m.depth[i], cost = m.cost ? m.cost[i] : 0
    if (!(stored > 0) || Math.abs(stored - p.depth) > depthTolRel * p.depth || cost > maxCost) continue
    const score = cost + 1e-6 * p.depth, o = idx * 4
    if (photo) {
      const q = photo.map ? photo.map(p.u, p.v) : { x: p.u, y: p.v }
      // Pixel centres at integers: the photo spans [−½, size − ½].
      if (!(q.x >= -0.5 && q.y >= -0.5 && q.x <= photo.width - 0.5 && q.y <= photo.height - 0.5)) continue
      sampleRgbaBilinear(photo.data, photo.width, photo.height, q.x, q.y, px, 0)
    } else {
      const c3 = i * 3
      px[0] = m.rgb[c3]; px[1] = m.rgb[c3 + 1]; px[2] = m.rgb[c3 + 2]
    }
    if (sums) {
      const wt = 1 / (cost + 1e-3)
      sums[o] += wt * px[0]; sums[o + 1] += wt * px[1]; sums[o + 2] += wt * px[2]; sums[o + 3] += wt
    } else if (score < scores[idx]) {
      scores[idx] = score
      rgba[o] = px[0]; rgba[o + 1] = px[1]; rgba[o + 2] = px[2]; rgba[o + 3] = 255
      if (labels) labels[idx] = mi
    }
  }
}

// Resolve 'average' sums to colours over the whole window; return how many cells of
// the core rect [cx, cx+cw) × [cy, cy+ch) (window coords) received a colour.
function finishWindow(win, cx, cy, cw, ch) {
  const { w, h, rgba, sums } = win
  if (sums) {
    for (let i = 0, n = w * h; i < n; i++) {
      const o = i * 4
      if (sums[o + 3] > 0) {
        rgba[o] = Math.round(sums[o] / sums[o + 3]); rgba[o + 1] = Math.round(sums[o + 1] / sums[o + 3]); rgba[o + 2] = Math.round(sums[o + 2] / sums[o + 3]); rgba[o + 3] = 255
      }
    }
  }
  return countColoured(rgba, w, cx, cy, cw, ch)
}

function countColoured(rgba, w, cx, cy, cw, ch) {
  let n = 0
  for (let r = cy; r < cy + ch; r++) for (let c = cx; c < cx + cw; c++) if (rgba[(r * w + c) * 4 + 3]) n++
  return n
}

// ── Tiled orthophoto (plan SC-9 / T1) ─────────────────────────────────────────
//
// An ortho at the photos' GSD is 10–25 k px a side, hundreds of millions of cells:
// no whole-grid plane fits. orthorectifyTiled walks the grid in square BLOCKS, each
// run through the same map-major kernel over only the maps that can see it, and hands
// every finished block to the caller (the COG writer) before the next one starts.
// The surface stays the ≤ 4,096 grid it was built at; each block samples its heights
// from it (surface.js sampleSurfaceWindow), so no full-size height plane exists either.
//
// Exactness. On a grid a single pass can hold, the blocks reproduce that pass bit for
// bit — colours, labels, counts and stats (streamedProducts.test.js pins it):
//   - the grid quantities (affine linearisation, mean height for the photo footprint)
//     come from a streamed pre-pass over every cell in row-major order, the order the
//     single pass reads them in;
//   - a block is computed over its core plus a halo of fillRadius + 1 cells, so gap
//     filling (which reads original samples up to fillRadius away) is exact on the
//     core and on the one-cell ring the stats' 3×3 and right/down neighbours read;
//   - the per-block map cull is exact: a map is skipped only when the block's whole
//     3D box projects outside it (a linear-fractional map takes its extremes over a
//     box at the corners), with a 1 px margin for rounding, so a skipped map could
//     colour no cell of the window;
//   - stats sums are integers (orthoStats.js), so block order cannot move them.
//
// Reads. A map visits every block it can see; its planes and its decoded source photo
// are cached across blocks in a byte-bounded cache that evicts by Belady's MIN — the
// whole visit sequence is known after the cull, so it drops the entry wanted furthest
// ahead (the streamed-fusion precedent). Only the policy may change; the visit order
// may not, or 'average' sums would add in another order.
export const ORTHO_BLOCK = 2048

// ── Mosaic (plan-ortho-mosaic O2–O4) ──────────────────────────────────────────
//
// 'best' picks a view per cell by matching cost, a texture statistic, so the source
// flips cell to cell between views of very different obliquity, and every source
// change is a hard colour step. 'mosaic' builds the ortho the way a mapping package
// does, in three parts:
//   O2  a LABEL MAP chosen by geometry. Pass 1 gives each cell the visible view with
//       the finest foreshortened footprint, depth / (f·cos²θ), θ the angle between the
//       ray to the camera and the frame's vertical: on a nadir block of one altitude
//       that is the most nadir view, so the labels form the classic nearest-nadir
//       (Voronoi-like) partition; the tilt counts twice so a nadir view beats a
//       closer oblique one. Matching cost is only a gate. MOSAIC_SMOOTH_PASSES 3×3
//       majority passes then remove single-cell flips.
//   O3  GAINS per image and channel (Brown & Lowe 2007), fitted once before the
//       blocks in linear light from a sparse lattice of cells seen by several images
//       (photos decoded coarse: a gain needs means, not detail).
//   O4a FEATHERING: an image contributes to cells within `seamCells` of its own
//       region, its weight ramping from 1 inside the region to 0 at the band's edge
//       (chamfer distance of the label map). seamCells 0 = hard seams.
// Pass 2 colours a window image by image, only the cells each image owns or feathers
// into. A cell whose smoothed label cannot see it falls back to its pass-1 label.
// Two alternatives, chosen by opts.seamline / opts.seamBlend:
//   O5  seamline 'graphcut' (seamCut.js): the labels come from a min-cut over colour
//       difference + nadir cost, solved once on a coarse grid of the whole ortho
//       during the gain pass; pass 1 then only supplies the fallback labels.
//   O4b seamBlend 'multiband' (multiband.js): pass 2 builds the hard-seam mosaic,
//       then a third pass adds each image's Laplacian-pyramid correction over a ring
//       around its region (MULTIBAND_LEVELS bands), instead of the linear ramp.
//
// Exactness (pinned in streamedProducts.test.js: small blocks ≡ one block): pass-1
// labels are per cell; a smoothed label reads raw labels up to MOSAIC_SMOOTH_PASSES
// cells away (a graph-cut label reads only the grid-global coarse labels), a
// feathering weight reads labels up to seamCells away (a multiband correction up to
// multibandReach().halo, on windows aligned to its pyramid lattice), and the gap fill +
// stats read colours fillRadius + 1 away, so the block halo is the sum (orthoHalo). The
// chamfer weights are integers (3/4) and the gains and coarse labels are grid-global,
// so nothing depends on the block layout.
export const MOSAIC_SMOOTH_PASSES = 2
export const MAX_SEAM_CELLS = 128
const GAIN_LATTICE_CELLS = 65536 // target lattice size for the gain fit

// The seam band in cells, from the user's % of the ortho's short side (0 = hard seams).
export function mosaicSeamCells(width, height, seamWidthPct = 0) {
  if (!(seamWidthPct > 0)) return 0
  return Math.min(MAX_SEAM_CELLS, Math.max(1, Math.round((Math.min(width, height) * seamWidthPct) / 100)))
}

// How far beyond its core a block must be computed for its core cells to be exact.
export function orthoHalo({ width, height, blend = 'best', fillRadius = 2, seamWidth = 0, seamline = 'nadir', seamBlend = 'feather', blendLevels = MULTIBAND_LEVELS }) {
  const fill = Math.max(0, Math.floor(fillRadius)) + 1
  if (blend !== 'mosaic') return fill
  const band = seamBlend === 'multiband' ? multibandReach(blendLevels).halo : mosaicSeamCells(width, height, seamWidth)
  return fill + band + (seamline === 'graphcut' ? 0 : MOSAIC_SMOOTH_PASSES)
}

// A mosaic's seam options, resolved (core defaults: the O2–O4a nearest-nadir partition
// with feathering; the app's defaults are in defaults.user.js ORTHO_DEFAULTS).
function mosaicMode(opts) {
  const mosaic = opts.blend === 'mosaic'
  const graphcut = mosaic && opts.seamline === 'graphcut', multiband = mosaic && opts.seamBlend === 'multiband'
  const levels = opts.blendLevels ?? MULTIBAND_LEVELS
  return { mosaic, graphcut, multiband, levels, align: multiband ? 1 << levels : 1 }
}

// sRGB ↔ linear light: core/products/colourGains.js (re-exported for existing callers).
export { srgbToLinear, linearToSrgb }

// The visibility test every mosaic pass shares: P in front of map m (camera centre C),
// on a map pixel whose stored depth agrees (z-buffer), within the cost gate, and seen
// from above the surface (the ray to the camera leans less than 90° from `up`).
// Fills g = { u, v, i, depth, cos } and returns whether P is visible.
//
// A pixel without depth says nothing: the cross-view filter removes weakly matched
// pixels (a uniform roof, foliage), so a depth map is full of small holes, and a photo
// would "not see" scattered cells of its own region — each one then taken from another
// photo, a speckle of seams (on quarry-80 the nadir labels switched 21 times per 100
// cells, mostly so). Inside such a hole the nearest depth within MOSAIC_HOLE_REACH
// map pixels that agrees stands in. Where the stored depth is nearer, something
// occludes the point: that is never overridden.
export const MOSAIC_HOLE_REACH = 2
function seenFrom(m, C, P, up, tol, maxCost, g) {
  const { R, t, K } = m
  const zc = R[2][0] * P[0] + R[2][1] * P[1] + R[2][2] * P[2] + t[2]
  if (!(zc > 1e-9)) return false
  const u = K.fx * ((R[0][0] * P[0] + R[0][1] * P[1] + R[0][2] * P[2] + t[0]) / zc) + K.cx
  const v = K.fy * ((R[1][0] * P[0] + R[1][1] * P[1] + R[1][2] * P[2] + t[1]) / zc) + K.cy
  const ui = Math.round(u), vi = Math.round(v)
  if (ui < 0 || vi < 0 || ui >= m.width || vi >= m.height) return false
  let i = vi * m.width + ui
  const stored = m.depth[i]
  if (stored > 0) {
    if (Math.abs(stored - zc) > tol * zc) return false
  } else {
    // A hole: the agreeing depth nearest to (ui, vi), rings outwards, first in row order.
    let found = -1
    for (let rr = 1; rr <= MOSAIC_HOLE_REACH && found < 0; rr++) {
      for (let dv = -rr; dv <= rr && found < 0; dv++) for (let du = -rr; du <= rr; du++) {
        if (Math.max(Math.abs(du), Math.abs(dv)) !== rr) continue
        const uu = ui + du, vv = vi + dv
        if (uu < 0 || vv < 0 || uu >= m.width || vv >= m.height) continue
        const j = vv * m.width + uu, sj = m.depth[j]
        if (sj > 0 && Math.abs(sj - zc) <= tol * zc) { found = j; break }
      }
    }
    if (found < 0) return false
    i = found
  }
  if (m.cost && m.cost[i] > maxCost) return false
  const dx = C[0] - P[0], dy = C[1] - P[1], dz = C[2] - P[2]
  const cos = (up[0] * dx + up[1] * dy + up[2] * dz) / Math.hypot(dx, dy, dz)
  if (!(cos > 1e-3)) return false
  g.u = u; g.v = v; g.i = i; g.depth = zc; g.cos = cos
  return true
}

// The colour of a visible sample: bilinear from the source photo (O1), else nearest
// from the map's own rgb plane. False when the photo does not cover the point.
function sampleColour(m, photo, g, px) {
  if (photo) {
    const q = photo.map ? photo.map(g.u, g.v) : { x: g.u, y: g.v }
    if (!(q.x >= -0.5 && q.y >= -0.5 && q.x <= photo.width - 0.5 && q.y <= photo.height - 0.5)) return false
    sampleRgbaBilinear(photo.data, photo.width, photo.height, q.x, q.y, px, 0)
    return true
  }
  const c3 = g.i * 3
  px[0] = m.rgb[c3]; px[1] = m.rgb[c3 + 1]; px[2] = m.rgb[c3 + 2]
  return true
}

const cameraCentre = ({ R, t }) => [
  -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2]),
  -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2]),
  -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2]),
]

// A cell centre of the grid in SfM coordinates, into P.
function cellToSfm(grid, affine, toSfm, col, row, z, P) {
  const x = grid.originX + (col + 0.5) * grid.gsd, y = grid.originY - (row + 0.5) * grid.gsd
  if (affine) {
    const { c0, P0, A } = affine, dx = x - c0[0], dy = y - c0[1], dz = z - c0[2]
    P[0] = P0[0] + A[0] * dx + A[1] * dy + A[2] * dz
    P[1] = P0[1] + A[3] * dx + A[4] * dy + A[5] * dz
    P[2] = P0[2] + A[6] * dx + A[7] * dy + A[8] * dz
  } else {
    const q = toSfm([x, y, z]); P[0] = q[0]; P[1] = q[1]; P[2] = q[2]
  }
}

// O2 pass 1: label each cell of the window with map mi where it has the finest
// foreshortened footprint so far (ties keep the lower index: maps arrive ascending).
function labelFromMap(win, grid, m, mi, gp, toSfm, opts, scratch) {
  const { x0, y0, w, data, mask, raw, score } = win
  const { depthTolRel = 0.02, maxCost = Infinity } = opts
  const { P, g } = scratch, C = cameraCentre(m), fx = m.K.fx
  forTilesReaching(win, grid, m, gp.affine, 0, 0, w, win.h, (c0, r0, c1, r1) => {
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
      const idx = r * w + c
      if (!mask[idx]) continue
      winCellToSfm(win, grid, gp, toSfm, c, r, data[idx], P)
      if (!seenFrom(m, C, P, gp.up, depthTolRel, maxCost, g)) continue
      const s = g.depth / (fx * g.cos * g.cos)
      if (s < score[idx]) { score[idx] = s; raw[idx] = mi }
    }
  })
}

// Within a block window, a map usually sees a part only: the window is split into
// WIN_TILE² tiles and a pass visits only the tiles the map can see (the block cull's
// exact box test, per tile with its own height range), so it computes exactly what a
// loop over every cell would. `winTiles` sets the ranges up once per window.
const WIN_TILE = 64
// Per tile, the frame without an exact affine (gp.local): the affine for its culls, and
// for its cells when it misses by under CELL_AFFINE_TOL of a cell (else the cells take
// the exact frame). The transform does not depend on the map, so a window's tiles are
// fitted once for all the maps that visit it.
const CELL_AFFINE_TOL = 1e-3
function winTiles(win, grid = null, gp = null) {
  const { w, h, data, mask } = win, nx = Math.ceil(w / WIN_TILE), ny = Math.ceil(h / WIN_TILE)
  const lo = new Float64Array(nx * ny).fill(Infinity), hi = new Float64Array(nx * ny).fill(-Infinity)
  for (let r = 0; r < h; r++) {
    const tr = Math.floor(r / WIN_TILE) * nx
    for (let c = 0; c < w; c++) {
      const i = r * w + c
      if (!mask[i]) continue
      const t = tr + Math.floor(c / WIN_TILE), z = data[i]
      if (z < lo[t]) lo[t] = z
      if (z > hi[t]) hi[t] = z
    }
  }
  let near = null, cellAff = null
  if (gp && !gp.affine && gp.local) {
    near = new Array(nx * ny).fill(null); cellAff = new Array(nx * ny).fill(null)
    const { gsd, originX, originY } = grid
    for (let t = 0; t < nx * ny; t++) {
      if (!(lo[t] <= hi[t])) continue
      const tx = t % nx, ty = Math.floor(t / nx)
      const c0 = tx * WIN_TILE, r0 = ty * WIN_TILE, c1 = Math.min(w, c0 + WIN_TILE), r1 = Math.min(h, r0 + WIN_TILE)
      const fit = gp.local([originX + (win.x0 + c0 + 0.5) * gsd, originX + (win.x0 + c1 - 0.5) * gsd,
        originY - (win.y0 + r1 - 0.5) * gsd, originY - (win.y0 + r0 + 0.5) * gsd, lo[t], hi[t]])
      near[t] = fit
      if (fit.err <= CELL_AFFINE_TOL * gsd * fit.stretch) cellAff[t] = fit
    }
  }
  win.tiles = { nx, ny, lo, hi, near, cellAff }
}

// A window cell (c, r) into SfM: the frame's exact affine, else its tile's (winTiles),
// else the exact frame.
function winCellToSfm(win, grid, gp, toSfm, c, r, z, P) {
  const aff = gp.affine ?? win.tiles?.cellAff?.[Math.floor(r / WIN_TILE) * win.tiles.nx + Math.floor(c / WIN_TILE)] ?? null
  cellToSfm(grid, aff, toSfm, win.x0 + c, win.y0 + r, z, P)
}

// Call fn(c0, r0, c1, r1) for the part of window box [bx0, bx1) × [by0, by1) in each tile
// that map m can see (every tile when the frame is not affine).
function forTilesReaching(win, grid, m, affine, bx0, by0, bx1, by1, fn) {
  const { nx, lo, hi } = win.tiles, { gsd, originX, originY } = grid
  for (let ty = Math.floor(by0 / WIN_TILE); ty * WIN_TILE < by1; ty++) for (let tx = Math.floor(bx0 / WIN_TILE); tx * WIN_TILE < bx1; tx++) {
    const t = ty * nx + tx
    if (!(lo[t] <= hi[t])) continue
    const c0 = Math.max(bx0, tx * WIN_TILE), r0 = Math.max(by0, ty * WIN_TILE)
    const c1 = Math.min(bx1, (tx + 1) * WIN_TILE, win.w), r1 = Math.min(by1, (ty + 1) * WIN_TILE, win.h)
    if (affine) {
      const box = [originX + (win.x0 + c0 + 0.5) * gsd, originX + (win.x0 + c1 - 0.5) * gsd,
        originY - (win.y0 + r1 - 0.5) * gsd, originY - (win.y0 + r0 + 0.5) * gsd, lo[t], hi[t]]
      if (!boxReachesMap(m, affine, box)) continue
    } else if (win.tiles.near?.[t]) {
      // The tile's own affine, its whole (grown) box: never culls what the frame sees.
      const near = win.tiles.near[t]
      if (!boxReachesMap(m, near, near.box)) continue
    }
    fn(c0, r0, c1, r1)
  }
}

// One 3×3 majority pass over a label plane: a cell takes the label most of its
// labelled 3×3 neighbourhood carries; it keeps its own on a tie, else the lowest of
// the tied labels. Unlabelled cells stay unlabelled and do not vote.
function majority3(src, dst, w, h) {
  const lab = new Int32Array(9), cnt = new Int32Array(9)
  for (let r = 0; r < h; r++) {
    const r0 = Math.max(0, r - 1), r1 = Math.min(h - 1, r + 1)
    for (let c = 0; c < w; c++) {
      const i = r * w + c, s = src[i]
      if (s === NO_LABEL) { dst[i] = NO_LABEL; continue }
      const c0 = Math.max(0, c - 1), c1 = Math.min(w - 1, c + 1)
      let uniform = true
      for (let rr = r0; rr <= r1 && uniform; rr++) for (let cc = c0; cc <= c1; cc++) {
        const v = src[rr * w + cc]
        if (v !== s && v !== NO_LABEL) { uniform = false; break }
      }
      if (uniform) { dst[i] = s; continue }
      let k = 0
      for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) {
        const v = src[rr * w + cc]
        if (v === NO_LABEL) continue
        let j = 0
        while (j < k && lab[j] !== v) j++
        if (j === k) { lab[k] = v; cnt[k++] = 1 } else cnt[j]++
      }
      let maxN = 0, own = 0
      for (let j = 0; j < k; j++) { if (cnt[j] > maxN) maxN = cnt[j]; if (lab[j] === s) own = cnt[j] }
      let out = s
      if (own < maxN) { out = NO_LABEL; for (let j = 0; j < k; j++) if (cnt[j] === maxN && lab[j] < out) out = lab[j] }
      dst[i] = out
    }
  }
}

// `passes` majority passes from src into dst; src (the raw labels) is left intact.
export function smoothLabels(src, dst, tmp, w, h, passes = MOSAIC_SMOOTH_PASSES) {
  if (passes <= 0) { dst.set(src.subarray(0, w * h)); return dst }
  let cur = src
  for (let p = 0; p < passes; p++) {
    const out = (passes - 1 - p) % 2 === 0 ? dst : tmp
    majority3(cur, out, w, h)
    cur = out
  }
  return dst
}

// Two-pass 3-4 chamfer distance (3 per straight step, 4 per diagonal) to the cells
// labelled `target`, over the box [x0, x1) × [y0, y1) of a window of width w; written
// into `dist` at window indices, capped at 0xffff. Integer, so exact in any order, and
// within a rectangle the two passes give the true chamfer distance (Borgefors 1986).
export function chamferTo(labels, w, x0, y0, x1, y1, target, dist) {
  const CAP = 0xffff
  for (let r = y0; r < y1; r++) for (let c = x0; c < x1; c++) {
    const i = r * w + c
    let d = labels[i] === target ? 0 : CAP
    if (d) {
      if (c > x0) d = Math.min(d, dist[i - 1] + 3)
      if (r > y0) {
        d = Math.min(d, dist[i - w] + 3)
        if (c > x0) d = Math.min(d, dist[i - w - 1] + 4)
        if (c < x1 - 1) d = Math.min(d, dist[i - w + 1] + 4)
      }
    }
    dist[i] = d
  }
  for (let r = y1 - 1; r >= y0; r--) for (let c = x1 - 1; c >= x0; c--) {
    const i = r * w + c
    let d = dist[i]
    if (d) {
      if (c < x1 - 1) d = Math.min(d, dist[i + 1] + 3)
      if (r < y1 - 1) {
        d = Math.min(d, dist[i + w] + 3)
        if (c < x1 - 1) d = Math.min(d, dist[i + w + 1] + 4)
        if (c > x0) d = Math.min(d, dist[i + w - 1] + 4)
      }
      dist[i] = d
    }
  }
}

// O3/O4a pass 2: map mi's contribution to the cells of its box. A cell within the
// seam band of mi's region (chamfer distance < 3·seamCells; distance 0 = its own
// region) gets weight (3·seamCells − d) / (3·seamCells), 1 inside; a cell whose
// smoothed label is not mi but whose pass-1 label is, records mi's colour as its
// fallback. Sums are in linear light with mi's gains applied.
function blendFromMap(win, grid, m, photo, mi, gp, toSfm, opts, scratch, box, seam3, gains) {
  const { x0, y0, w, data, mask, raw, label, dist, sums, fallback, flags } = win
  const { depthTolRel = 0.02, maxCost = Infinity } = opts
  const { P, g, px } = scratch, C = cameraCentre(m)
  const g0 = gains ? gains[mi * 3] : 1, g1 = gains ? gains[mi * 3 + 1] : 1, g2 = gains ? gains[mi * 3 + 2] : 1
  const [bx0, by0, bx1, by1] = box
  for (let r = by0; r < by1; r++) for (let c = bx0; c < bx1; c++) {
    const idx = r * w + c
    if (!mask[idx]) continue
    const own = label[idx] === mi
    const d = seam3 ? dist[idx] : (own ? 0 : 0xffff)
    const inBand = d === 0 || d < seam3
    const isFallback = !own && raw[idx] === mi
    if (!inBand && !isFallback) continue
    winCellToSfm(win, grid, gp, toSfm, c, r, data[idx], P)
    if (!seenFrom(m, C, P, gp.up, depthTolRel, maxCost, g)) continue
    if (!sampleColour(m, photo, g, px)) continue
    const l0 = g0 * srgbToLinear(px[0]), l1 = g1 * srgbToLinear(px[1]), l2 = g2 * srgbToLinear(px[2])
    if (inBand) {
      const wt = d === 0 ? 1 : (seam3 - d) / seam3, o = idx * 4
      sums[o] += wt * l0; sums[o + 1] += wt * l1; sums[o + 2] += wt * l2; sums[o + 3] += wt
      if (own) flags[idx] |= 1
    }
    if (isFallback) {
      const o = idx * 3
      fallback[o] = l0; fallback[o + 1] = l1; fallback[o + 2] = l2
      flags[idx] |= 2
    }
  }
}

// Resolve a mosaic window: weighted means back to sRGB, and the output label — the
// smoothed label where it coloured its own cell, the pass-1 label where that stood in,
// NO_LABEL where only neighbours' seam bands reached the cell (or nothing did).
function finishMosaicWindow(win) {
  const { w, h, mask, raw, label, sums, fallback, flags, rgba, labels } = win
  for (let i = 0, n = w * h; i < n; i++) {
    labels[i] = NO_LABEL
    if (!mask[i]) continue
    const o = i * 4, f = flags[i]
    let s0 = sums[o], s1 = sums[o + 1], s2 = sums[o + 2], s3 = sums[o + 3]
    if (!(f & 1) && (f & 2)) {
      s0 += fallback[i * 3]; s1 += fallback[i * 3 + 1]; s2 += fallback[i * 3 + 2]; s3 += 1
    }
    if (!(s3 > 0)) continue
    rgba[o] = linearToSrgb(s0 / s3); rgba[o + 1] = linearToSrgb(s1 / s3); rgba[o + 2] = linearToSrgb(s2 / s3); rgba[o + 3] = 255
    labels[i] = f & 1 ? label[i] : f & 2 ? raw[i] : NO_LABEL
  }
}

// O3 + O5: the mosaic's one read of every photo before the blocks. Each map is read
// once with its photo decoded coarse, at ~2 px per sampling step:
//   - gains (colourBalance) per image and channel (colourGains.js fitGains, which
//     explains the model and its guards), from a lattice of every k-th cell: every
//     lattice cell a map sees gets that map's colour in linear light, unless a channel
//     is clipped;
//   - graph-cut seams (seamline 'graphcut', seamCut.js): every coarse cell of the seam
//     grid keeps its most nadir views with their footprint and colour, and after the
//     gains the coarse labels are solved. The cells are culled per map in tiles of
//     SURVEY_TILE² coarse cells by the same exact box test as the blocks.
const SURVEY_TILE = 32
async function mosaicSurvey(surface, geom, metas, loadMap, loadImage, toSfm, gp, opts, tick, { gainsOn, cut }) {
  const { width: W, height: H } = geom, n = metas.length
  const { depthTolRel = 0.02, maxCost = Infinity } = opts
  const k = Math.max(4, Math.ceil(Math.sqrt((W * H) / GAIN_LATTICE_CELLS)))
  const pts = growable(Float64Array)
  const rowData = new Float32Array(W), rowMask = new Uint8Array(W), P = [0, 0, 0]
  if (gainsOn) {
    for (let row = k >> 1; row < H; row += k) {
      sampleSurfaceWindow(surface, geom, 0, row, W, 1, rowData, rowMask)
      for (let col = k >> 1; col < W; col += k) {
        if (!rowMask[col]) continue
        cellToSfm(geom, gp.affine, toSfm, col, row, rowData[col], P)
        pts.push(P[0]); pts.push(P[1]); pts.push(P[2])
      }
    }
  }
  const L = pts.length / 3, xyz = pts.array
  // The seam grid: each coarse cell's height at its sample cell, and per tile the
  // height range and frame box for the cull.
  let sg = null, sv = null, cz = null, cm = null, tiles = null
  if (cut) {
    sg = seamGrid(W, H, opts.seamCutCells ?? SEAM_CUT_CELLS)
    sv = createSeamSurvey(sg)
    const { cw, ch } = sg
    cz = new Float32Array(cw * ch); cm = new Uint8Array(cw * ch)
    for (let j = 0; j < ch; j++) {
      sampleSurfaceWindow(surface, geom, 0, seamSampleCol(sg, j, H), W, 1, rowData, rowMask)
      for (let i = 0; i < cw; i++) {
        const col = seamSampleCol(sg, i, W)
        if (rowMask[col]) { cz[j * cw + i] = rowData[col]; cm[j * cw + i] = 1 }
      }
    }
    const tx = Math.ceil(cw / SURVEY_TILE), ty = Math.ceil(ch / SURVEY_TILE)
    tiles = []
    for (let b = 0; b < ty; b++) for (let a = 0; a < tx; a++) {
      const i0 = a * SURVEY_TILE, j0 = b * SURVEY_TILE, i1 = Math.min(cw, i0 + SURVEY_TILE), j1 = Math.min(ch, j0 + SURVEY_TILE)
      let lo = Infinity, hi = -Infinity
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
        const p = j * cw + i
        if (cm[p]) { if (cz[p] < lo) lo = cz[p]; if (cz[p] > hi) hi = cz[p] }
      }
      if (!(lo <= hi)) continue
      const c0 = seamSampleCol(sg, i0, W), c1 = seamSampleCol(sg, i1 - 1, W)
      const r0 = seamSampleCol(sg, j0, H), r1 = seamSampleCol(sg, j1 - 1, H)
      const box = [geom.originX + (c0 + 0.5) * geom.gsd, geom.originX + (c1 + 0.5) * geom.gsd,
        geom.originY - (r1 + 0.5) * geom.gsd, geom.originY - (r0 + 0.5) * geom.gsd, lo, hi]
      tiles.push({ i0, j0, i1, j1, box, near: gp.local(box) })
    }
  }
  const obsPt = growable(Int32Array), obsImg = growable(Int32Array), obsRgb = growable(Float32Array)
  const g = {}, px = new Float32Array(4)
  let clippedObs = 0, readMs = 0, fromMapRgb = 0
  const t0 = performance.now()
  // Photo decode: ~2 px per step of the finer of the two samplings.
  const stepCells = Math.min(gainsOn ? k : Infinity, cut ? sg.f : Infinity)
  for (let mi = 0; mi < n; mi++) {
    const tr = performance.now()
    const m = await loadMap(mi)
    const per = gp.mapPxPerCell(m)
    // The map's own colour plane is its photo resampled to the depth map's scale. Where a
    // survey step spans ≥ 2 map px, that is as fine as the decode would be (≈ 2 photo px
    // per step), so the photo is not decoded at all: on quarry-347 the survey decoded
    // every photo at ~8 % of native, ~0.3 s each, for colour the map already had at 25 %.
    const ownColour = !!m.rgb && per > 0 && per * stepCells >= 2
    if (ownColour) fromMapRgb++
    const photo = loadImage && !ownColour ? await loadImage(mi, m, per > 0 ? per * stepCells : null) : null
    readMs += performance.now() - tr
    const C = cameraCentre(m)
    for (let p = 0; p < L; p++) {
      P[0] = xyz[3 * p]; P[1] = xyz[3 * p + 1]; P[2] = xyz[3 * p + 2]
      if (!seenFrom(m, C, P, gp.up, depthTolRel, maxCost, g) || !sampleColour(m, photo, g, px)) continue
      if (gainSampleClipped(px[0], px[1], px[2])) { clippedObs++; continue }
      obsPt.push(p); obsImg.push(mi)
      obsRgb.push(srgbToLinear(px[0])); obsRgb.push(srgbToLinear(px[1])); obsRgb.push(srgbToLinear(px[2]))
    }
    if (cut) {
      const { cw } = sg, fx = m.K.fx
      for (const t of tiles) {
        if (!boxReachesMap(m, t.near, t.near.box)) continue
        for (let j = t.j0; j < t.j1; j++) {
          const row = seamSampleCol(sg, j, H)
          for (let i = t.i0; i < t.i1; i++) {
            const p = j * cw + i
            if (!cm[p]) continue
            cellToSfm(geom, gp.affine, toSfm, seamSampleCol(sg, i, W), row, cz[p], P)
            if (!seenFrom(m, C, P, gp.up, depthTolRel, maxCost, g) || !sampleColour(m, photo, g, px)) continue
            addSeamCandidate(sv, p, mi, g.depth / (fx * g.cos * g.cos), Math.round(px[0]), Math.round(px[1]), Math.round(px[2]))
          }
        }
      }
    }
    tick()
  }
  let balance = null
  if (gainsOn) {
    const { gains, summary } = fitGains({ nImages: n, nPoints: L, obsPt: obsPt.array, obsImg: obsImg.array, obsRgb: obsRgb.array })
    balance = { gains, summary: { latticeStep: k, latticeCells: L, clippedObservations: clippedObs, ...summary } }
  }
  const t1 = performance.now()
  let seams = null
  if (cut) {
    const res = solveSeams(sv, balance?.gains ?? null, opts.seamCutWeights)
    // Where the time went: reading maps + decoding photos, sampling, the min cuts.
    seams = { ...res, grid: sg, ms: { read: Math.round(readMs), sample: Math.round(t1 - t0 - readMs), solve: Math.round(performance.now() - t1) } }
  }
  return { balance, seams, fromMapRgb }
}

// What the ortho's map/photo cache can hold against what one block needs, as a log
// entry. Fewer entries than a block's maps re-read (and re-decode) every map of that
// block on each pass, which is most of the run time when it happens.
// `streamed`: an entry is a depth map's planes and its photo, else the photo alone.
export function orthoCacheLog(cacheBytes, entryBytes, maxMaps, { mosaic = false, streamed = true } = {}) {
  const fit = Math.floor(cacheBytes / entryBytes)
  const head = `Ortho: the map/photo cache (${formatBytes(cacheBytes)}) holds about ${fit} `
    + `${streamed ? 'depth maps with their photos' : 'decoded photos'} (up to ${formatBytes(entryBytes)} each); `
    + `one block sees up to ${maxMaps} maps`
  if (fit >= maxMaps) return [head, 'info', 'Products']
  return [`${head}, so ${mosaic ? 'its passes re-read and re-decode' : 'it re-reads and re-decodes'} the photos `
    + 'of the busiest blocks. A coarser GSD (smaller photo decodes) or a higher memory budget '
    + '(Settings ▸ Compute) avoids it', 'warn', 'Products']
}

// The largest block window: core + halo on both sides, plus up to align − 1 cells per
// side where a multiband window rounds out to its pyramid lattice.
function maxWindow(W, H, B, halo, align) {
  const ext = B + 2 * halo + 2 * (align - 1)
  return { ew: Math.min(W, ext), eh: Math.min(H, ext) }
}

// The block layout and per-cell working bytes of a tiled run, for the caller's preflight.
// Per extended-window cell: height 4 + mask 1 + rgba 4 + label 2 + the gap fill's sample
// flags 1 + the stats' luma 4, plus the blend's state: 8 'best' / 32 'average' / for
// 'mosaic' raw + smoothing labels 4, score 8, sums 16, fallback 12, flags 1, distance 2,
// and for multiband its pyramids (multiband.js). Per core cell the handed-out copies,
// rgba 4 + label 2. A graph-cut mosaic holds its coarse labels (2 B per coarse cell)
// throughout, and before the blocks its survey of the candidates (orthoSeamSurveyBytes),
// whichever is larger.
export function orthoTiledWorkingBytes({ width, height, blend = 'best', fillRadius = 2, seamWidth = 0, seamline = 'nadir', seamBlend = 'feather', blendLevels = MULTIBAND_LEVELS, blockSize = ORTHO_BLOCK }) {
  const mode = mosaicMode({ blend, seamline, seamBlend, blendLevels })
  const halo = orthoHalo({ width, height, blend, fillRadius, seamWidth, seamline, seamBlend, blendLevels })
  const { ew, eh } = maxWindow(width, height, blockSize, halo, mode.align)
  const core = Math.min(width, blockSize) * Math.min(height, blockSize)
  const state = blend === 'average' ? 32 : blend === 'mosaic' ? 4 + 8 + 16 + 12 + 1 + 2 : 8
  const pyramids = mode.multiband ? MULTIBAND_BYTES_PER_CELL : 0
  const block = ew * eh * (4 + 1 + 4 + state + pyramids + 2 + 1 + 4) + core * 6
  if (!mode.graphcut) return block
  const { cw, ch } = seamGrid(width, height)
  return Math.max(block + 2 * cw * ch, orthoSeamSurveyBytes(width, height))
}

// The graph-cut survey before the blocks: per coarse cell its height + mask, the
// candidates (image 2, footprint 4, colour 3, data cost 4 each) and the solver's labels
// and flags (~8), plus a min-cut graph over at most the whole coarse grid (~60 B/node).
export function orthoSeamSurveyBytes(width, height) {
  const { cw, ch } = seamGrid(width, height)
  return cw * ch * (5 + SEAM_CANDIDATES * 13 + 8 + 60)
}

// surface: the height grid ({ width, height, gsd, originX, originY, data, mask });
// geom: the ortho grid over it (surface.js resampledGeometry — any size).
// metas[i]: each map's geometry { width, height, K, R, t } (no planes needed);
// loadMap(i) → the map with planes. toSfm, opts: as orthorectifyStreamed, plus
//   opts.blend 'mosaic' with opts.colourBalance (O3 gains), opts.seamline ('nadir' |
//   'graphcut', O5), opts.seamBlend ('feather' | 'multiband', O4b) and opts.seamWidth
//   (% of the short side, O4a feathering; 0 = hard seams), opts.blockSize (default ORTHO_BLOCK),
//   opts.cacheBytes (map + photo cache budget, default 1 GiB), opts.mapsResident (the
//   maps are already in memory, so only decoded photos count against the cache).
// hooks: { loadImage (as orthorectifyStreamed's), loadStatsImage (the gain pass's
//   photos; default loadImage), onProgress(done, total),
//   onBlocksStart(blockCount) — once, after the mosaic survey, before the first block,
//   onBlock({ col0, row0, width, height, rgba, labels }) — awaited, the core cells of
//   one block in row-major order, fresh arrays the hook may keep }.
// → { width, height, covered, sampled, filled, surfaceCells, labelled, stats, blocks,
//     visits, mapLoads, photoLoads, cacheHits, mosaic?, gains? }
export async function orthorectifyTiled(surface, geom, metas, loadMap, toSfm, opts = {}, hooks = {}) {
  const { onProgress = () => {}, onBlock = null, loadImage = null } = hooks
  const { width: W, height: H } = geom
  const B = opts.blockSize ?? ORTHO_BLOCK
  const fillRadius = opts.fillRadius ?? 2, fillMethod = opts.fillMethod ?? 'idw'
  const mode = mosaicMode(opts), { mosaic, graphcut, multiband, align } = mode
  if (mosaic && metas.length >= NO_LABEL) throw new Error(`a mosaic labels cells with a 16-bit image index; ${metas.length} depth maps is too many`)
  const seamCells = mosaic && !multiband ? mosaicSeamCells(W, H, opts.seamWidth ?? 0) : 0
  const halo = orthoHalo({ width: W, height: H, blend: opts.blend, fillRadius, seamWidth: opts.seamWidth ?? 0,
    seamline: opts.seamline, seamBlend: opts.seamBlend, blendLevels: mode.levels })
  if (!(B >= 1)) throw new Error(`orthorectifyTiled: block size ${B} must be positive`)
  const nbx = Math.ceil(W / B), nby = Math.ceil(H / B), nBlocks = nbx * nby

  // Pre-pass: the grid's height range and mean (row-major, as the single pass reads
  // them), the surface cell count, and each block core's height range for the cull.
  const blockLo = new Float64Array(nBlocks).fill(Infinity), blockHi = new Float64Array(nBlocks).fill(-Infinity)
  const rowData = new Float32Array(W), rowMask = new Uint8Array(W)
  let zLo = Infinity, zHi = -Infinity, zMid = 0, surfaceCells = 0
  for (let row = 0; row < H; row++) {
    sampleSurfaceWindow(surface, geom, 0, row, W, 1, rowData, rowMask)
    const base = Math.floor(row / B) * nbx
    for (let col = 0; col < W; col++) {
      if (!rowMask[col]) continue
      const z = rowData[col]
      if (z < zLo) zLo = z
      if (z > zHi) zHi = z
      zMid += (z - zMid) / ++surfaceCells
      const bi = base + Math.floor(col / B)
      if (z < blockLo[bi]) blockLo[bi] = z
      if (z > blockHi[bi]) blockHi[bi] = z
    }
  }
  const gp = gridProjection(geom, toSfm, zLo, zHi, zMid)
  const { affine, mapPxPerCell } = gp

  // Block windows (core + halo, clipped to the grid; a multiband window rounded out to
  // its pyramid lattice) and the maps that can see each. The window reaches at most
  // `reach` blocks over, so those blocks' core ranges bound every height in it.
  const reach = Math.ceil((halo + align - 1) / B)
  const blocks = []
  for (let by = 0; by < nby; by++) for (let bx = 0; bx < nbx; bx++) {
    const col0 = bx * B, row0 = by * B, bw = Math.min(B, W - col0), bh = Math.min(B, H - row0)
    const ex0 = Math.max(0, Math.floor((col0 - halo) / align) * align), ey0 = Math.max(0, Math.floor((row0 - halo) / align) * align)
    const ex1 = Math.min(W, Math.ceil((col0 + bw + halo) / align) * align), ey1 = Math.min(H, Math.ceil((row0 + bh + halo) / align) * align)
    let lo = Infinity, hi = -Infinity
    for (let ny = Math.max(0, by - reach); ny <= Math.min(nby - 1, by + reach); ny++) {
      for (let nx = Math.max(0, bx - reach); nx <= Math.min(nbx - 1, bx + reach); nx++) {
        lo = Math.min(lo, blockLo[ny * nbx + nx]); hi = Math.max(hi, blockHi[ny * nbx + nx])
      }
    }
    const maps = []
    if (lo <= hi) {
      // The cull with the block's own affine (and its grown box) when the frame has none.
      const near = gp.local([geom.originX + (ex0 + 0.5) * geom.gsd, geom.originX + (ex1 - 0.5) * geom.gsd,
        geom.originY - (ey1 - 0.5) * geom.gsd, geom.originY - (ey0 + 0.5) * geom.gsd, lo, hi])
      for (let mi = 0; mi < metas.length; mi++) if (boxReachesMap(metas[mi], near, near.box)) maps.push(mi)
    }
    blocks.push({ col0, row0, bw, bh, ex0, ey0, ew: ex1 - ex0, eh: ey1 - ey0, maps, empty: !(lo <= hi) })
  }

  // O3 + O5: the gains and the graph-cut labels, once for the whole grid, before any
  // block — and before the visits are planned, since the cut says which maps own a part
  // of each block and so need their photos there. The progress total is corrected once
  // the visits are known.
  let ticks = 0
  const survey = mosaic && (opts.colourBalance || graphcut)
  const passes = !mosaic ? 1 : multiband ? 3 : 2
  let total = (survey ? metas.length : 0) + blocks.reduce((n, b) => n + b.maps.length, 0) * passes
  const tick = () => onProgress(++ticks, total)
  let balance = null, seams = null, surveyFromMapRgb = 0
  if (survey) {
    ({ balance, seams, fromMapRgb: surveyFromMapRgb } = await mosaicSurvey(surface, geom, metas, loadMap, hooks.loadStatsImage ?? loadImage, toSfm, gp, opts, tick,
      { gainsOn: !!opts.colourBalance, cut: graphcut }))
  }

  // The visit sequence, and for each visit when its map is wanted next (Belady). A
  // mosaic visits a block's maps twice — labels, then colour — and a multiband one a
  // third time for the corrections; the colour passes skip the maps that own no cells
  // there, which only makes the plan pessimistic. Successive passes alternate their
  // order (ascending, descending, ascending), so each starts on the maps the last one
  // left in the cache.
  //
  // Blocks are taken in groups (`opts.groupBlocks`, a rectangle of neighbouring blocks,
  // P6): each pass of a group visits every map its blocks see ONCE, map-major, and each
  // block of the group takes from that visit. With many blocks a photo is then read once
  // per pass per group rather than per block. Within one block every map keeps its
  // per-pass order, so a block computes exactly what it computes alone.
  // `groupBlocks: 'auto'` picks the size (chooseGroupSize) from the cache it leaves:
  // each block of a group holds `opts.blockBytes` of working planes, taken from the cache.
  const grouping = opts.groupBlocks === 'auto'
    ? chooseGroupSize(nbx, nby, blocks, passes, mosaic, { cacheBytes: opts.cacheBytes ?? 1024 ** 3,
      blockBytes: opts.blockBytes ?? 0, entryBytes: opts.entryBytes ?? 0, mapsResident: !!opts.mapsResident,
      entrySizes: opts.entrySizes ?? null, owners: seams ? blocks.map((b) => ownersFromCut(seams, b)) : null })
    : { size: Math.max(1, Math.floor(opts.groupBlocks ?? 1)) }
  const groups = blockGroups(nbx, nby, grouping.size)
  const groupMaps = groups.map((g) => unionMaps(g.map((bi) => blocks[bi])))
  const sequence = visitSequence(groupMaps, passes)
  const nextUse = new Float64Array(sequence.length)
  {
    const seen = new Map()
    for (let p = sequence.length - 1; p >= 0; p--) { nextUse[p] = seen.get(sequence[p]) ?? Infinity; seen.set(sequence[p], p) }
  }
  const cacheBytes = (opts.cacheBytes ?? 1024 ** 3) - (grouping.size - 1) * (opts.blockBytes ?? 0)
  const cache = new Map() // mi → { m, photo, hasPhoto, bytes, next }
  let cached = 0, mapLoads = 0, photoLoads = 0, cacheHits = 0
  // The cache's limit: `cacheBytes`, until a photo decode runs out of memory (below).
  let cacheLimit = cacheBytes, shrinks = 0
  const evict = (keep = -1) => {
    for (const [mi, e] of cache) if (e.next === Infinity && mi !== keep) { cache.delete(mi); cached -= e.bytes }
    while (cached > cacheLimit && cache.size > (cache.has(keep) ? 1 : 0)) {
      let worst = -1, far = -Infinity
      for (const [mi, e] of cache) if (e.next > far && mi !== keep) { far = e.next; worst = mi }
      cached -= cache.get(worst).bytes; cache.delete(worst)
    }
  }
  // The tab's real ceiling is below what the arithmetic allows when buffers come and go
  // (quarry-347 at long side 12,000: 56 photo decodes failed "Out of memory at ImageData
  // creation" at 14.6 GB of process data, with an 8.6 GB cache). A decode that runs out of
  // memory takes a quarter off the cache for the rest of the run and is tried once more;
  // only a second failure falls back to the map's own colour. (Halving cost the same run
  // 1,313 photo decodes instead of ~900 after one refusal.)
  const loadPhoto = async (mi, e) => {
    try {
      return await loadImage(mi, e.m, mapPxPerCell(e.m), { rethrowOutOfMemory: true })
    } catch (err) {
      if (!err?.outOfMemory) throw err
      shrinks++
      cacheLimit = Math.max(1, Math.min(cacheLimit, cached) * 0.75)
      evict(mi)
      return loadImage(mi, e.m, mapPxPerCell(e.m))
    }
  }
  // A map's planes, and its photo once a pass needs colour (the mosaic's label pass
  // does not), loaded on a miss.
  // Where the time goes (ms), for the caller's debug log: map reads + photo decodes,
  // the label pass, the colour pass, and a multiband blend's ring samples and pyramids.
  const ms = { read: 0, label: 0, colour: 0, ring: 0, pyramid: 0 }
  const clock = (key, t) => { ms[key] += performance.now() - t }
  const fetch = async (mi, wantPhoto) => {
    const t = performance.now()
    try { return await fetchEntry(mi, wantPhoto) } finally { clock('read', t) }
  }
  const fetchEntry = async (mi, wantPhoto) => {
    let e = cache.get(mi)
    if (e && (!wantPhoto || e.hasPhoto)) cacheHits++
    if (!e) {
      const m = await loadMap(mi)
      mapLoads++
      e = { m, photo: null, hasPhoto: false, bytes: opts.mapsResident ? 0 : viewBytes(m), next: Infinity }
      cache.set(mi, e); cached += e.bytes
    }
    if (wantPhoto && !e.hasPhoto) {
      e.photo = loadImage ? await loadPhoto(mi, e) : null
      e.hasPhoto = true
      if (e.photo) { photoLoads++; const b = e.photo.data?.byteLength ?? 0; e.bytes += b; cached += b }
    }
    return e
  }
  let pos = 0
  total = (survey ? metas.length : 0) + sequence.length
  const visited = (mi, e) => {
    const p = pos++
    if (e) e.next = nextUse[p]
    else { const c = cache.get(mi); if (c) c.next = nextUse[p] }
    evict()
    tick()
  }

  // Window buffers, sized once for the largest window: one set per block of a group.
  const win0 = maxWindow(W, H, B, halo, align), maxCells = win0.ew * win0.eh
  const average = opts.blend === 'average'
  const groupSize = groups.reduce((n, g) => Math.max(n, g.length), 0)
  const states = Array.from({ length: groupSize }, () => ({
    buf: {
      data: new Float32Array(maxCells), mask: new Uint8Array(maxCells), rgba: new Uint8ClampedArray(maxCells * 4),
      scores: average || mosaic ? null : new Float64Array(maxCells), sums: average ? new Float64Array(maxCells * 4) : null,
      labels: newLabels(maxCells, opts, metas.length),
    },
    mb: mosaic ? {
      raw: new Uint16Array(maxCells), label: new Uint16Array(maxCells), tmp: new Uint16Array(maxCells),
      score: new Float64Array(maxCells), sums: new Float32Array(maxCells * 4), fallback: new Float32Array(maxCells * 3),
      flags: new Uint8Array(maxCells), dist: new Uint16Array(maxCells),
      pyr: multiband ? createMultiband(win0.ew, win0.eh, mode.levels) : null,
    } : null,
    // map index → its position in the block's map list, -1 for a map the block does not see
    slot: new Int32Array(metas.length).fill(-1),
  }))
  const labelled = !!states[0]?.buf.labels
  const stats = createOrthoStats(W, H, labelled)
  const scratch = { P: [0, 0, 0], px: new Float32Array(4), g: {} }
  let sampled = 0, covered = 0

  // `maxMaps`: the most maps one block sees, which the cache must hold for a block's
  // passes to read each map once; `groups` / `groupMaps`: the same for a group.
  hooks.onBlocksStart?.(nBlocks, { maxMaps: blocks.reduce((n, b) => Math.max(n, b.maps.length), 0),
    groups: groups.length, groupSize: grouping.size, groupMaps: groupMaps.reduce((n, m) => Math.max(n, m.length), 0), cacheBytes })
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]
    hooks.onGroup?.(gi, groups.length, group.length)
    // The group's blocks with a surface, each in its own window buffers.
    const active = []
    group.forEach((bi, si) => {
      const b = blocks[bi]
      if (b.empty) return
      const { ex0, ey0, ew, eh } = b, n = ew * eh, { buf } = states[si]
      const win = {
        x0: ex0, y0: ey0, w: ew, h: eh,
        data: buf.data.subarray(0, n), mask: buf.mask.subarray(0, n), rgba: buf.rgba.subarray(0, n * 4).fill(0),
        scores: buf.scores?.subarray(0, n).fill(Infinity) ?? null, sums: buf.sums?.subarray(0, n * 4).fill(0) ?? null,
        labels: buf.labels?.subarray(0, n).fill(NO_LABEL) ?? null,
      }
      sampleSurfaceWindow(surface, geom, ex0, ey0, ew, eh, win.data, win.mask)
      const st = states[si]
      b.maps.forEach((mi, j) => { st.slot[mi] = j })
      active.push({ b, win, n, st })
    })
    for (const a of active) winTiles(a.win, geom, gp)
    if (mosaic) {
      await mosaicGroup(active)
    } else {
      for (const mi of unionMaps(active.map((a) => a.b))) {
        const e = await fetch(mi, true)
        const t = performance.now()
        for (const a of active) if (a.st.slot[mi] >= 0) colourFromMap(a.win, geom, e.m, e.photo, mi, affine, toSfm, opts, scratch)
        clock('colour', t)
        visited(mi, e)
      }
    }
    // Finish and hand on every block of the group, in block order.
    for (const bi of group) {
      const b = blocks[bi], a = active.find((x) => x.b === b)
      const { col0, row0, bw, bh, ex0, ey0, ew, eh } = b
      const coreRgba = new Uint8ClampedArray(bw * bh * 4)
      const coreLabels = labelled ? new Uint16Array(bw * bh).fill(NO_LABEL) : null
      if (a) {
        const { win } = a
        const cx = col0 - ex0, cy = row0 - ey0
        const s0 = finishWindow(win, cx, cy, bw, bh)
        fillOrthoGaps(win.rgba, win.mask, ew, eh, fillRadius, fillMethod)
        const c = countColoured(win.rgba, ew, cx, cy, bw, bh)
        sampled += s0; covered += c
        stats.add({ rgba: win.rgba, labels: win.labels, x0: ex0, y0: ey0, w: ew, h: eh, cx0: col0, cy0: row0, cw: bw, ch: bh })
        for (let r = 0; r < bh; r++) {
          const src = (cy + r) * ew + cx
          coreRgba.set(win.rgba.subarray(src * 4, (src + bw) * 4), r * bw * 4)
          if (coreLabels) coreLabels.set(win.labels.subarray(src, src + bw), r * bw)
        }
        for (const mi of b.maps) a.st.slot[mi] = -1
      }
      if (onBlock) await onBlock({ col0, row0, width: bw, height: bh, rgba: coreRgba, labels: coreLabels })
    }
  }
  cache.clear()
  return {
    width: W, height: H, covered, sampled, filled: covered - sampled, surfaceCells,
    labelled, stats: stats.finish(), blocks: nBlocks, groups: groups.length,
    grouping: { size: grouping.size, groups: groups.length, cacheBytes, predicted: grouping.predicted ?? null },
    cacheShrinks: shrinks, cacheLimit,
    ...(survey ? { surveyFromMapRgb } : {}),
    visits: blocks.reduce((v, b) => v + b.maps.length, 0),
    mapLoads, photoLoads, cacheHits,
    timings: Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(v)])),
    ...(mosaic ? { mosaic: {
      seamline: graphcut ? 'graphcut' : 'nadir', seamBlend: multiband ? 'multiband' : 'feather',
      seamCells, smoothPasses: graphcut ? 0 : MOSAIC_SMOOTH_PASSES, levels: multiband ? mode.levels : 0,
      seamCut: seams?.summary ?? null, balance: balance?.summary ?? null,
    } } : {}),
    // Where the graph-cut survey's time went (ms): map + photo reads, sampling, min cuts.
    ...(seams ? { seamCutMs: seams.ms } : {}),
    // Per image the R, G, B gains (3 per map, map order), for the caller's audit log.
    ...(balance ? { gains: balance.gains } : {}),
  }

  // The mosaic's passes over a group's block windows (see the section comment above):
  // each pass visits each map once, and every block that sees it takes its share.
  async function mosaicGroup(active) {
    for (const a of active) {
      const { win, n, st } = a, mbs = st.mb
      Object.assign(win, {
        raw: mbs.raw.subarray(0, n).fill(NO_LABEL), score: mbs.score.subarray(0, n).fill(Infinity),
        label: mbs.label.subarray(0, n), sums: null, msums: mbs.sums.subarray(0, n * 4).fill(0),
        fallback: mbs.fallback.subarray(0, n * 3), flags: mbs.flags.subarray(0, n).fill(0), dist: mbs.dist.subarray(0, n),
      })
    }
    const union = unionMaps(active.map((a) => a.b))
    // Pass 1: labels (no photo).
    for (const mi of union) {
      const e = await fetch(mi, false)
      const t = performance.now()
      for (const a of active) if (a.st.slot[mi] >= 0) labelFromMap(a.win, geom, e.m, mi, gp, toSfm, opts, scratch)
      clock('label', t)
      visited(mi, e)
    }
    const band = multiband ? 0 : seamCells, seam3 = 3 * band
    const gains = balance?.gains ?? null
    for (const a of active) {
      const { b, win, n, st } = a, { ew, eh } = b, k = b.maps.length
      if (seams) {
        // O5: the coarse graph-cut label of each cell; its pass-1 label where the coarse
        // cell has none, or names a map that sees nothing of this window (culled).
        const { labels: cut, grid: { f, cw } } = seams
        for (let r = 0, i = 0; r < eh; r++) {
          const crow = Math.floor((b.ey0 + r) / f) * cw
          for (let c = 0; c < ew; c++, i++) {
            const l = cut[crow + Math.floor((b.ex0 + c) / f)]
            win.label[i] = l !== NO_LABEL && st.slot[l] >= 0 ? l : win.raw[i]
          }
        }
      } else smoothLabels(win.raw, win.label, st.mb.tmp.subarray(0, n), ew, eh)
      // Each map's box: its region grown by the seam band, joined with the cells it
      // holds as the pass-1 fallback.
      const own = new Int32Array(4 * k), fb = new Int32Array(4 * k)
      for (let j = 0; j < k; j++) { own.set([ew, eh, -1, -1], 4 * j); fb.set([ew, eh, -1, -1], 4 * j) }
      const grow = (arr, o, c, r) => {
        if (c < arr[o]) arr[o] = c
        if (r < arr[o + 1]) arr[o + 1] = r
        if (c > arr[o + 2]) arr[o + 2] = c
        if (r > arr[o + 3]) arr[o + 3] = r
      }
      for (let r = 0, i = 0; r < eh; r++) for (let c = 0; c < ew; c++, i++) {
        const l = win.label[i], rl = win.raw[i]
        if (l !== NO_LABEL) grow(own, 4 * st.slot[l], c, r)
        if (rl !== NO_LABEL && rl !== l) grow(fb, 4 * st.slot[rl], c, r)
      }
      a.own = own; a.fb = fb
      a.step = { ...scratch, P: [0, 0, 0] }
      a.viewWin = { ...win, sums: win.msums }
    }
    // Pass 2: colour, descending (see passOrder).
    for (let u = union.length - 1; u >= 0; u--) {
      const mi = union[u]
      const boxes = []
      for (const a of active) {
        const j = a.st.slot[mi]
        if (j < 0) continue
        const o = 4 * j, { own, fb } = a, { ew, eh } = a.b
        const hasOwn = own[o + 2] >= 0, hasFb = fb[o + 2] >= 0
        if (!hasOwn && !hasFb) continue
        let x0 = ew, y0 = eh, x1 = 0, y1 = 0
        if (hasOwn) {
          x0 = Math.max(0, own[o] - band); y0 = Math.max(0, own[o + 1] - band)
          x1 = Math.min(ew, own[o + 2] + 1 + band); y1 = Math.min(eh, own[o + 3] + 1 + band)
        }
        if (hasFb) {
          x0 = Math.min(x0, fb[o]); y0 = Math.min(y0, fb[o + 1]); x1 = Math.max(x1, fb[o + 2] + 1); y1 = Math.max(y1, fb[o + 3] + 1)
        }
        boxes.push({ a, hasOwn, box: [x0, y0, x1, y1] })
      }
      if (!boxes.length) { visited(mi, null); continue }
      const e = await fetch(mi, true)
      const t = performance.now()
      for (const { a, hasOwn, box: [x0, y0, x1, y1] } of boxes) {
        const { win } = a, ew = a.b.ew
        if (seam3 && hasOwn) chamferTo(win.label, ew, x0, y0, x1, y1, mi, win.dist)
        else if (seam3) for (let r = y0; r < y1; r++) win.dist.fill(0xffff, r * ew + x0, r * ew + x1)
        blendFromMap(a.viewWin, geom, e.m, e.photo, mi, gp, toSfm, opts, a.step, [x0, y0, x1, y1], seam3, gains)
      }
      clock('colour', t)
      visited(mi, e)
    }
    if (multiband) await multibandGroup(active, union, gains)
    else for (const a of active) finishMosaicWindow({ ...a.win, sums: a.win.msums })
  }

  // O4b: the hard-seam mosaic of pass 2 is the base; each map then adds its pyramid
  // correction over the ring around its effective region (multiband.js), map by map
  // across the group's blocks.
  async function multibandGroup(active, union, gains) {
    const { ring, margin } = multibandReach(mode.levels), ring3 = 3 * ring
    for (const a of active) {
      const { b, win, n, st } = a, { ew, eh } = b
      const { mask, label, raw, msums, fallback, flags } = win
      // The effective label and its colour: the label where it saw the cell, else the
      // pass-1 fallback (as finishMosaicWindow), in linear light, gains applied.
      const eff = st.mb.tmp.subarray(0, n)
      for (let i = 0; i < n; i++) {
        const f = flags[i], o = 4 * i
        eff[i] = NO_LABEL
        if (!mask[i]) continue
        if (f & 1) eff[i] = label[i]
        else if (f & 2) { eff[i] = raw[i]; msums[o] = fallback[3 * i]; msums[o + 1] = fallback[3 * i + 1]; msums[o + 2] = fallback[3 * i + 2] }
      }
      const t = performance.now()
      multibandBegin(st.mb.pyr, ew, eh, eff, NO_LABEL)
      clock('pyramid', t)
      const k = b.maps.length, box = new Int32Array(4 * k)
      for (let j = 0; j < k; j++) box.set([ew, eh, -1, -1], 4 * j)
      for (let r = 0, i = 0; r < eh; r++) for (let c = 0; c < ew; c++, i++) {
        const l = eff[i]
        if (l === NO_LABEL) continue
        const o = 4 * st.slot[l]
        if (c < box[o]) box[o] = c
        if (r < box[o + 1]) box[o + 1] = r
        if (c > box[o + 2]) box[o + 2] = c
        if (r > box[o + 3]) box[o + 3] = r
      }
      a.eff = eff; a.mbox = box
    }
    const { depthTolRel = 0.02, maxCost = Infinity } = opts
    for (const mi of union) {
      const users = active.filter((a) => a.st.slot[mi] >= 0 && a.mbox[4 * a.st.slot[mi] + 2] >= 0)
      if (!users.length) { visited(mi, null); continue }
      const e = await fetch(mi, true), m = e.m, C = cameraCentre(m)
      const g0 = gains ? gains[mi * 3] : 1, g1 = gains ? gains[mi * 3 + 1] : 1, g2 = gains ? gains[mi * 3 + 2] : 1
      for (const a of users) {
        const { b, win, eff, mbox, st, step } = a, { ew, eh } = b, o = 4 * st.slot[mi]
        const { P, g, px } = step
        const { msums } = win
        // The box on the window's pyramid lattice (the window's origin is on the grid's).
        const x0 = Math.max(0, Math.floor((mbox[o] - margin) / align) * align), y0 = Math.max(0, Math.floor((mbox[o + 1] - margin) / align) * align)
        const x1 = Math.min(ew, mbox[o + 2] + 1 + margin), y1 = Math.min(eh, mbox[o + 3] + 1 + margin)
        const bw = x1 - x0, bh = y1 - y0
        let t = performance.now()
        chamferTo(eff, ew, x0, y0, x1, y1, mi, win.dist)
        const d = win.fallback // free now: the box's colour differences, 3 per cell
        d.fill(0, 0, 3 * bw * bh)
        forTilesReaching(win, geom, m, gp.affine, x0, y0, x1, y1, (c0, r0, c1, r1) => {
          for (let wr = r0; wr < r1; wr++) for (let wc = c0; wc < c1; wc++) {
            const wi = wr * ew + wc, dd = win.dist[wi]
            if (dd === 0 || dd > ring3 || eff[wi] === NO_LABEL) continue
            winCellToSfm(win, geom, gp, toSfm, wc, wr, win.data[wi], P)
            if (!seenFrom(m, C, P, gp.up, depthTolRel, maxCost, g) || !sampleColour(m, e.photo, g, px)) continue
            const q = 3 * ((wr - y0) * bw + wc - x0), wo = 4 * wi
            d[q] = g0 * srgbToLinear(px[0]) - msums[wo]
            d[q + 1] = g1 * srgbToLinear(px[1]) - msums[wo + 1]
            d[q + 2] = g2 * srgbToLinear(px[2]) - msums[wo + 2]
          }
        })
        clock('ring', t)
        t = performance.now()
        multibandAdd(st.mb.pyr, x0, y0, bw, bh, d, eff, mi)
        clock('pyramid', t)
      }
      visited(mi, e)
    }
    for (const a of active) {
      const { win, eff, n, st } = a
      let t = performance.now()
      multibandFinish(st.mb.pyr, win.msums)
      clock('pyramid', t)
      const { rgba, labels, msums } = win
      for (let i = 0; i < n; i++) {
        const l = eff[i], o = 4 * i
        labels[i] = l
        if (l === NO_LABEL) continue
        rgba[o] = linearToSrgb(msums[o]); rgba[o + 1] = linearToSrgb(msums[o + 1]); rgba[o + 2] = linearToSrgb(msums[o + 2]); rgba[o + 3] = 255
      }
    }
  }
}

// Blocks in groups of about `size`: a rectangle of neighbouring blocks (squarer is
// better — fewer maps on its rim), the groups in serpentine row order so the next group
// starts beside the last one. Each group lists block indices in row-major order.
function blockGroups(nbx, nby, size) {
  const n = Math.max(1, Math.min(nbx * nby, Math.floor(size) || 1))
  let gx = Math.min(nbx, Math.max(1, Math.round(Math.sqrt(n))))
  let gy = Math.min(nby, Math.max(1, Math.floor(n / gx)))
  if (gx * gy < n && gx < nbx) gx = Math.min(nbx, Math.ceil(n / gy))
  const groups = []
  for (let ty = 0, row = 0; ty < nby; ty += gy, row++) {
    const xs = []
    for (let tx = 0; tx < nbx; tx += gx) xs.push(tx)
    if (row % 2) xs.reverse()
    for (const tx of xs) {
      const g = []
      for (let by = ty; by < Math.min(nby, ty + gy); by++) for (let bx = tx; bx < Math.min(nbx, tx + gx); bx++) g.push(by * nbx + bx)
      groups.push(g)
    }
  }
  return groups
}

// The order a run visits maps: per group, per pass, the group's maps — ascending on
// even passes, descending on odd ones (each pass starts on what the last left cached).
const passOrder = (maps, k) => (k % 2 ? [...maps].reverse() : maps)
function visitSequence(groupMaps, passes) {
  const seq = []
  for (const maps of groupMaps) for (let k = 0; k < passes; k++) for (const mi of passOrder(maps, k)) seq.push(mi)
  return seq
}

// Relative cost of a cache miss: a photo read and decode against a map's planes read
// (quarry-347, 2026-10-20: ~0.2–0.3 s against ~0.07 s).
const PHOTO_COST = 3, MAP_COST = 1

// P6: the group size that costs the fewest reads — each candidate's visit sequence
// replayed through a farthest-next-use cache (the run's own policy) of what the cache
// keeps after the group's working planes. With `entrySizes` ([{ map, photo }] per map, the
// EXPECTED bytes: planes, and the photo at its decode size) the replay counts bytes as the
// run does; without, every entry is `entryBytes`. The worst-case entry made a big cache
// look far worse than it is (quarry-347 at long side 12,000: block by block predicted
// 16,539, ran at ~4,000), so the run passes expected sizes. A mosaic's first pass needs
// no photo. A larger group must save ≥ 3 %: it holds more memory for less cache.
// → { size, predicted: { [size]: cost } }
// `owners` (per block, the Set of maps the graph cut gives part of it): a mosaic's colour
// passes decode only those maps' photos — of the 238 maps that see a quarry block at long
// side 12,000 a few dozen own any of it — so without them every visible map would count
// as a decode, which overrated both plans (10,302 predicted against ~4,000 run).
export function chooseGroupSize(nbx, nby, blocks, passes, mosaic, { cacheBytes, blockBytes, entryBytes, mapsResident = false, entrySizes = null, owners = null }) {
  const nBlocks = nbx * nby
  const predicted = {}
  let best = { size: 1, cost: Infinity }
  if (!(entryBytes > 0)) return { size: 1, predicted }
  for (const size of [1, 2, 4, 6, 9, 12, 16, 20, 25, 30, 36, 49, 64]) {
    if (size > 1 && size > nBlocks) break
    const room = cacheBytes - (size - 1) * blockBytes
    const cap = Math.floor(room / entryBytes)
    if (cap < 1) break
    const groupList = blockGroups(nbx, nby, size)
    const groupMaps = groupList.map((g) => unionMaps(g.map((bi) => blocks[bi])))
    const seq = visitSequence(groupMaps, passes)
    // Per visit: 1 = the map's planes (a label pass), 2 = also its photo, 0 = a colour pass
    // skipping a map that owns nothing of the group (only its next use moves).
    const kinds = []
    for (let gi = 0; gi < groupMaps.length; gi++) {
      const own = owners ? new Set(groupList[gi].flatMap((bi) => [...owners[bi]])) : null
      for (let k = 0; k < passes; k++) {
        for (const mi of passOrder(groupMaps[gi], k)) kinds.push(!mosaic ? 2 : k === 0 ? 1 : own && !own.has(mi) ? 0 : 2)
      }
    }
    const cost = replayCache(seq, kinds, entrySizes ? room : cap, mapsResident ? 0 : MAP_COST, entrySizes)
    predicted[size] = cost
    if (cost < best.cost * 0.97) best = { size, cost }
  }
  return { size: best.size, predicted }
}

// The cost of a visit sequence through a cache that evicts the entry wanted farthest
// ahead: a miss reads the map (`mapCost`), a visit that needs the photo decodes it unless
// the cached entry already has it. The cache holds `cap` entries, or with `sizes`
// (per map { map, photo } bytes) `cap` bytes.
function replayCache(seq, kinds, cap, mapCost, sizes = null) {
  const next = new Float64Array(seq.length), seen = new Map()
  for (let p = seq.length - 1; p >= 0; p--) { next[p] = seen.get(seq[p]) ?? Infinity; seen.set(seq[p], p) }
  const cache = new Map() // mi → { next, photo, bytes }
  let cost = 0, held = 0
  const over = () => (sizes ? held > cap : cache.size > cap)
  for (let p = 0; p < seq.length; p++) {
    const mi = seq[p]
    let e = cache.get(mi)
    if (kinds[p] === 0) {
      if (e) e.next = next[p]
      continue
    }
    if (!e) { cost += mapCost; e = { next: 0, photo: false, bytes: sizes ? sizes[mi].map : 1 }; cache.set(mi, e); held += e.bytes }
    if (kinds[p] === 2 && !e.photo) {
      cost += PHOTO_COST; e.photo = true
      if (sizes) { e.bytes += sizes[mi].photo; held += sizes[mi].photo }
    }
    e.next = next[p]
    for (const [k, v] of cache) if (v.next === Infinity) { cache.delete(k); held -= v.bytes }
    while (over() && cache.size) {
      let worst = -1, far = -Infinity
      for (const [k, v] of cache) if (v.next > far) { far = v.next; worst = k }
      held -= cache.get(worst).bytes; cache.delete(worst)
    }
  }
  return cost
}

// The maps the graph cut (its coarse label grid) gives a part of block b's window, of
// those the block sees.
function ownersFromCut({ labels, grid: { f, cw } }, b) {
  const sees = new Set(b.maps), own = new Set()
  const c0 = Math.floor(b.ex0 / f), c1 = Math.floor((b.ex0 + b.ew - 1) / f)
  const r0 = Math.floor(b.ey0 / f), r1 = Math.floor((b.ey0 + b.eh - 1) / f)
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const l = labels[r * cw + c]
    if (l !== NO_LABEL && sees.has(l)) own.add(l)
  }
  return own
}

// The maps any of these blocks sees, ascending.
function unionMaps(blocks) {
  const set = new Set()
  for (const b of blocks) for (const mi of b.maps) set.add(mi)
  return [...set].sort((a, b) => a - b)
}


// Can any cell of the frame-coordinate box [x0,x1]×[y0,y1]×[z0,z1] land on map m?
// Projected through the grid's affine toSfm, the box is a parallelepiped; u and v are
// linear-fractional in the point, so where the box lies wholly in front of the camera
// their extremes are at its corners. A box straddling the camera plane is kept; one
// wholly behind it is not (depth is affine too).
function boxReachesMap(m, affine, [x0, x1, y0, y1, z0, z1]) {
  const { c0, P0, A } = affine, { R, t, K } = m
  let behind = 0, straddle = false
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity
  for (let k = 0; k < 8; k++) {
    const dx = (k & 1 ? x1 : x0) - c0[0], dy = (k & 2 ? y1 : y0) - c0[1], dz = (k & 4 ? z1 : z0) - c0[2]
    const X = P0[0] + A[0] * dx + A[1] * dy + A[2] * dz
    const Y = P0[1] + A[3] * dx + A[4] * dy + A[5] * dz
    const Z = P0[2] + A[6] * dx + A[7] * dy + A[8] * dz
    const zc = R[2][0] * X + R[2][1] * Y + R[2][2] * Z + t[2]
    if (!(zc > 1e-9)) { behind++; straddle = true; continue }
    const xc = R[0][0] * X + R[0][1] * Y + R[0][2] * Z + t[0]
    const yc = R[1][0] * X + R[1][1] * Y + R[1][2] * Z + t[1]
    const u = K.fx * (xc / zc) + K.cx, v = K.fy * (yc / zc) + K.cy
    if (u < uMin) uMin = u; if (u > uMax) uMax = u
    if (v < vMin) vMin = v; if (v > vMax) vMax = v
  }
  if (behind === 8) return false
  if (straddle) return true
  // The kernel accepts round(u) ∈ [0, width − 1], i.e. u ∈ [−½, width − ½).
  return uMax >= -1.5 && uMin <= m.width + 0.5 && vMax >= -1.5 && vMin <= m.height + 0.5
}

function viewBytes(m) {
  let n = 0
  for (const v of Object.values(m)) if (ArrayBuffer.isView(v)) n += v.byteLength
  return n
}
