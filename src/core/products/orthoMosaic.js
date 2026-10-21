// The orthophoto mosaic (blend 'mosaic', plan-ortho-mosaic O2–O5): per-cell labels by
// geometry, majority smoothing, gains, feathering and the seam survey. ortho.js
// orthorectifyTiled drives these per block. Pure: no Vue/Pinia/OPFS/DOM.
import { srgbToLinear, linearToSrgb, fitGains, gainSampleClipped, growable } from './colourGains.js'
import { sampleSurfaceWindow } from './surface.js'
import { seamGrid, seamSampleCol, createSeamSurvey, addSeamCandidate, solveSeams, SEAM_CUT_CELLS } from './seamCut.js'
import { MULTIBAND_LEVELS, multibandReach } from './multiband.js'
import {
  NO_LABEL,
  WIN_TILE,
  boxReachesMap,
  cameraCentre,
  cellToSfm,
  forTilesReaching,
  samplePhoto,
  winCellToSfm,
} from './orthoWindow.js'

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
export function orthoHalo({
  width,
  height,
  blend = 'best',
  fillRadius = 2,
  seamWidth = 0,
  seamline = 'nadir',
  seamBlend = 'feather',
  blendLevels = MULTIBAND_LEVELS,
}) {
  const fill = Math.max(0, Math.floor(fillRadius)) + 1
  if (blend !== 'mosaic') return fill
  const band = seamBlend === 'multiband' ? multibandReach(blendLevels).halo : mosaicSeamCells(width, height, seamWidth)
  return fill + band + (seamline === 'graphcut' ? 0 : MOSAIC_SMOOTH_PASSES)
}

// A mosaic's seam options, resolved (core defaults: the O2–O4a nearest-nadir partition
// with feathering; the app's defaults are in defaults.user.js ORTHO_DEFAULTS).
export function mosaicMode(opts) {
  const mosaic = opts.blend === 'mosaic'
  const graphcut = mosaic && opts.seamline === 'graphcut',
    multiband = mosaic && opts.seamBlend === 'multiband'
  const levels = opts.blendLevels ?? MULTIBAND_LEVELS
  return { mosaic, graphcut, multiband, levels, align: multiband ? 1 << levels : 1 }
}

// The visibility test every mosaic pass shares: P in front of map m, on a map pixel
// whose stored depth agrees (z-buffer), within the cost gate, and seen from above the
// surface (the ray to the camera centre leans less than 90° from `up`).
// mapSight(m, up, tol, maxCost) → see(P, g): fills g = { u, v, i, depth, cos } and
// returns whether P is visible. The map's constants are read once, not per cell.
//
// A pixel without depth says nothing: the cross-view filter removes weakly matched
// pixels (a uniform roof, foliage), so a depth map is full of small holes, and a photo
// would "not see" scattered cells of its own region — each one then taken from another
// photo, a speckle of seams (on quarry-80 the nadir labels switched 21 times per 100
// cells, mostly so). Inside such a hole the nearest depth within MOSAIC_HOLE_REACH
// map pixels that agrees stands in. Where the stored depth is nearer, something
// occludes the point: that is never overridden.
export const MOSAIC_HOLE_REACH = 2

export function mapSight(m, up, tol, maxCost) {
  const { R, t: tr, K, width: mw, height: mh, depth, cost } = m
  const r00 = R[0][0],
    r01 = R[0][1],
    r02 = R[0][2],
    r10 = R[1][0],
    r11 = R[1][1],
    r12 = R[1][2]
  const r20 = R[2][0],
    r21 = R[2][1],
    r22 = R[2][2],
    t0 = tr[0],
    t1 = tr[1],
    t2 = tr[2]
  const kfx = K.fx,
    kfy = K.fy,
    kcx = K.cx,
    kcy = K.cy
  const [up0, up1, up2] = up,
    [c0x, c0y, c0z] = cameraCentre(m)
  return (P, g) => {
    const p0 = P[0],
      p1 = P[1],
      p2 = P[2]
    const zc = r20 * p0 + r21 * p1 + r22 * p2 + t2
    if (!(zc > 1e-9)) return false
    const u = kfx * ((r00 * p0 + r01 * p1 + r02 * p2 + t0) / zc) + kcx
    const v = kfy * ((r10 * p0 + r11 * p1 + r12 * p2 + t1) / zc) + kcy
    const ui = Math.round(u),
      vi = Math.round(v)
    if (ui < 0 || vi < 0 || ui >= mw || vi >= mh) return false
    let i = vi * mw + ui
    const stored = depth[i]
    if (stored > 0) {
      if (Math.abs(stored - zc) > tol * zc) return false
    } else {
      i = holeMatch(m, ui, vi, zc, tol)
      if (i < 0) return false
    }
    if (cost && cost[i] > maxCost) return false
    const dx = c0x - p0,
      dy = c0y - p1,
      dz = c0z - p2
    const cos = (up0 * dx + up1 * dy + up2 * dz) / Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (!(cos > 1e-3)) return false
    g.u = u
    g.v = v
    g.i = i
    g.depth = zc
    g.cos = cos
    return true
  }
}

// A hole in map m at (ui, vi): the agreeing depth nearest to it, rings outwards, first in
// row order → its index, or −1.
function holeMatch(m, ui, vi, zc, tol) {
  for (let rr = 1; rr <= MOSAIC_HOLE_REACH; rr++) {
    for (let dv = -rr; dv <= rr; dv++)
      for (let du = -rr; du <= rr; du++) {
        if (Math.max(Math.abs(du), Math.abs(dv)) !== rr) continue
        const uu = ui + du,
          vv = vi + dv
        if (uu < 0 || vv < 0 || uu >= m.width || vv >= m.height) continue
        const j = vv * m.width + uu,
          sj = m.depth[j]
        if (sj > 0 && Math.abs(sj - zc) <= tol * zc) return j
      }
  }
  return -1
}

// The colour of a visible sample: bilinear from the source photo (O1), else nearest
// from the map's own rgb plane. False when the photo does not cover the point.
export function sampleColour(m, photo, g, px) {
  if (photo) {
    const q = photo.map ? photo.map(g.u, g.v) : { x: g.u, y: g.v }
    if (!(q.x >= -0.5 && q.y >= -0.5 && q.x <= photo.width - 0.5 && q.y <= photo.height - 0.5)) return false
    samplePhoto(photo, q.x, q.y, px)
    return true
  }
  const c3 = g.i * 3
  px[0] = m.rgb[c3]
  px[1] = m.rgb[c3 + 1]
  px[2] = m.rgb[c3 + 2]
  return true
}

// O2 pass 1: label each cell of the window with map mi where it has the finest
// foreshortened footprint so far (ties keep the lower index: maps arrive ascending).
export function labelFromMap(win, grid, m, mi, gp, toSfm, opts, scratch) {
  const { x0, y0, w, data, mask, raw, score } = win
  const { depthTolRel = 0.02, maxCost = Infinity } = opts
  const C = cameraCentre(m),
    fx = m.K.fx
  // mapSight and cellToSfm written out for the cells of a tile: the label pass is the
  // ortho's largest (a third of a fine one's time) and the calls cost more than their
  // work. The same expressions in the same order, so the same bits.
  const { R, t: tr, K, width: mw, height: mh, depth, cost } = m
  const r00 = R[0][0],
    r01 = R[0][1],
    r02 = R[0][2],
    r10 = R[1][0],
    r11 = R[1][1],
    r12 = R[1][2]
  const r20 = R[2][0],
    r21 = R[2][1],
    r22 = R[2][2],
    t0 = tr[0],
    t1 = tr[1],
    t2 = tr[2]
  const kfx = K.fx,
    kfy = K.fy,
    kcx = K.cx,
    kcy = K.cy
  const [up0, up1, up2] = gp.up,
    [c0x, c0y, c0z] = C
  const { gsd, originX, originY } = grid
  const tiles = win.tiles
  forTilesReaching(win, grid, m, gp.affine, 0, 0, w, win.h, (tc0, tr0, tc1, tr1) => {
    const aff = gp.affine ?? tiles.cellAff?.[Math.floor(tr0 / WIN_TILE) * tiles.nx + Math.floor(tc0 / WIN_TILE)] ?? null
    for (let r = tr0; r < tr1; r++)
      for (let c = tc0; c < tc1; c++) {
        const idx = r * w + c
        if (!mask[idx]) continue
        const x = originX + (x0 + c + 0.5) * gsd,
          y = originY - (y0 + r + 0.5) * gsd,
          z = data[idx]
        let p0, p1, p2
        if (aff) {
          const { c0, P0, A } = aff,
            dx = x - c0[0],
            dy = y - c0[1],
            dz = z - c0[2]
          p0 = P0[0] + A[0] * dx + A[1] * dy + A[2] * dz
          p1 = P0[1] + A[3] * dx + A[4] * dy + A[5] * dz
          p2 = P0[2] + A[6] * dx + A[7] * dy + A[8] * dz
        } else {
          const q = toSfm([x, y, z])
          p0 = q[0]
          p1 = q[1]
          p2 = q[2]
        }
        const zc = r20 * p0 + r21 * p1 + r22 * p2 + t2
        if (!(zc > 1e-9)) continue
        const u = kfx * ((r00 * p0 + r01 * p1 + r02 * p2 + t0) / zc) + kcx
        const v = kfy * ((r10 * p0 + r11 * p1 + r12 * p2 + t1) / zc) + kcy
        const ui = Math.round(u),
          vi = Math.round(v)
        if (ui < 0 || vi < 0 || ui >= mw || vi >= mh) continue
        let i = vi * mw + ui
        const stored = depth[i]
        if (stored > 0) {
          if (Math.abs(stored - zc) > depthTolRel * zc) continue
        } else {
          i = holeMatch(m, ui, vi, zc, depthTolRel)
          if (i < 0) continue
        }
        if (cost && cost[i] > maxCost) continue
        const dx = c0x - p0,
          dy = c0y - p1,
          dz = c0z - p2
        const cos = (up0 * dx + up1 * dy + up2 * dz) / Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (!(cos > 1e-3)) continue
        const sc = zc / (fx * cos * cos)
        if (sc < score[idx]) {
          score[idx] = sc
          raw[idx] = mi
        }
      }
  })
}

// One 3×3 majority pass over a label plane: a cell takes the label most of its
// labelled 3×3 neighbourhood carries; it keeps its own on a tie, else the lowest of
// the tied labels. Unlabelled cells stay unlabelled and do not vote.
function majority3(src, dst, w, h) {
  const lab = new Int32Array(9),
    cnt = new Int32Array(9)
  for (let r = 0; r < h; r++) {
    const r0 = Math.max(0, r - 1),
      r1 = Math.min(h - 1, r + 1)
    for (let c = 0; c < w; c++) {
      const i = r * w + c,
        s = src[i]
      if (s === NO_LABEL) {
        dst[i] = NO_LABEL
        continue
      }
      const c0 = Math.max(0, c - 1),
        c1 = Math.min(w - 1, c + 1)
      let uniform = true
      for (let rr = r0; rr <= r1 && uniform; rr++)
        for (let cc = c0; cc <= c1; cc++) {
          const v = src[rr * w + cc]
          if (v !== s && v !== NO_LABEL) {
            uniform = false
            break
          }
        }
      if (uniform) {
        dst[i] = s
        continue
      }
      let k = 0
      for (let rr = r0; rr <= r1; rr++)
        for (let cc = c0; cc <= c1; cc++) {
          const v = src[rr * w + cc]
          if (v === NO_LABEL) continue
          let j = 0
          while (j < k && lab[j] !== v) j++
          if (j === k) {
            lab[k] = v
            cnt[k++] = 1
          } else cnt[j]++
        }
      let maxN = 0,
        own = 0
      for (let j = 0; j < k; j++) {
        if (cnt[j] > maxN) maxN = cnt[j]
        if (lab[j] === s) own = cnt[j]
      }
      let out = s
      if (own < maxN) {
        out = NO_LABEL
        for (let j = 0; j < k; j++) if (cnt[j] === maxN && lab[j] < out) out = lab[j]
      }
      dst[i] = out
    }
  }
}

// `passes` majority passes from src into dst; src (the raw labels) is left intact.
export function smoothLabels(src, dst, tmp, w, h, passes = MOSAIC_SMOOTH_PASSES) {
  if (passes <= 0) {
    dst.set(src.subarray(0, w * h))
    return dst
  }
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
  for (let r = y0; r < y1; r++)
    for (let c = x0; c < x1; c++) {
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
  for (let r = y1 - 1; r >= y0; r--)
    for (let c = x1 - 1; c >= x0; c--) {
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
export function blendFromMap(win, grid, m, photo, mi, gp, toSfm, opts, scratch, box, seam3, gains) {
  const { x0, y0, w, data, mask, raw, label, dist, sums, fallback, flags } = win
  const { depthTolRel = 0.02, maxCost = Infinity } = opts
  const { P, g, px } = scratch,
    see = mapSight(m, gp.up, depthTolRel, maxCost)
  const g0 = gains ? gains[mi * 3] : 1,
    g1 = gains ? gains[mi * 3 + 1] : 1,
    g2 = gains ? gains[mi * 3 + 2] : 1
  const [bx0, by0, bx1, by1] = box
  for (let r = by0; r < by1; r++)
    for (let c = bx0; c < bx1; c++) {
      const idx = r * w + c
      if (!mask[idx]) continue
      const own = label[idx] === mi
      const d = seam3 ? dist[idx] : own ? 0 : 0xffff
      const inBand = d === 0 || d < seam3
      const isFallback = !own && raw[idx] === mi
      if (!inBand && !isFallback) continue
      winCellToSfm(win, grid, gp, toSfm, c, r, data[idx], P)
      if (!see(P, g)) continue
      if (!sampleColour(m, photo, g, px)) continue
      const l0 = g0 * srgbToLinear(px[0]),
        l1 = g1 * srgbToLinear(px[1]),
        l2 = g2 * srgbToLinear(px[2])
      if (inBand) {
        const wt = d === 0 ? 1 : (seam3 - d) / seam3,
          o = idx * 4
        sums[o] += wt * l0
        sums[o + 1] += wt * l1
        sums[o + 2] += wt * l2
        sums[o + 3] += wt
        if (own) flags[idx] |= 1
      }
      if (isFallback) {
        const o = idx * 3
        fallback[o] = l0
        fallback[o + 1] = l1
        fallback[o + 2] = l2
        flags[idx] |= 2
      }
    }
}

// Resolve a mosaic window: weighted means back to sRGB, and the output label — the
// smoothed label where it coloured its own cell, the pass-1 label where that stood in,
// NO_LABEL where only neighbours' seam bands reached the cell (or nothing did).
export function finishMosaicWindow(win) {
  const { w, h, mask, raw, label, sums, fallback, flags, rgba, labels } = win
  for (let i = 0, n = w * h; i < n; i++) {
    labels[i] = NO_LABEL
    if (!mask[i]) continue
    const o = i * 4,
      f = flags[i]
    let s0 = sums[o],
      s1 = sums[o + 1],
      s2 = sums[o + 2],
      s3 = sums[o + 3]
    if (!(f & 1) && f & 2) {
      s0 += fallback[i * 3]
      s1 += fallback[i * 3 + 1]
      s2 += fallback[i * 3 + 2]
      s3 += 1
    }
    if (!(s3 > 0)) continue
    rgba[o] = linearToSrgb(s0 / s3)
    rgba[o + 1] = linearToSrgb(s1 / s3)
    rgba[o + 2] = linearToSrgb(s2 / s3)
    rgba[o + 3] = 255
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

export async function mosaicSurvey(surface, geom, metas, loadMap, loadImage, toSfm, gp, opts, tick, { gainsOn, cut }) {
  const { width: W, height: H } = geom,
    n = metas.length
  const { depthTolRel = 0.02, maxCost = Infinity } = opts
  const k = Math.max(4, Math.ceil(Math.sqrt((W * H) / GAIN_LATTICE_CELLS)))
  const pts = growable(Float64Array)
  const rowData = new Float32Array(W),
    rowMask = new Uint8Array(W),
    P = [0, 0, 0]
  if (gainsOn) {
    for (let row = k >> 1; row < H; row += k) {
      sampleSurfaceWindow(surface, geom, 0, row, W, 1, rowData, rowMask)
      for (let col = k >> 1; col < W; col += k) {
        if (!rowMask[col]) continue
        cellToSfm(geom, gp.affine, toSfm, col, row, rowData[col], P)
        pts.push(P[0])
        pts.push(P[1])
        pts.push(P[2])
      }
    }
  }
  const L = pts.length / 3,
    xyz = pts.array
  // The seam grid: each coarse cell's height at its sample cell, and per tile the
  // height range and frame box for the cull.
  let sg = null,
    sv = null,
    cz = null,
    cm = null,
    tiles = null
  if (cut) {
    sg = seamGrid(W, H, opts.seamCutCells ?? SEAM_CUT_CELLS)
    sv = createSeamSurvey(sg)
    const { cw, ch } = sg
    cz = new Float32Array(cw * ch)
    cm = new Uint8Array(cw * ch)
    for (let j = 0; j < ch; j++) {
      sampleSurfaceWindow(surface, geom, 0, seamSampleCol(sg, j, H), W, 1, rowData, rowMask)
      for (let i = 0; i < cw; i++) {
        const col = seamSampleCol(sg, i, W)
        if (rowMask[col]) {
          cz[j * cw + i] = rowData[col]
          cm[j * cw + i] = 1
        }
      }
    }
    const tx = Math.ceil(cw / SURVEY_TILE),
      ty = Math.ceil(ch / SURVEY_TILE)
    tiles = []
    for (let b = 0; b < ty; b++)
      for (let a = 0; a < tx; a++) {
        const i0 = a * SURVEY_TILE,
          j0 = b * SURVEY_TILE,
          i1 = Math.min(cw, i0 + SURVEY_TILE),
          j1 = Math.min(ch, j0 + SURVEY_TILE)
        let lo = Infinity,
          hi = -Infinity
        for (let j = j0; j < j1; j++)
          for (let i = i0; i < i1; i++) {
            const p = j * cw + i
            if (cm[p]) {
              if (cz[p] < lo) lo = cz[p]
              if (cz[p] > hi) hi = cz[p]
            }
          }
        if (!(lo <= hi)) continue
        const c0 = seamSampleCol(sg, i0, W),
          c1 = seamSampleCol(sg, i1 - 1, W)
        const r0 = seamSampleCol(sg, j0, H),
          r1 = seamSampleCol(sg, j1 - 1, H)
        const box = [
          geom.originX + (c0 + 0.5) * geom.gsd,
          geom.originX + (c1 + 0.5) * geom.gsd,
          geom.originY - (r1 + 0.5) * geom.gsd,
          geom.originY - (r0 + 0.5) * geom.gsd,
          lo,
          hi,
        ]
        tiles.push({ i0, j0, i1, j1, box, near: gp.local(box) })
      }
  }
  const obsPt = growable(Int32Array),
    obsImg = growable(Int32Array),
    obsRgb = growable(Float32Array)
  const g = {},
    px = new Float32Array(4)
  let clippedObs = 0,
    readMs = 0,
    fromMapRgb = 0
  const t0 = performance.now()
  // Photo decode: ~2 px per step of the finer of the two samplings.
  const stepCells = Math.min(gainsOn ? k : Infinity, cut ? sg.f : Infinity)
  // Each map with its photo where one is needed, `opts.photoPrefetch` maps ahead (the
  // decodes overlap, as in the block passes).
  const ahead = Math.max(0, opts.photoPrefetch ?? 0)
  const loads = new Map()
  const startLoad = (i) => {
    if (i >= n || loads.has(i)) return
    loads.set(
      i,
      (async () => {
        const m = await loadMap(i)
        const per = gp.mapPxPerCell(m)
        // The map's own colour plane is its photo resampled to the depth map's scale. Where a
        // survey step spans ≥ 2 map px, that is as fine as the decode would be (≈ 2 photo px
        // per step), so the photo is not decoded at all: on quarry-347 the survey decoded
        // every photo at ~8 % of native, ~0.3 s each, for colour the map already had at 25 %.
        const ownColour = !!m.rgb && per > 0 && per * stepCells >= 2
        const photo = loadImage && !ownColour ? await loadImage(i, m, per > 0 ? per * stepCells : null) : null
        return { m, ownColour, photo }
      })(),
    )
  }
  for (let mi = 0; mi < n; mi++) {
    const tr = performance.now()
    for (let j = mi; j <= mi + ahead; j++) startLoad(j)
    const { m, ownColour, photo } = await loads.get(mi)
    loads.delete(mi)
    if (ownColour) fromMapRgb++
    readMs += performance.now() - tr
    const see = mapSight(m, gp.up, depthTolRel, maxCost)
    for (let p = 0; p < L; p++) {
      P[0] = xyz[3 * p]
      P[1] = xyz[3 * p + 1]
      P[2] = xyz[3 * p + 2]
      if (!see(P, g) || !sampleColour(m, photo, g, px)) continue
      if (gainSampleClipped(px[0], px[1], px[2])) {
        clippedObs++
        continue
      }
      obsPt.push(p)
      obsImg.push(mi)
      obsRgb.push(srgbToLinear(px[0]))
      obsRgb.push(srgbToLinear(px[1]))
      obsRgb.push(srgbToLinear(px[2]))
    }
    if (cut) {
      const { cw } = sg,
        fx = m.K.fx
      for (const t of tiles) {
        if (!boxReachesMap(m, t.near, t.near.box)) continue
        for (let j = t.j0; j < t.j1; j++) {
          const row = seamSampleCol(sg, j, H)
          for (let i = t.i0; i < t.i1; i++) {
            const p = j * cw + i
            if (!cm[p]) continue
            cellToSfm(geom, gp.affine, toSfm, seamSampleCol(sg, i, W), row, cz[p], P)
            if (!see(P, g) || !sampleColour(m, photo, g, px)) continue
            addSeamCandidate(
              sv,
              p,
              mi,
              g.depth / (fx * g.cos * g.cos),
              Math.round(px[0]),
              Math.round(px[1]),
              Math.round(px[2]),
            )
          }
        }
      }
    }
    tick()
  }
  let balance = null
  if (gainsOn) {
    const { gains, summary } = fitGains({
      nImages: n,
      nPoints: L,
      obsPt: obsPt.array,
      obsImg: obsImg.array,
      obsRgb: obsRgb.array,
    })
    balance = { gains, summary: { latticeStep: k, latticeCells: L, clippedObservations: clippedObs, ...summary } }
  }
  const t1 = performance.now()
  let seams = null
  if (cut) {
    const res = solveSeams(sv, balance?.gains ?? null, opts.seamCutWeights)
    // Where the time went: reading maps + decoding photos, sampling, the min cuts.
    seams = {
      ...res,
      grid: sg,
      ms: { read: Math.round(readMs), sample: Math.round(t1 - t0 - readMs), solve: Math.round(performance.now() - t1) },
    }
  }
  return { balance, seams, fromMapRgb }
}
