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
import { srgbToLinear, linearToSrgb } from './colourGains.js'
import { sampleSurfaceWindow } from './surface.js'
import { createOrthoStats } from '../eval/orthoStats.js'
import { seamGrid, SEAM_CANDIDATES } from './seamCut.js'
import {
  MULTIBAND_LEVELS,
  MULTIBAND_BYTES_PER_CELL,
  multibandReach,
  createMultiband,
  multibandBegin,
  multibandAdd,
  multibandFinish,
} from './multiband.js'
import {
  NO_LABEL,
  WIN_TILE,
  boxReachesMap,
  forTilesReaching,
  newLabels,
  projectInto,
  samplePhoto,
  winCellToSfm,
  winTiles,
} from './orthoWindow.js'
import {
  MOSAIC_SMOOTH_PASSES,
  blendFromMap,
  chamferTo,
  finishMosaicWindow,
  labelFromMap,
  mapSight,
  mosaicMode,
  mosaicSeamCells,
  mosaicSurvey,
  orthoHalo,
  sampleColour,
  smoothLabels,
} from './orthoMosaic.js'
import { blockGroups, chooseGroupSize, ownersFromCut, unionMaps, viewBytes, visitSequence } from './orthoPlan.js'

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
  let best = null // { score, rgb, mi }
  let wsum = 0,
    r = 0,
    g = 0,
    b = 0 // for 'average'

  for (let mi = 0; mi < maps.length; mi++) {
    const m = maps[mi]
    const p = projectInto(m, P)
    if (!p) continue
    const u = Math.round(p.u),
      v = Math.round(p.v)
    if (u < 0 || v < 0 || u >= m.width || v >= m.height) continue
    const idx = v * m.width + u
    const stored = m.depth[idx]
    if (!(stored > 0)) continue // no surface here
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
      wsum += w
      r += w * rgb[0]
      g += w * rgb[1]
      b += w * rgb[2]
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
      let nearest = -1,
        nearestD2 = Infinity,
        wsum = 0,
        rs = 0,
        gs = 0,
        bs = 0
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
          if (d2 < nearestD2) {
            nearestD2 = d2
            nearest = ni
          }
          const w = 1 / d2,
            o = ni * 4
          wsum += w
          rs += w * rgba[o]
          gs += w * rgba[o + 1]
          bs += w * rgba[o + 2]
        }
      }
      if (nearest < 0) continue
      const o = i * 4
      if (method === 'nearest') {
        const no = nearest * 4
        rgba[o] = rgba[no]
        rgba[o + 1] = rgba[no + 1]
        rgba[o + 2] = rgba[no + 2]
      } else {
        rgba[o] = Math.round(rs / wsum)
        rgba[o + 1] = Math.round(gs / wsum)
        rgba[o + 2] = Math.round(bs / wsum)
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
      rgba[o] = rgb[0]
      rgba[o + 1] = rgb[1]
      rgba[o + 2] = rgb[2]
      rgba[o + 3] = 255
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
export async function orthorectifyStreamed(
  grid,
  metas,
  loadMap,
  toSfm,
  opts = {},
  onProgress = () => {},
  loadImage = null,
) {
  refuseMosaic(opts)
  const { width, height, data, mask } = grid
  const n = width * height,
    rgba = new Uint8ClampedArray(n * 4)
  const average = opts.blend === 'average'
  // Per-cell state is a real cost at MAX_GRID (16.8 M cells): allocate only what
  // the chosen blend reads — 8 B/cell for 'best', 32 B/cell for 'average'.
  const scores = average ? null : new Float64Array(n).fill(Infinity)
  const sums = average ? new Float64Array(n * 4) : null
  const labels = newLabels(n, opts, metas.length)
  let zLo = Infinity,
    zHi = -Infinity,
    zMid = 0
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
function colourFromMap(win, grid, m, photo, mi, affine, toSfm, opts, scratch) {
  const { x0, y0, w, h, data, mask, rgba, scores, sums, labels } = win
  const { gsd, originX, originY } = grid
  const { depthTolRel = 0.02, maxCost = Infinity } = opts
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
function finishWindow(win, cx, cy, cw, ch) {
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
// A split ortho's block side (workers/ops/products.js orthoPlan): ORTHO_BLOCK, halved
// while the grid has fewer blocks than workers that could take them, down to
// ORTHO_BLOCK_MIN. The workers share out blocks, so a small ortho in one 2,048² block ran
// on one of them. Every block computes the cells it would in a larger one (its halo
// holds what its seams and fills read), so the ortho is the same bits at any block size
// (orthoMosaic.test.js); a smaller block costs more halo and more map visits.
export const ORTHO_BLOCK_MIN = 1024
export function orthoBlockSize(width, height, shares = 1) {
  let b = ORTHO_BLOCK
  while (b > ORTHO_BLOCK_MIN && Math.ceil(width / b) * Math.ceil(height / b) < shares) b /= 2
  return b
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
export function orthoTiledWorkingBytes({
  width,
  height,
  blend = 'best',
  fillRadius = 2,
  seamWidth = 0,
  seamline = 'nadir',
  seamBlend = 'feather',
  blendLevels = MULTIBAND_LEVELS,
  blockSize = ORTHO_BLOCK,
}) {
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
// → { width, height, covered, sampled, filled, surfaceCells, labelled, stats, statsState,
//     blocks, visits, mapLoads, photoLoads, cacheHits, mosaic?, gains? }
//
// Split over workers (workers/ops/products.js): `opts.planOnly` stops after the survey
// and the grouping and returns { plan: { survey, groupBlocks, groups, predicted,
// shareModel, groupVisits } }; a worker then runs with `opts.survey` (the plan's, instead
// of surveying again), `groupBlocks` (the plan's size), `opts.groupIndices` (its share of
// the groups, in order) and `opts.claims` (shared: a group goes to whichever worker
// claims it first). Every block computes what it computes in one run, so the blocks of
// all the shares are the single run's; their `statsState`s merge (core/eval/orthoStats.js).
export async function orthorectifyTiled(surface, geom, metas, loadMap, toSfm, opts = {}, hooks = {}) {
  const { onProgress = () => {}, onBlock = null, loadImage = null } = hooks
  const { width: W, height: H } = geom
  const B = opts.blockSize ?? ORTHO_BLOCK
  const fillRadius = opts.fillRadius ?? 2,
    fillMethod = opts.fillMethod ?? 'idw'
  const mode = mosaicMode(opts),
    { mosaic, graphcut, multiband, align } = mode
  if (mosaic && metas.length >= NO_LABEL)
    throw new Error(`a mosaic labels cells with a 16-bit image index; ${metas.length} depth maps is too many`)
  const seamCells = mosaic && !multiband ? mosaicSeamCells(W, H, opts.seamWidth ?? 0) : 0
  const halo = orthoHalo({
    width: W,
    height: H,
    blend: opts.blend,
    fillRadius,
    seamWidth: opts.seamWidth ?? 0,
    seamline: opts.seamline,
    seamBlend: opts.seamBlend,
    blendLevels: mode.levels,
  })
  if (!(B >= 1)) throw new Error(`orthorectifyTiled: block size ${B} must be positive`)
  const nbx = Math.ceil(W / B),
    nby = Math.ceil(H / B),
    nBlocks = nbx * nby

  // Pre-pass: the grid's height range and mean (row-major, as the single pass reads
  // them), the surface cell count, and each block core's height range for the cull.
  const blockLo = new Float64Array(nBlocks).fill(Infinity),
    blockHi = new Float64Array(nBlocks).fill(-Infinity)
  const rowData = new Float32Array(W),
    rowMask = new Uint8Array(W)
  let zLo = Infinity,
    zHi = -Infinity,
    zMid = 0,
    surfaceCells = 0
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
  for (let by = 0; by < nby; by++)
    for (let bx = 0; bx < nbx; bx++) {
      const col0 = bx * B,
        row0 = by * B,
        bw = Math.min(B, W - col0),
        bh = Math.min(B, H - row0)
      const ex0 = Math.max(0, Math.floor((col0 - halo) / align) * align),
        ey0 = Math.max(0, Math.floor((row0 - halo) / align) * align)
      const ex1 = Math.min(W, Math.ceil((col0 + bw + halo) / align) * align),
        ey1 = Math.min(H, Math.ceil((row0 + bh + halo) / align) * align)
      let lo = Infinity,
        hi = -Infinity
      for (let ny = Math.max(0, by - reach); ny <= Math.min(nby - 1, by + reach); ny++) {
        for (let nx = Math.max(0, bx - reach); nx <= Math.min(nbx - 1, bx + reach); nx++) {
          lo = Math.min(lo, blockLo[ny * nbx + nx])
          hi = Math.max(hi, blockHi[ny * nbx + nx])
        }
      }
      const maps = []
      if (lo <= hi) {
        // The cull with the block's own affine (and its grown box) when the frame has none.
        const near = gp.local([
          geom.originX + (ex0 + 0.5) * geom.gsd,
          geom.originX + (ex1 - 0.5) * geom.gsd,
          geom.originY - (ey1 - 0.5) * geom.gsd,
          geom.originY - (ey0 + 0.5) * geom.gsd,
          lo,
          hi,
        ])
        for (let mi = 0; mi < metas.length; mi++) if (boxReachesMap(metas[mi], near, near.box)) maps.push(mi)
      }
      blocks.push({ col0, row0, bw, bh, ex0, ey0, ew: ex1 - ex0, eh: ey1 - ey0, maps, empty: !(lo <= hi) })
    }

  // O3 + O5: the gains and the graph-cut labels, once for the whole grid, before any
  // block — and before the visits are planned, since the cut says which maps own a part
  // of each block and so need their photos there. The progress total is corrected once
  // the visits are known.
  let ticks = 0
  const survey = mosaic && (opts.colourBalance || graphcut) && !opts.survey
  const passes = !mosaic ? 1 : multiband ? 3 : 2
  let total = (survey ? metas.length : 0) + blocks.reduce((n, b) => n + b.maps.length, 0) * passes
  const tick = () => onProgress(++ticks, total)
  let balance = null,
    seams = null,
    surveyFromMapRgb = 0
  if (opts.survey) ({ balance, seams, fromMapRgb: surveyFromMapRgb } = opts.survey)
  else if (survey) {
    ;({
      balance,
      seams,
      fromMapRgb: surveyFromMapRgb,
    } = await mosaicSurvey(surface, geom, metas, loadMap, hooks.loadStatsImage ?? loadImage, toSfm, gp, opts, tick, {
      gainsOn: !!opts.colourBalance,
      cut: graphcut,
    }))
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
  const owners = seams ? blocks.map((b) => ownersFromCut(seams, b)) : null
  const groupingFor = (cacheBytes) =>
    opts.groupBlocks === 'auto'
      ? chooseGroupSize(nbx, nby, blocks, passes, mosaic, {
          cacheBytes,
          blockBytes: opts.blockBytes ?? 0,
          entryBytes: opts.entryBytes ?? 0,
          mapsResident: !!opts.mapsResident,
          entrySizes: opts.entrySizes ?? null,
          owners,
        })
      : { size: Math.max(1, Math.floor(opts.groupBlocks ?? 1)) }
  // Planning a split (`opts.planShares`: [{ k, cacheBytes }], a worker count and each
  // worker's cache): the count whose predicted time is least, each worker doing 1/k of the
  // visits' work and of the reads its cache size predicts (chooseGroupSize's replay).
  // More workers split the work but each holds a smaller cache and decodes more.
  let grouping,
    shareModel = null
  if (opts.planOnly && opts.planShares?.length) {
    const visits = blocks.reduce((n, b) => n + b.maps.length, 0)
    shareModel = opts.planShares.map(({ k, cacheBytes }) => {
      const g = groupingFor(cacheBytes),
        reads = g.predicted?.[g.size] ?? 0
      return { k, cacheBytes, grouping: g, reads, seconds: (ORTHO_VISIT_S * visits + ORTHO_READ_S * reads) / k }
    })
    const best = shareModel.reduce((a, b) => (b.seconds < a.seconds ? b : a))
    grouping = best.grouping
    shareModel = { workers: best.k, candidates: shareModel.map(({ grouping: _g, ...c }) => c) }
  } else grouping = groupingFor(opts.cacheBytes ?? 1024 ** 3)
  const groups = blockGroups(nbx, nby, grouping.size)
  if (opts.planOnly) {
    // groupVisits: each group's map visits, the work a split deals out.
    return {
      plan: {
        survey: mosaic ? { balance, seams, fromMapRgb: surveyFromMapRgb } : null,
        groupBlocks: grouping.size,
        groups: groups.length,
        predicted: grouping.predicted ?? null,
        shareModel,
        groupVisits: groups.map((g) => unionMaps(g.map((bi) => blocks[bi])).length * passes),
      },
    }
  }
  // This run's share of the groups (all of them unless the work is split), in order.
  const runGroups = opts.groupIndices ?? groups.map((_, gi) => gi)
  const groupMaps = runGroups.map((gi) => unionMaps(groups[gi].map((bi) => blocks[bi])))
  const sequence = visitSequence(groupMaps, passes)
  const nextUse = new Float64Array(sequence.length)
  {
    const seen = new Map()
    for (let p = sequence.length - 1; p >= 0; p--) {
      nextUse[p] = seen.get(sequence[p]) ?? Infinity
      seen.set(sequence[p], p)
    }
  }
  const cacheBytes = (opts.cacheBytes ?? 1024 ** 3) - (grouping.size - 1) * (opts.blockBytes ?? 0)
  const cache = new Map() // mi → { m, photo, hasPhoto, bytes, next }
  let cached = 0,
    mapLoads = 0,
    photoLoads = 0,
    cacheHits = 0
  // The cache's limit: `cacheBytes`, until a photo decode runs out of memory (below).
  let cacheLimit = cacheBytes,
    shrinks = 0
  // A prefetched entry (`pinned`, below) stays until its visit.
  const evict = (keep = -1) => {
    for (const [mi, e] of cache)
      if (e.next === Infinity && mi !== keep && !e.pinned) {
        cache.delete(mi)
        cached -= e.bytes
      }
    while (cached > cacheLimit && cache.size > (cache.has(keep) ? 1 : 0)) {
      let worst = -1,
        far = -Infinity
      for (const [mi, e] of cache)
        if (e.next > far && mi !== keep && !e.pinned) {
          far = e.next
          worst = mi
        }
      if (worst < 0) break
      cached -= cache.get(worst).bytes
      cache.delete(worst)
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
  const clock = (key, t) => {
    ms[key] += performance.now() - t
  }
  // A pass that needs photos names its maps in visit order first (planPhotos), and up to
  // `opts.photoPrefetch` of the next ones load ahead: the browser decodes a photo off the
  // worker's thread (createImageBitmap), so several decodes then run while this one
  // computes, where one at a time they ran end to end. The photos are the same either
  // way; the caller leaves room in the cache budget for the extra entries.
  const prefetchDepth = loadImage ? Math.max(0, opts.photoPrefetch ?? 0) : 0
  let plan = [],
    planPos = 0
  const pending = new Map() // mi → its entry's load
  const topUp = () => {
    while (pending.size < prefetchDepth && planPos < plan.length) {
      const mi = plan[planPos++]
      if (cache.get(mi)?.hasPhoto || pending.has(mi)) continue
      pending.set(mi, fetchEntry(mi, true, true))
    }
  }
  const planPhotos = (list) => {
    plan = list
    planPos = 0
    topUp()
  }
  const fetch = async (mi, wantPhoto) => {
    const t = performance.now()
    try {
      if (wantPhoto && pending.has(mi)) {
        const e = await pending.get(mi)
        pending.delete(mi)
        e.pinned = false
        cacheHits++
        topUp()
        return e
      }
      return await fetchEntry(mi, wantPhoto)
    } finally {
      clock('read', t)
    }
  }
  const fetchEntry = async (mi, wantPhoto, prefetch = false) => {
    let e = cache.get(mi)
    if (e && (!wantPhoto || e.hasPhoto) && !prefetch) cacheHits++
    if (!e) {
      const entry = { m: null, photo: null, hasPhoto: false, bytes: 0, next: Infinity, pinned: prefetch }
      e = entry
      cache.set(mi, e)
      e.mapLoad = loadMap(mi).then((m) => {
        mapLoads++
        entry.m = m
        entry.bytes = opts.mapsResident ? 0 : viewBytes(m)
        cached += entry.bytes
      })
      await e.mapLoad
    } else {
      if (prefetch) e.pinned = true
      if (!e.m) await e.mapLoad // a prefetch is reading it
    }
    if (wantPhoto && !e.hasPhoto) {
      e.hasPhoto = true // claimed before the await: a second request waits on the first
      e.photoLoad = loadImage ? loadPhoto(mi, e) : Promise.resolve(null)
      e.photo = await e.photoLoad
      if (e.photo) {
        photoLoads++
        const b = e.photo.data?.byteLength ?? 0
        e.bytes += b
        cached += b
      }
    } else if (wantPhoto && e.photoLoad) await e.photoLoad
    return e
  }
  let pos = 0
  total = (survey ? metas.length : 0) + sequence.length
  const visited = (mi, e) => {
    const p = pos++
    if (e) e.next = nextUse[p]
    else {
      const c = cache.get(mi)
      if (c) c.next = nextUse[p]
    }
    evict()
    tick()
  }

  // Window buffers, sized once for the largest window: one set per block of a group.
  const win0 = maxWindow(W, H, B, halo, align),
    maxCells = win0.ew * win0.eh
  const average = opts.blend === 'average'
  const groupSize = groups.reduce((n, g) => Math.max(n, g.length), 0)
  const states = Array.from({ length: groupSize }, () => ({
    buf: {
      data: new Float32Array(maxCells),
      mask: new Uint8Array(maxCells),
      rgba: new Uint8ClampedArray(maxCells * 4),
      scores: average || mosaic ? null : new Float64Array(maxCells),
      sums: average ? new Float64Array(maxCells * 4) : null,
      labels: newLabels(maxCells, opts, metas.length),
    },
    mb: mosaic
      ? {
          raw: new Uint16Array(maxCells),
          label: new Uint16Array(maxCells),
          tmp: new Uint16Array(maxCells),
          score: new Float64Array(maxCells),
          sums: new Float32Array(maxCells * 4),
          fallback: new Float32Array(maxCells * 3),
          flags: new Uint8Array(maxCells),
          dist: new Uint16Array(maxCells),
          pyr: multiband ? createMultiband(win0.ew, win0.eh, mode.levels) : null,
        }
      : null,
    // map index → its position in the block's map list, -1 for a map the block does not see
    slot: new Int32Array(metas.length).fill(-1),
  }))
  const labelled = !!states[0]?.buf.labels
  const stats = createOrthoStats(W, H, labelled)
  const scratch = { P: [0, 0, 0], px: new Float32Array(4), g: {} }
  let sampled = 0,
    covered = 0

  // `maxMaps`: the most maps one block sees, which the cache must hold for a block's
  // passes to read each map once; `groups` / `groupMaps`: the same for a group.
  const runBlocks = runGroups.reduce((n, gi) => n + groups[gi].length, 0)
  hooks.onBlocksStart?.(runBlocks, {
    maxMaps: blocks.reduce((n, b) => Math.max(n, b.maps.length), 0),
    groups: runGroups.length,
    groupSize: grouping.size,
    groupMaps: groupMaps.reduce((n, m) => Math.max(n, m.length), 0),
    cacheBytes,
  })
  // `opts.claims` (an Int32Array over shared memory, one slot per group): split over
  // workers, a group is taken by whichever worker claims it first, so a worker that is
  // done can take groups off a slower one's list. A group claimed elsewhere is skipped;
  // its visits are passed over in the plan, so the cache's view of what comes next stays
  // in step.
  const claims = opts.claims ?? null
  const ran = { groups: 0, blocks: 0, visits: 0 } // what this run did (not what others claimed)
  for (const [k, gi] of runGroups.entries()) {
    if (claims && Atomics.compareExchange(claims, gi, 0, 1) !== 0) {
      pos += groupMaps[k].length * passes
      continue
    }
    const group = groups[gi]
    ran.groups++
    ran.blocks += group.length
    ran.visits += group.reduce((n, bi) => n + blocks[bi].maps.length, 0)
    hooks.onGroup?.(gi, groups.length, group.length)
    // The group's blocks with a surface, each in its own window buffers.
    const active = []
    group.forEach((bi, si) => {
      const b = blocks[bi]
      if (b.empty) return
      const { ex0, ey0, ew, eh } = b,
        n = ew * eh,
        { buf } = states[si]
      const win = {
        x0: ex0,
        y0: ey0,
        w: ew,
        h: eh,
        data: buf.data.subarray(0, n),
        mask: buf.mask.subarray(0, n),
        rgba: buf.rgba.subarray(0, n * 4).fill(0),
        scores: buf.scores?.subarray(0, n).fill(Infinity) ?? null,
        sums: buf.sums?.subarray(0, n * 4).fill(0) ?? null,
        labels: buf.labels?.subarray(0, n).fill(NO_LABEL) ?? null,
      }
      sampleSurfaceWindow(surface, geom, ex0, ey0, ew, eh, win.data, win.mask)
      const st = states[si]
      b.maps.forEach((mi, j) => {
        st.slot[mi] = j
      })
      active.push({ b, win, n, st })
    })
    for (const a of active) winTiles(a.win, geom, gp)
    if (mosaic) {
      await mosaicGroup(active)
    } else {
      const union = unionMaps(active.map((a) => a.b))
      planPhotos(union)
      for (const mi of union) {
        const e = await fetch(mi, true)
        const t = performance.now()
        for (const a of active)
          if (a.st.slot[mi] >= 0) colourFromMap(a.win, geom, e.m, e.photo, mi, affine, toSfm, opts, scratch)
        clock('colour', t)
        visited(mi, e)
      }
    }
    // Finish and hand on every block of the group, in block order.
    for (const bi of group) {
      const b = blocks[bi],
        a = active.find((x) => x.b === b)
      const { col0, row0, bw, bh, ex0, ey0, ew, eh } = b
      const coreRgba = new Uint8ClampedArray(bw * bh * 4)
      const coreLabels = labelled ? new Uint16Array(bw * bh).fill(NO_LABEL) : null
      if (a) {
        const { win } = a
        const cx = col0 - ex0,
          cy = row0 - ey0
        const s0 = finishWindow(win, cx, cy, bw, bh)
        fillOrthoGaps(win.rgba, win.mask, ew, eh, fillRadius, fillMethod)
        const c = countColoured(win.rgba, ew, cx, cy, bw, bh)
        sampled += s0
        covered += c
        stats.add({
          rgba: win.rgba,
          labels: win.labels,
          x0: ex0,
          y0: ey0,
          w: ew,
          h: eh,
          cx0: col0,
          cy0: row0,
          cw: bw,
          ch: bh,
        })
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
    width: W,
    height: H,
    covered,
    sampled,
    filled: covered - sampled,
    surfaceCells,
    labelled,
    stats: stats.finish(),
    statsState: stats.state(),
    blocks: ran.blocks,
    groups: ran.groups,
    grouping: { size: grouping.size, groups: groups.length, cacheBytes, predicted: grouping.predicted ?? null },
    cacheShrinks: shrinks,
    cacheLimit,
    ...(survey ? { surveyFromMapRgb } : {}),
    visits: ran.visits,
    mapLoads,
    photoLoads,
    cacheHits,
    timings: Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(v)])),
    ...(mosaic
      ? {
          mosaic: {
            seamline: graphcut ? 'graphcut' : 'nadir',
            seamBlend: multiband ? 'multiband' : 'feather',
            seamCells,
            smoothPasses: graphcut ? 0 : MOSAIC_SMOOTH_PASSES,
            levels: multiband ? mode.levels : 0,
            seamCut: seams?.summary ?? null,
            balance: balance?.summary ?? null,
          },
        }
      : {}),
    // Where the graph-cut survey's time went (ms): map + photo reads, sampling, min cuts.
    ...(seams ? { seamCutMs: seams.ms } : {}),
    // Per image the R, G, B gains (3 per map, map order), for the caller's audit log.
    ...(balance ? { gains: balance.gains } : {}),
  }

  // The mosaic's passes over a group's block windows (see the section comment above):
  // each pass visits each map once, and every block that sees it takes its share.
  async function mosaicGroup(active) {
    for (const a of active) {
      const { win, n, st } = a,
        mbs = st.mb
      Object.assign(win, {
        raw: mbs.raw.subarray(0, n).fill(NO_LABEL),
        score: mbs.score.subarray(0, n).fill(Infinity),
        label: mbs.label.subarray(0, n),
        sums: null,
        msums: mbs.sums.subarray(0, n * 4).fill(0),
        fallback: mbs.fallback.subarray(0, n * 3),
        flags: mbs.flags.subarray(0, n).fill(0),
        dist: mbs.dist.subarray(0, n),
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
    const band = multiband ? 0 : seamCells,
      seam3 = 3 * band
    const gains = balance?.gains ?? null
    for (const a of active) {
      const { b, win, n, st } = a,
        { ew, eh } = b,
        k = b.maps.length
      if (seams) {
        // O5: the coarse graph-cut label of each cell; its pass-1 label where the coarse
        // cell has none, or names a map that sees nothing of this window (culled).
        const {
          labels: cut,
          grid: { f, cw },
        } = seams
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
      const own = new Int32Array(4 * k),
        fb = new Int32Array(4 * k)
      for (let j = 0; j < k; j++) {
        own.set([ew, eh, -1, -1], 4 * j)
        fb.set([ew, eh, -1, -1], 4 * j)
      }
      const grow = (arr, o, c, r) => {
        if (c < arr[o]) arr[o] = c
        if (r < arr[o + 1]) arr[o + 1] = r
        if (c > arr[o + 2]) arr[o + 2] = c
        if (r > arr[o + 3]) arr[o + 3] = r
      }
      for (let r = 0, i = 0; r < eh; r++)
        for (let c = 0; c < ew; c++, i++) {
          const l = win.label[i],
            rl = win.raw[i]
          if (l !== NO_LABEL) grow(own, 4 * st.slot[l], c, r)
          if (rl !== NO_LABEL && rl !== l) grow(fb, 4 * st.slot[rl], c, r)
        }
      a.own = own
      a.fb = fb
      a.step = { ...scratch, P: [0, 0, 0] }
      a.viewWin = { ...win, sums: win.msums }
    }
    // Pass 2: colour, descending (see passOrder). Each map's boxes first, so the photos
    // the pass will read are known (and load ahead).
    const colourVisits = []
    for (let u = union.length - 1; u >= 0; u--) {
      const mi = union[u]
      const boxes = []
      for (const a of active) {
        const j = a.st.slot[mi]
        if (j < 0) continue
        const o = 4 * j,
          { own, fb } = a,
          { ew, eh } = a.b
        const hasOwn = own[o + 2] >= 0,
          hasFb = fb[o + 2] >= 0
        if (!hasOwn && !hasFb) continue
        let x0 = ew,
          y0 = eh,
          x1 = 0,
          y1 = 0
        if (hasOwn) {
          x0 = Math.max(0, own[o] - band)
          y0 = Math.max(0, own[o + 1] - band)
          x1 = Math.min(ew, own[o + 2] + 1 + band)
          y1 = Math.min(eh, own[o + 3] + 1 + band)
        }
        if (hasFb) {
          x0 = Math.min(x0, fb[o])
          y0 = Math.min(y0, fb[o + 1])
          x1 = Math.max(x1, fb[o + 2] + 1)
          y1 = Math.max(y1, fb[o + 3] + 1)
        }
        boxes.push({ a, hasOwn, box: [x0, y0, x1, y1] })
      }
      colourVisits.push({ mi, boxes })
    }
    planPhotos(colourVisits.filter((v) => v.boxes.length).map((v) => v.mi))
    for (const { mi, boxes } of colourVisits) {
      if (!boxes.length) {
        visited(mi, null)
        continue
      }
      const e = await fetch(mi, true)
      const t = performance.now()
      for (const {
        a,
        hasOwn,
        box: [x0, y0, x1, y1],
      } of boxes) {
        const { win } = a,
          ew = a.b.ew
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
    const { ring, margin } = multibandReach(mode.levels),
      ring3 = 3 * ring
    for (const a of active) {
      const { b, win, n, st } = a,
        { ew, eh } = b
      const { mask, label, raw, msums, fallback, flags } = win
      // The effective label and its colour: the label where it saw the cell, else the
      // pass-1 fallback (as finishMosaicWindow), in linear light, gains applied.
      const eff = st.mb.tmp.subarray(0, n)
      for (let i = 0; i < n; i++) {
        const f = flags[i],
          o = 4 * i
        eff[i] = NO_LABEL
        if (!mask[i]) continue
        if (f & 1) eff[i] = label[i]
        else if (f & 2) {
          eff[i] = raw[i]
          msums[o] = fallback[3 * i]
          msums[o + 1] = fallback[3 * i + 1]
          msums[o + 2] = fallback[3 * i + 2]
        }
      }
      const t = performance.now()
      multibandBegin(st.mb.pyr, ew, eh, eff, NO_LABEL)
      clock('pyramid', t)
      const k = b.maps.length,
        box = new Int32Array(4 * k)
      for (let j = 0; j < k; j++) box.set([ew, eh, -1, -1], 4 * j)
      for (let r = 0, i = 0; r < eh; r++)
        for (let c = 0; c < ew; c++, i++) {
          const l = eff[i]
          if (l === NO_LABEL) continue
          const o = 4 * st.slot[l]
          if (c < box[o]) box[o] = c
          if (r < box[o + 1]) box[o + 1] = r
          if (c > box[o + 2]) box[o + 2] = c
          if (r > box[o + 3]) box[o + 3] = r
        }
      a.eff = eff
      a.mbox = box
    }
    const { depthTolRel = 0.02, maxCost = Infinity } = opts
    const usersOf = union.map((mi) => active.filter((a) => a.st.slot[mi] >= 0 && a.mbox[4 * a.st.slot[mi] + 2] >= 0))
    planPhotos(union.filter((_, u) => usersOf[u].length))
    for (const [u, mi] of union.entries()) {
      const users = usersOf[u]
      if (!users.length) {
        visited(mi, null)
        continue
      }
      const e = await fetch(mi, true),
        m = e.m,
        see = mapSight(m, gp.up, depthTolRel, maxCost)
      const g0 = gains ? gains[mi * 3] : 1,
        g1 = gains ? gains[mi * 3 + 1] : 1,
        g2 = gains ? gains[mi * 3 + 2] : 1
      for (const a of users) {
        const { b, win, eff, mbox, st, step } = a,
          { ew, eh } = b,
          o = 4 * st.slot[mi]
        const { P, g, px } = step
        const { msums } = win
        // The box on the window's pyramid lattice (the window's origin is on the grid's).
        const x0 = Math.max(0, Math.floor((mbox[o] - margin) / align) * align),
          y0 = Math.max(0, Math.floor((mbox[o + 1] - margin) / align) * align)
        const x1 = Math.min(ew, mbox[o + 2] + 1 + margin),
          y1 = Math.min(eh, mbox[o + 3] + 1 + margin)
        const bw = x1 - x0,
          bh = y1 - y0
        let t = performance.now()
        chamferTo(eff, ew, x0, y0, x1, y1, mi, win.dist)
        const d = win.fallback // free now: the box's colour differences, 3 per cell
        d.fill(0, 0, 3 * bw * bh)
        forTilesReaching(win, geom, m, gp.affine, x0, y0, x1, y1, (c0, r0, c1, r1) => {
          for (let wr = r0; wr < r1; wr++)
            for (let wc = c0; wc < c1; wc++) {
              const wi = wr * ew + wc,
                dd = win.dist[wi]
              if (dd === 0 || dd > ring3 || eff[wi] === NO_LABEL) continue
              winCellToSfm(win, geom, gp, toSfm, wc, wr, win.data[wi], P)
              if (!see(P, g) || !sampleColour(m, e.photo, g, px)) continue
              const q = 3 * ((wr - y0) * bw + wc - x0),
                wo = 4 * wi
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
        const l = eff[i],
          o = 4 * i
        labels[i] = l
        if (l === NO_LABEL) continue
        rgba[o] = linearToSrgb(msums[o])
        rgba[o + 1] = linearToSrgb(msums[o + 1])
        rgba[o + 2] = linearToSrgb(msums[o + 2])
        rgba[o + 3] = 255
      }
    }
  }
}

// The split's time model (opts.planShares), measured on quarry-347 at long side 12,000
// (2026-10-21, six workers): a map visit's work (labels, colour, seams; a 2048² block)
// ~0.17 s, and a unit of predicted reads (a map read 1, a photo decode 3) ~0.08 s.
const ORTHO_VISIT_S = 0.17,
  ORTHO_READ_S = 0.08
