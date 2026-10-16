// Texture a mesh from the registered photos (dev/planning/plan-texture.md). Pure: no
// Vue, Pinia, OPFS, DOM or WASM; photos and masks come in through hooks.
//
//   1 visibility   faceCandidates — per-view z-buffer of the mesh, best views per face
//   2 selection    selectViews    — one view per face, Potts-smoothed (loopy BP)
//   3 charts       buildCharts    — connected same-view faces; UVs = their projection
//   4 packing      chartPieces + packShelves at a texel scale lowered until it fits
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
import { selectViews } from './labeling.js'
import { buildCharts, cornerPixels, chartPieces } from './charts.js'
import { packShelves } from './packing.js'
import { bakeAtlas, applyGains } from './bake.js'

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
  log(`Texture: ${seenFaces.toLocaleString()} of ${F.toLocaleString()} faces seen by at least one of ${views.length} views`
    + ` (z-buffer ≤ ${o.bufferSide} px, faces within ${Math.round(Math.acos(o.minCos) * 180 / Math.PI)}° of facing); `
    + (cand.orientation === 0 ? 'mesh winding is inconsistent, so both sides of each face count'
      : `mesh faces point ${cand.orientation > 0 ? 'outward' : 'inward'} (back faces dropped)`),
  seenFaces < 0.5 * F ? 'warn' : 'info')

  // 2 · View selection.
  const { adj, rev } = faceAdjacency(idx, geom.nVerts)
  const labels = selectViews(cand, adj, rev, { smoothness: o.smoothness, iterations: o.bpIterations, damping: o.bpDamping })
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
      pack = packShelves(w, h, o.pageSize)
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
  log(`Texture: ${charts.nCharts.toLocaleString()} charts in ${pieces.count.toLocaleString()} pieces`
    + (flat.count ? ` + ${flat.count} flat colour cells for ${flat.faces.toLocaleString()} unseen faces` : '')
    + ` on ${pack.nPages} page${pack.nPages === 1 ? '' : 's'} of ${o.pageSize} px, ${(100 * used / pageArea).toFixed(0)} % filled; `
    + `texel = ${s >= 0.995 ? 'native photo pixel' : `${(1 / s).toFixed(2)} photo pixels`}`
    + (s < o.maxScale ? ` (lowered from ${o.maxScale === 1 ? 'native' : o.maxScale} to fit ${o.maxPages} pages)` : ''))

  // 5 · Bake, collecting colour-levelling samples from each photo while it is loaded.
  const layout = { pageSize: o.pageSize, pageHeights: pack.pageHeights, scale: s, pieces, place: pack, flat }
  const levelling = o.levelColours ? gainSampler(geom, cand, views, s, o.gainSamples) : null
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
      : 'Texture: colour levelling skipped (no face seen by two decoded photos)')
  }

  // 7 · Output mesh.
  const out = assemble(mesh, idx, cut, px, flat, pack, layout)
  progress(1, 'done')
  const summary = {
    faces: F, seenFaces, unseenFaces: flat.faces, orientation: cand.orientation,
    charts: charts.nCharts, pieces: pieces.count, flatCells: flat.count,
    scale: s, pageSize: o.pageSize, pages: pack.nPages, pageHeights: pack.pageHeights,
    fill: used / pageArea, viewsUsed: baked.decoded, photosFailed: baked.failed.length,
    gains: gainSummary, nVerts: out.nVerts,
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
function gainSampler(geom, cand, views, s, max) {
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
  const px = new Float32Array(4)
  const { centroid, origin } = geom
  return {
    sample(vi, photo) {
      const { r, t, K: Kv } = localCamera(views[vi], origin)
      for (let x = start[vi]; x < start[vi + 1]; x++) {
        const si = list[x], f = sampleFaces[si]
        const X = centroid[3 * f], Y = centroid[3 * f + 1], Z = centroid[3 * f + 2]
        const z = r[6] * X + r[7] * Y + r[8] * Z + t[2]
        const u = toScaledPx(Kv.fx * ((r[0] * X + r[1] * Y + r[2] * Z + t[0]) / z) + Kv.cx, s)
        const v = toScaledPx(Kv.fy * ((r[3] * X + r[4] * Y + r[5] * Z + t[1]) / z) + Kv.cy, s)
        const m = photo.map ? photo.map(u, v) : { x: u, y: v }
        sampleRgbaBilinear(photo.data, photo.width, photo.height, m.x, m.y, px, 0)
        if (gainSampleClipped(px[0], px[1], px[2])) continue
        obsPt.push(si); obsImg.push(vi)
        obsRgb.push(srgbToLinear(px[0])); obsRgb.push(srgbToLinear(px[1])); obsRgb.push(srgbToLinear(px[2]))
      }
    },
    fit: () => fitGains({ nImages: views.length, nPoints: sampleFaces.length, obsPt: obsPt.array, obsImg: obsImg.array, obsRgb: obsRgb.array }),
  }
}

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
  return { pos: outPos, idx: outIdx, uv: uvs.array.slice(), col: outCol, nVerts: V2, count: fo, groups }
}
