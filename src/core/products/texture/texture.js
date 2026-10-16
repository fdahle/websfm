// Texture a mesh from the registered photos (dev/planning/plan-texture.md). Pure: no
// Vue, Pinia, OPFS, DOM or WASM; photos and masks come in through hooks.
//
//   1 visibility   faceCandidates — per-view z-buffer of the mesh, best views per face
//   2 selection    selectViews    — one view per face, Potts-smoothed (loopy BP)
//   3 charts       buildCharts    — connected same-view faces; UVs = their projection
//   4 packing      chartPieces + packAtlas at a texel scale lowered until it fits
//   5 bake         bakeAtlas      — each photo decoded once, every texel sampled
//   6 levelling    fitGains / applyGains — per-image gains in linear light
//   7 output       split vertices (one copy per piece a vertex is in), faces by page
//
// Faces no view sees take a flat colour (their mean vertex colour, else grey) from a
// small palette of cells, so the result is fully textured either way.

import { TEXTURE_DEFAULTS } from '../../defaults.user.js'
import { TEXTURE_TUNING } from '../../tuning.js'
import { toScaledPx } from '../../sfm/geometry.js'
import { fitGains, gainSampleClipped, growable, srgbToLinear } from '../colourGains.js'
import { sampleRgbaBilinear } from '../undistort.js'
import { faceAdjacency } from './meshGraph.js'
import { weldVertices } from '../meshEdit.js'
import { meshGeometry, faceCandidates, localCamera } from './visibility.js'
import { selectViews, mergeSmallCharts } from './labeling.js'
import { buildCharts, cornerPixels, chartPieces } from './charts.js'
import { packAtlas } from './packing.js'
import { bakeAtlas, applyGains } from './bake.js'
import { levelSeams } from './seamLevel.js'

const MIN_SCALE = 1 / 64

// mesh = { pos (Float32/64 3V), idx (Uint32 3F), col? (Uint8 3V) }
// views = [{ R, t, K, width, height, rect?, weight? }] (visibility.js conventions)
// hooks = { loadPhoto(vi, scale) (bake.js), validLut?, renderDepth? (visibility.js),
//           onLog?(msg, level), onProgress?(fraction, stage) }
// → { pos, idx, uv, col, nVerts, count, groups: [{ page, start, count }],
//     pages: [{ width, height, data }], summary }
export async function textureMesh(mesh, views, opts = {}, hooks = {}) {
  const o = { ...TEXTURE_TUNING, ...TEXTURE_DEFAULTS, ...opts }
  const log = (m, level = 'info') => hooks.onLog?.(m, level)
  const progress = (f, stage) => hooks.onProgress?.(f, stage)
  if (!views.length) throw new Error('No registered cameras to texture from')
  if (views.length >= 0xffff) throw new Error(`Too many views (${views.length}); the limit is 65,534`)

  mesh = weldIfOpen(mesh, o.weldOpenShare, log)
  const { pos, idx, col = null } = mesh

  // 1 · Visibility.
  const geom = meshGeometry(pos, idx)
  const F = geom.nFaces
  const cand = await faceCandidates(geom, idx, views, o, {
    validLut: hooks.validLut, renderDepth: hooks.renderDepth,
    onProgress: (d, t) => progress(0.55 * d / t, 'visibility'),
  })
  let seenFaces = 0
  for (let f = 0; f < F; f++) if (cand.count[f]) seenFaces++
  if (!seenFaces) throw new Error('No registered photo sees this mesh: is it in the model frame of the cameras?')
  log(`Texture: ${seenFaces.toLocaleString()} of ${F.toLocaleString()} faces seen by at least one of ${views.length} views`
    + ` (z-buffer ≤ ${o.bufferSide} px, faces within ${Math.round(Math.acos(o.minCos) * 180 / Math.PI)}° of facing)`
    + (cand.fallbackFaces ? `, ${cand.fallbackFaces.toLocaleString()} of them only partly (textured from the view that hides least of them)` : '') + '; '
    + (cand.orientation === 0 ? 'mesh winding is inconsistent, so both sides of each face count'
      : `mesh faces point ${cand.orientation > 0 ? 'outward' : 'inward'} (back faces dropped)`),
  seenFaces < 0.5 * F ? 'warn' : 'info')

  // 2 · View selection.
  const { adj, rev } = faceAdjacency(idx, geom.nVerts)
  const labels = selectViews(cand, adj, rev, { smoothness: o.smoothness, iterations: o.bpIterations, damping: o.bpDamping })
  const merged = o.minChartFaces > 1 ? mergeSmallCharts(labels, adj, cand, { minFaces: o.minChartFaces }) : 0
  progress(0.6, 'selection')

  // 3 · Charts, and the flat palette for unseen faces.
  const charts = buildCharts(labels, adj)
  const px = cornerPixels(geom, idx, labels, views)
  const flat = paletteCells(labels, idx, col, o)

  // 4 · Scale and packing.
  let s = o.maxScale, cut, pack
  for (;;) {
    cut = chartPieces(charts, px, s, { pageSize: o.pageSize, padding: o.padding, minFill: o.minFill, minSplitTexels: o.minSplitTexels })
    if (!cut.tooBig) {
      const n = cut.pieces.count + flat.count
      const w = new Int32Array(n), h = new Int32Array(n)
      w.set(cut.pieces.w); h.set(cut.pieces.h)
      w.fill(flat.size, cut.pieces.count); h.fill(flat.size, cut.pieces.count)
      pack = packAtlas(w, h, o.pageSize)
      if (pack.nPages <= o.maxPages) break
      s *= Math.min(0.95, Math.sqrt(o.maxPages / pack.nPages) * 0.98)
    } else s *= 0.8
    if (s < MIN_SCALE) {
      throw new Error(`The texture does not fit ${o.maxPages} pages of ${o.pageSize} px even at 1/64 of photo resolution; `
        + 'allow more pages, or decimate the mesh first')
    }
  }
  const { pieces } = cut
  let used = 0
  for (let p = 0; p < pieces.count; p++) used += pieces.w[p] * pieces.h[p]
  used += flat.count * flat.size * flat.size
  const pageArea = pack.pageHeights.reduce((a, h) => a + h * o.pageSize, 0)
  if (o.unseen === 'remove' && flat.faces) log(`Texture: ${flat.faces.toLocaleString()} faces no photo sees are left out of the textured mesh`)
  log(`Texture: ${charts.nCharts.toLocaleString()} charts`
    + (merged ? ` (${merged.toLocaleString()} faces of charts under ${o.minChartFaces} faces moved to a neighbour's photo)` : '')
    + ` in ${pieces.count.toLocaleString()} pieces`
    + (flat.count ? ` + ${flat.count} flat colour cells for ${flat.faces.toLocaleString()} unseen faces` : '')
    + ` on ${pack.nPages} page${pack.nPages === 1 ? '' : 's'} of ${o.pageSize} px, ${(100 * used / pageArea).toFixed(0)} % filled; `
    + `texel = ${s >= 0.995 ? 'native photo pixel' : `${(1 / s).toFixed(2)} photo pixels`}`
    + (s < o.maxScale ? ` (lowered from ${o.maxScale === 1 ? 'native' : o.maxScale} to fit ${o.maxPages} pages)` : ''))

  // 5 · Bake, collecting colour-levelling samples from each photo while it is loaded.
  const layout = { pageSize: o.pageSize, pageHeights: pack.pageHeights, scale: s, pieces, place: pack, flat }
  const levelling = o.levelColours ? gainSampler(geom, idx, cand, views, s, o.gainSamples) : null
  const baked = await bakeAtlas(layout, {
    loadPhoto: hooks.loadPhoto,
    onPhoto: levelling?.sample,
    onProgress: (d, t) => progress(0.6 + 0.35 * d / t, 'bake'),
  }, o.grayFallback)
  if (baked.failed.length) log(`Texture: ${baked.failed.length} photo(s) could not be read; their charts are grey`, 'warn')

  // 6 · Colour levelling.
  let gainSummary = null
  if (levelling) {
    const { gains, summary } = levelling.fit()
    applyGains(baked.pages, layout, gains)
    gainSummary = summary
    log(summary.images
      ? `Texture: colour levelling over ${summary.images} photos from ${summary.observations.toLocaleString()} samples; `
        + `gain median ${summary.median.toFixed(3)}, range ${summary.min.toFixed(3)}–${summary.max.toFixed(3)}`
        + (summary.clamped ? `, ${summary.clamped} channel(s) clamped` : '')
        + (summary.rejected ? `; ${summary.rejected.toLocaleString()} samples left out as inconsistent between photos` : '')
      : 'Texture: colour levelling skipped (no face seen by two decoded photos)')
  }

  // Seam levelling: smooth per-chart offsets so the sides of every seam meet.
  let seamLevel = null
  if (o.levelColours && o.seamLevelling) {
    const t0 = Date.now()
    seamLevel = levelSeams(labels, idx, geom.nVerts, cut, px, layout, baked.pages,
      { smoothWeight: o.seamSmoothWeight, delta: o.seamDelta, chromaWeight: o.seamChromaWeight, maxOffset: o.seamMaxOffset, padding: o.padding })
    log(`Texture: seam levelling over ${seamLevel.seamVertices.toLocaleString()} seam vertices `
      + `(${seamLevel.unknowns.toLocaleString()} offsets, ${seamLevel.iterations} CG iterations, `
      + `largest offset ${seamLevel.maxOffset.toFixed(0)} levels) in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  }

  // Quality figure: the colour step across seams, in the finished atlas.
  const seams = seamStats(adj, labels, idx, cut, px, layout, baked.pages)
  log(`Texture: seams ${seams.seams.toLocaleString()} edges between photos, mean colour step `
    + `${seams.step.toFixed(1)} levels (median ${seams.median.toFixed(1)})`
    + (seams.sameView ? `; ${seams.sameView.toLocaleString()} cuts inside one photo, step ${seams.sameViewStep.toFixed(1)}` : ''))

  // 7 · Output mesh.
  const out = assemble(mesh, idx, cut, px, flat, pack, layout)
  progress(1, 'done')
  const summary = {
    faces: F, seenFaces, unseenFaces: flat.faces, orientation: cand.orientation,
    charts: charts.nCharts, pieces: pieces.count, flatCells: flat.count,
    scale: s, pageSize: o.pageSize, pages: pack.nPages, pageHeights: pack.pageHeights,
    fill: used / pageArea, viewsUsed: baked.decoded, photosFailed: baked.failed.length,
    gains: gainSummary, seamLevel, seams, nVerts: out.nVerts,
  }
  return {
    ...out,
    pages: baked.pages.map((data, p) => ({ width: o.pageSize, height: pack.pageHeights[p], data })),
    summary,
  }
}

// An unwelded mesh (an STL, some exporters: every face its own three corners) has no
// adjacency, so every face would become a chart. Weld it first when most edges are open.
function weldIfOpen(mesh, share, log) {
  const F = mesh.idx.length / 3
  if (!F) return mesh
  const { adj } = faceAdjacency(mesh.idx, mesh.pos.length / 3)
  let open = 0
  for (let i = 0; i < adj.length; i++) if (adj[i] < 0) open++
  if (open <= share * adj.length) return mesh
  const r = weldVertices({ pos: mesh.pos, idx: mesh.idx, col: mesh.col ?? null })
  log(`Texture: ${(100 * open / adj.length).toFixed(0)} % of edges were open, so the mesh was welded first `
    + `(${r.merged.toLocaleString()} corners joined)`)
  return r.mesh
}

// Unseen faces → palette cells of one flat colour each (the face's mean vertex colour,
// quantised). → { count, size, colour: Uint8Array(3·count), cellOf: Int32Array(F), faces }
function paletteCells(labels, idx, col, o) {
  const F = labels.length, bits = o.paletteBits, shift = 8 - bits, half = 1 << (shift - 1)
  const cellOf = new Int32Array(F).fill(-1)
  const keyToCell = new Map(), colours = []
  let faces = 0
  for (let f = 0; f < F; f++) {
    if (labels[f] >= 0) continue
    faces++
    if (o.unseen === 'remove') continue
    let r, g, b
    if (col) {
      const a = 3 * idx[3 * f], c = 3 * idx[3 * f + 1], d = 3 * idx[3 * f + 2]
      r = (col[a] + col[c] + col[d]) / 3; g = (col[a + 1] + col[c + 1] + col[d + 1]) / 3; b = (col[a + 2] + col[c + 2] + col[d + 2]) / 3
    } else [r, g, b] = o.grayFallback
    const qr = Math.round(r) >> shift, qg = Math.round(g) >> shift, qb = Math.round(b) >> shift
    const key = (qr << (2 * bits)) | (qg << bits) | qb
    let cell = keyToCell.get(key)
    if (cell === undefined) {
      cell = colours.length / 3
      keyToCell.set(key, cell)
      colours.push((qr << shift) + half, (qg << shift) + half, (qb << shift) + half)
    }
    cellOf[f] = cell
  }
  return { count: colours.length / 3, size: o.cellSize, colour: Uint8Array.from(colours), cellOf, faces }
}

// Colour-levelling samples: up to `max` faces seen by two or more views, coloured from
// every candidate view whose photo the bake decodes (fitGains needs no more than that).
// Each sample averages four points on the face (centroid and corners pulled halfway
// in), so one pixel of texture noise does not decide it.
//
// The fit is robust: a sample whose colour disagrees with the face's other views after
// levelling is something one photo saw and the others did not (a branch in front, a
// person, a misregistered edge) or a misalignment on a textured surface. Its ratio says
// nothing about exposure, and plain least squares let a few of them drag whole photos
// to gains of 0.6 or 1.7 (South Building). So: fit, drop observations beyond 3 robust
// sigmas of the per-face consensus (log colour, worst channel), fit again; twice.
const GAIN_PROBES = [[1 / 3, 1 / 3, 1 / 3], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3]]
const GAIN_ROUNDS = 2
const GAIN_MIN_TOL = 0.05 // never reject below ±5 % in log colour

function gainSampler(geom, idx, cand, views, s, max) {
  const { K, count, view } = cand
  const F = count.length
  let multi = 0
  for (let f = 0; f < F; f++) if (count[f] >= 2) multi++
  const stride = Math.max(1, Math.ceil(multi / max))
  const sampleFaces = []
  for (let f = 0, m = 0; f < F; f++) if (count[f] >= 2 && m++ % stride === 0) sampleFaces.push(f)
  // View → its samples (CSR).
  const start = new Int32Array(views.length + 1)
  for (const f of sampleFaces) for (let i = 0; i < count[f]; i++) start[view[f * K + i] + 1]++
  for (let v = 0; v < views.length; v++) start[v + 1] += start[v]
  const fill = start.slice(0, views.length), list = new Int32Array(start[views.length])
  sampleFaces.forEach((f, si) => { for (let i = 0; i < count[f]; i++) list[fill[view[f * K + i]]++] = si })
  const obsPt = growable(Int32Array), obsImg = growable(Int32Array), obsRgb = growable(Float32Array)
  const px = new Float32Array(4), acc = new Float64Array(3)
  const { P, origin } = geom
  return {
    sample(vi, photo) {
      const { r, t, K: Kv } = localCamera(views[vi], origin)
      for (let x = start[vi]; x < start[vi + 1]; x++) {
        const si = list[x], f = sampleFaces[si]
        const a = 3 * idx[3 * f], b = 3 * idx[3 * f + 1], c = 3 * idx[3 * f + 2]
        acc.fill(0)
        for (const [la, lb, lc] of GAIN_PROBES) {
          const X = la * P[a] + lb * P[b] + lc * P[c], Y = la * P[a + 1] + lb * P[b + 1] + lc * P[c + 1]
          const Z = la * P[a + 2] + lb * P[b + 2] + lc * P[c + 2]
          const z = r[6] * X + r[7] * Y + r[8] * Z + t[2]
          const u = toScaledPx(Kv.fx * ((r[0] * X + r[1] * Y + r[2] * Z + t[0]) / z) + Kv.cx, s)
          const v = toScaledPx(Kv.fy * ((r[3] * X + r[4] * Y + r[5] * Z + t[1]) / z) + Kv.cy, s)
          const m = photo.map ? photo.map(u, v) : { x: u, y: v }
          sampleRgbaBilinear(photo.data, photo.width, photo.height, m.x, m.y, px, 0)
          acc[0] += px[0]; acc[1] += px[1]; acc[2] += px[2]
        }
        const n = GAIN_PROBES.length
        if (gainSampleClipped(acc[0] / n, acc[1] / n, acc[2] / n)) continue
        obsPt.push(si); obsImg.push(vi)
        for (let ch = 0; ch < 3; ch++) obsRgb.push(srgbToLinear(acc[ch] / n))
      }
    },
    fit() {
      const nImages = views.length, nPoints = sampleFaces.length
      let pt = obsPt.array, img = obsImg.array, rgb = obsRgb.array
      const total = pt.length
      let res = fitGains({ nImages, nPoints, obsPt: pt, obsImg: img, obsRgb: rgb })
      for (let round = 0; round < GAIN_ROUNDS; round++) {
        const keep = consensusInliers(pt, img, rgb, res.gains, nPoints)
        if (keep.length === pt.length) break
        pt = keep.map((o) => pt[o]); img = keep.map((o) => img[o])
        const rgb2 = new Float32Array(3 * keep.length)
        keep.forEach((o, k) => { rgb2[3 * k] = rgb[3 * o]; rgb2[3 * k + 1] = rgb[3 * o + 1]; rgb2[3 * k + 2] = rgb[3 * o + 2] })
        pt = Int32Array.from(pt); img = Int32Array.from(img); rgb = rgb2
        res = fitGains({ nImages, nPoints, obsPt: pt, obsImg: img, obsRgb: rgb })
      }
      res.summary.rejected = total - pt.length
      // Per photo (mean of the three channels), for the run record and the log.
      res.summary.perView = Array.from({ length: nImages }, (_, i) => +((res.gains[3 * i] + res.gains[3 * i + 1] + res.gains[3 * i + 2]) / 3).toFixed(3))
      return res
    },
  }
}

// Observations (indices) within 3 robust sigmas of their face's consensus colour after
// levelling: residual = the worst channel's |log(g·c) − median over the face's views|.
function consensusInliers(pt, img, rgb, gains, nPoints) {
  const O = pt.length
  const start = new Int32Array(nPoints + 1)
  for (let o = 0; o < O; o++) start[pt[o] + 1]++
  for (let p = 0; p < nPoints; p++) start[p + 1] += start[p]
  const fill = start.slice(0, nPoints), order = new Int32Array(O)
  for (let o = 0; o < O; o++) order[fill[pt[o]]++] = o
  const lc = (o, ch) => Math.log(Math.max(1e-4, gains[3 * img[o] + ch] * rgb[3 * o + ch]))
  const resid = new Float32Array(O).fill(-1)
  const vals = []
  for (let p = 0; p < nPoints; p++) {
    const s0 = start[p], s1 = start[p + 1]
    if (s1 - s0 < 2) continue
    for (let ch = 0; ch < 3; ch++) {
      vals.length = 0
      for (let x = s0; x < s1; x++) vals.push(lc(order[x], ch))
      vals.sort((a, b) => a - b)
      const n = vals.length, med = n & 1 ? vals[n >> 1] : (vals[n / 2 - 1] + vals[n / 2]) / 2
      for (let x = s0; x < s1; x++) { const o = order[x]; resid[o] = Math.max(resid[o], Math.abs(lc(o, ch) - med)) }
    }
  }
  const rs = []
  for (let o = 0; o < O; o++) if (resid[o] >= 0) rs.push(resid[o])
  rs.sort((a, b) => a - b)
  const sigma = 1.4826 * (rs.length ? rs[rs.length >> 1] : 0)
  const tol = Math.max(GAIN_MIN_TOL, 3 * sigma)
  const keep = []
  for (let o = 0; o < O; o++) if (resid[o] >= 0 && resid[o] <= tol) keep.push(o)
  return keep
}

// The colour step across seams: for edges whose two faces sit in different pieces,
// the atlas colour at the edge's midpoint as each side's piece has it (mean absolute
// difference over RGB, in sRGB levels). Between two photos it measures exposure and
// alignment errors; a cut inside one photo should read ~0 (both sides sample the same
// photo). Up to `max` edges, evenly strided.
export function seamStats(adj, labels, idx, cut, px, layout, pages, max = 200000) {
  const { pieces, faces } = cut
  const { pageSize: P, pageHeights, scale: s, place } = layout
  const F = labels.length
  const pieceOf = new Int32Array(F).fill(-1)
  for (let p = 0; p < pieces.count; p++) for (let x = pieces.start[p]; x < pieces.end[p]; x++) pieceOf[faces[x]] = p
  // Atlas position of corner k of face f in its own piece.
  const at = (f, k, out) => {
    const p = pieceOf[f]
    out[0] = toScaledPx(px[6 * f + 2 * k], s) - pieces.x0[p] + place.x[p]
    out[1] = toScaledPx(px[6 * f + 2 * k + 1], s) - pieces.y0[p] + place.y[p]
  }
  const sample = (f, ka, kb, rgb) => {
    const a = [0, 0], b = [0, 0]
    at(f, ka, a); at(f, kb, b)
    const p = pieceOf[f], page = place.page[p]
    sampleRgbaBilinear(pages[page], P, pageHeights[page], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, rgb, 0)
  }
  let edges = 0
  for (let f = 0; f < F; f++) {
    if (pieceOf[f] < 0) continue
    for (let k = 0; k < 3; k++) { const g = adj[3 * f + k]; if (g > f && pieceOf[g] >= 0 && pieceOf[g] !== pieceOf[f]) edges++ }
  }
  const stride = Math.max(1, Math.ceil(edges / max))
  const ca = new Float32Array(4), cb = new Float32Array(4)
  const steps = [], same = []
  let e = 0
  for (let f = 0; f < F; f++) {
    if (pieceOf[f] < 0) continue
    for (let k = 0; k < 3; k++) {
      const g = adj[3 * f + k]
      if (!(g > f && pieceOf[g] >= 0 && pieceOf[g] !== pieceOf[f])) continue
      if (e++ % stride) continue
      // The shared edge's corners in g: the same two vertices.
      const kb = (k + 1) % 3
      const i0 = cornerOf(idx, g, idx[3 * f + k]), i1 = cornerOf(idx, g, idx[3 * f + kb])
      if (i0 < 0 || i1 < 0) continue
      sample(f, k, kb, ca); sample(g, i0, i1, cb)
      const d = (Math.abs(ca[0] - cb[0]) + Math.abs(ca[1] - cb[1]) + Math.abs(ca[2] - cb[2])) / 3
      ;(labels[f] === labels[g] ? same : steps).push(d)
    }
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
  steps.sort((x, y) => x - y)
  return { seams: Math.round(steps.length * stride), step: mean(steps), median: steps.length ? steps[steps.length >> 1] : 0,
    sameView: Math.round(same.length * stride), sameViewStep: mean(same) }
}
const cornerOf = (idx, f, v) => (idx[3 * f] === v ? 0 : idx[3 * f + 1] === v ? 1 : idx[3 * f + 2] === v ? 2 : -1)

// Split vertices and order faces by page. A vertex gets one copy per piece it belongs to
// (its UV differs between pieces); within a piece, faces share it.
function assemble(mesh, idx, cut, px, flat, pack, layout) {
  const { pos, col = null } = mesh
  const { pieces, faces } = cut
  const { pageSize: P, pageHeights, scale: s } = layout
  const F = idx.length / 3, nV = pos.length / 3
  const nPieces = pieces.count + flat.count
  // Flat cells' faces, grouped by cell.
  const cellStart = new Int32Array(flat.count + 1)
  for (let f = 0; f < F; f++) if (flat.cellOf[f] >= 0) cellStart[flat.cellOf[f] + 1]++
  for (let c = 0; c < flat.count; c++) cellStart[c + 1] += cellStart[c]
  const cellFill = cellStart.slice(0, flat.count), cellFaces = new Int32Array(cellStart[flat.count])
  for (let f = 0; f < F; f++) if (flat.cellOf[f] >= 0) cellFaces[cellFill[flat.cellOf[f]]++] = f

  const order = Array.from({ length: nPieces }, (_, p) => p).sort((a, b) => pack.page[a] - pack.page[b] || a - b)
  const stamp = new Int32Array(nV).fill(-1), local = new Int32Array(nV)
  const srcV = growable(Int32Array, nV + (nV >> 1)), uvs = growable(Float32Array, 2 * nV + nV)
  const outIdx = new Uint32Array(3 * F)
  const groups = []
  let fo = 0
  for (const p of order) {
    const pg = pack.page[p]
    if (!groups.length || groups[groups.length - 1].page !== pg) groups.push({ page: pg, start: fo, count: 0 })
    const H = pageHeights[pg], ax = pack.x[p], ay = pack.y[p]
    const isFlat = p >= pieces.count
    const list = isFlat ? cellFaces : faces
    const a = isFlat ? cellStart[p - pieces.count] : pieces.start[p]
    const b = isFlat ? cellStart[p - pieces.count + 1] : pieces.end[p]
    const ox = isFlat ? 0 : ax - pieces.x0[p], oy = isFlat ? 0 : ay - pieces.y0[p]
    for (let x = a; x < b; x++) {
      const f = list[x]
      for (let k = 0; k < 3; k++) {
        const v = idx[3 * f + k]
        if (stamp[v] !== p) {
          stamp[v] = p; local[v] = srcV.length
          srcV.push(v)
          if (isFlat) {
            uvs.push((ax + flat.size / 2) / P); uvs.push((ay + flat.size / 2) / H)
          } else {
            // Texel (i, j) is centred on grid pixel x0 + i, so a grid coordinate g sits
            // at texel g − x0 and texture coordinate (that + ½) / page size.
            uvs.push((toScaledPx(px[6 * f + 2 * k], s) + ox + 0.5) / P)
            uvs.push((toScaledPx(px[6 * f + 2 * k + 1], s) + oy + 0.5) / H)
          }
        }
        outIdx[3 * fo + k] = local[v]
      }
      fo++
      groups[groups.length - 1].count++
    }
  }
  const V2 = srcV.length, src = srcV.array
  const outPos = new (pos instanceof Float64Array ? Float64Array : Float32Array)(3 * V2)
  const outCol = col ? new Uint8Array(3 * V2) : null
  for (let i = 0; i < V2; i++) {
    const v = src[i]
    outPos[3 * i] = pos[3 * v]; outPos[3 * i + 1] = pos[3 * v + 1]; outPos[3 * i + 2] = pos[3 * v + 2]
    if (outCol) { outCol[3 * i] = col[3 * v]; outCol[3 * i + 1] = col[3 * v + 1]; outCol[3 * i + 2] = col[3 * v + 2] }
  }
  // Removed unseen faces (unseen: 'remove') leave the index shorter than the input.
  return { pos: outPos, idx: fo === F ? outIdx : outIdx.slice(0, 3 * fo), uv: uvs.array.slice(), col: outCol, nVerts: V2, count: fo, groups }
}
