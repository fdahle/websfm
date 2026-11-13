// Film-scan ops: fiducial template matching and spot detection, réseau detection,
// growth and stitching, and splitting a panoramic strip (F4 auto-measurement).

import { crossInWindow, fitLatticeAffine, nominalScanPosition } from '../../core/sfm/reseauDetect.js'
import { invertFiducialTransform } from '../../core/sfm/fiducialCalibration.js'
import { segmentToStrip } from '../../core/sfm/panoramic.js'
import { createCogBuilder, geoKeysForEpsg } from '../../core/products/geotiff.js'
import { deflateTile } from '../deflateTile.js'
import { FIDUCIAL_DETECT_TUNING, grayFromRgba, detectFiducialsInImage } from '../../core/sfm/fiducialDetect.js'
import {
  FIDUCIAL_DETECTION_TUNING,
  detectFiducialSpots as detectFiducialSpotsCore,
  refineDetectionSpot,
  nativeRefinePlan,
} from '../../core/sfm/fiducialDetection.js'
import { pluralize } from '../../core/textFormat.js'
import { upperMedian } from '../../core/stats.js'
import { cropGray, decodeBitmap, downscaleBitmap, scaledRgba } from './detectBitmaps.js'

// ── fiducial template matching (F4 auto-measurement) ─────────────────────
//
// These two ops deliberately do NOT use `rasterize`: a film scan is routinely
// 10k×10k, and one full-resolution RGBA raster of that is ~400 MB. Instead we
// decode to an ImageBitmap ONCE per op and pull only the small rectangles we
// actually correlate over, via source-rect drawImage into a tiny canvas. Peak
// memory is the bitmap plus a (2·half+1)² window.
export function makeFilmOps() {
  // Cut one full-resolution template per marked fiducial out of the reference
  // image. Called once per run; the templates are then reused for every target.
  async function prepareFiducialTemplates([url, obs, options = {}], { emit } = {}) {
    const templateHalf = options.templateHalf ?? FIDUCIAL_DETECT_TUNING.templateHalf
    const size = 2 * templateHalf + 1
    const bmp = await decodeBitmap(url)
    try {
      if (bmp.width < size || bmp.height < size) {
        throw new Error(`reference image ${bmp.width}×${bmp.height} is smaller than the ${size}px template`)
      }
      const templates = []
      const transfer = []
      for (const o of obs) {
        const win = cropGray(bmp, o.px - templateHalf, o.py - templateHalf, size, size)
        templates.push({ fidId: o.fidId, size, data: win.data })
        transfer.push(win.data.buffer)
      }
      emit?.('log', [
        `Fiducial: cut ${pluralize(templates.length, 'template')} @ ${size}px from the reference image (${bmp.width}×${bmp.height})`,
      ])
      return { result: { templates, natW: bmp.width, natH: bmp.height }, transfer }
    } finally {
      bmp.close()
    }
  }

  // Find every template in one target image. `templates` arrive structured-cloned
  // per call (they are reused across images, so the CLIENT must not transfer them
  // — transferring would detach the buffers after the first image).
  async function detectFiducials([url, templates, predictions, options = {}], { emit } = {}) {
    const cfg = { ...FIDUCIAL_DETECT_TUNING, ...options }
    const t0 = performance.now()
    const bmp = await decodeBitmap(url)
    try {
      const natW = bmp.width,
        natH = bmp.height
      // Whole image at coarse scale, for the rotation probe + the coarse peak.
      const cw = Math.max(1, Math.round(natW * cfg.coarseScale))
      const ch = Math.max(1, Math.round(natH * cfg.coarseScale))
      const gray = grayFromRgba(scaledRgba(bmp, cw, ch), cw, ch)
      // The ACTUAL drawn scale, not the requested `coarseScale` — drawImage
      // rounds to whole pixels. (x and y can differ by up to half a coarse
      // pixel, i.e. a few full-res px — far inside the ±refineHalf window the
      // coarse peak only has to land in, so one scale is enough.)
      const coarse = { ...gray, scale: cw / natW, natW, natH }

      const results = detectFiducialsInImage({
        coarse,
        templates: templates.map((t) => ({ fidId: t.fidId, patch: { data: t.data, size: t.size } })),
        predictions,
        cfg,
        // Synchronous by design: OffscreenCanvas drawImage/getImageData are sync,
        // which is what lets the pure orchestrator call back into the worker.
        cropWindow: (cx, cy, half) => cropGray(bmp, cx - half, cy - half, 2 * half + 1, 2 * half + 1),
        onLog: emit ? (msg) => emit('log', [`Fiducial: ${msg}`]) : undefined,
      })
      return { result: { results, ms: performance.now() - t0 } }
    } finally {
      bmp.close()
    }
  }

  async function detectFiducialSpots([url, options = {}], { emit } = {}) {
    const cfg = { ...FIDUCIAL_DETECTION_TUNING, ...options }
    const t0 = performance.now()
    const bmp = await decodeBitmap(url)
    try {
      const rgba = downscaleBitmap(bmp, cfg.maxDim)
      const gray = {
        ...grayFromRgba(rgba.data, rgba.width, rgba.height),
        scale: rgba.scale,
        natW: rgba.natW,
        natH: rgba.natH,
      }
      const coarse = detectFiducialSpotsCore(gray, cfg)
      const refine = (d) => {
        const plan = nativeRefinePlan(d, gray.scale, cfg)
        if (!plan) return { ...d, px: d.px / gray.scale, py: d.py / gray.scale }
        const { px0, py0, half } = plan
        const win = cropGray(bmp, px0 - half, py0 - half, 2 * half + 1, 2 * half + 1)
        const hit = refineDetectionSpot(win, px0 - win.originX, py0 - win.originY, plan.radius, {
          ...cfg,
          prototypeSizes: plan.sizes,
          variants: plan.variants,
          polarity: plan.polarity ?? cfg.polarity,
        })
        // Keep the coarse peakMargin: it was measured over the whole slot search,
        // while the refine window is too small to hold a distinct runner-up.
        return hit
          ? { ...d, px: win.originX + hit.x, py: win.originY + hit.y, score: hit.score }
          : { ...d, px: px0, py: py0 }
      }
      const accepted = coarse.accepted.map(refine),
        drafts = coarse.drafts.map(refine)
      const frame = coarse.frame
        ? {
            ...coarse.frame,
            left: coarse.frame.left / gray.scale,
            right: coarse.frame.right / gray.scale,
            top: coarse.frame.top / gray.scale,
            bottom: coarse.frame.bottom / gray.scale,
          }
        : null
      emit?.('log', [
        `Fiducial detection: ${accepted.length}/${coarse.requested} accepted, ${pluralize(drafts.length, 'draft')} on ${bmp.width}×${bmp.height}`,
      ])
      return {
        result: { ...coarse, accepted, drafts, frame, natW: bmp.width, natH: bmp.height, ms: performance.now() - t0 },
      }
    } finally {
      bmp.close()
    }
  }

  // Reseau crosses (SAT-5) in one scan, at native resolution, a window per cross.
  // opts: { nodes: [{ id, i, j, xMm, yMm }] (reseauDetect.js reseauLattice), pitchMm (the
  // scan pitch), armPx, widthPx, placePx (how far the scan may sit off centre: the
  // central crosses' search radius, < half a cell or the lattice is ambiguous), refinePx
  // (every other cross's search radius around its prediction: the film's deformation) }.
  // The central 5 × 5 crosses place the lattice (an affine), then every cross is found
  // near its prediction; a weak or far-off peak is left out. → { detections: [{ slot,
  // px, py, score }] (pixel-edge native px), placed, found, of, ms }.
  async function detectReseau([url, opts], { emit } = {}) {
    const t0 = performance.now()
    const { nodes, pitchMm, armPx, widthPx = 1, placePx, refinePx } = opts
    const bmp = await decodeBitmap(url)
    try {
      const geom = { width: bmp.width, height: bmp.height, pitchMm }
      const margin = Math.ceil(armPx) + 2 * Math.max(1, Math.round(widthPx)) + 3
      const find = (px, py, radius) => {
        const half = Math.ceil(radius) + margin
        const win = cropGray(bmp, px - half, py - half, 2 * half + 1, 2 * half + 1)
        const hit = crossInWindow(win, { armPx, widthPx })
        if (!hit) return null
        const x = win.originX + hit.x,
          y = win.originY + hit.y
        return Math.hypot(x - px, y - py) <= radius + 0.5 ? { px: x, py: y, score: hit.score } : null
      }
      // 1. Place: the central crosses around their nominal positions, then the affine.
      const central = nodes.filter((n) => Math.abs(n.i) <= 2 && Math.abs(n.j) <= 2)
      let placed = []
      for (const n of central) {
        const p = nominalScanPosition(n, geom)
        const hit = find(p.px, p.py, placePx)
        if (hit) placed.push({ ...n, ...hit })
      }
      // Keep the crosses that agree on the shift (a wrong central hit is a texture peak).
      const med = (v) => {
        const a = [...v].sort((x, y) => x - y)
        return a[a.length >> 1]
      }
      if (placed.length) {
        const offs = placed.map((h) => {
          const p = nominalScanPosition(h, geom)
          return [h.px - p.px, h.py - p.py]
        })
        const mx = med(offs.map((o) => o[0])),
          my = med(offs.map((o) => o[1]))
        placed = placed.filter(
          (h, k) => Math.hypot(offs[k][0] - mx, offs[k][1] - my) <= Math.max(3, 0.01 * placePx + refinePx),
        )
      }
      const placement = fitLatticeAffine(placed)
      if (!placement) {
        emit?.('log', [
          `Reseau: could not place the lattice (${pluralize(placed.length, 'central cross', 'central crosses')} found)`,
          'warn',
          'Images',
        ])
        return {
          result: { detections: [], placed: placed.length, found: 0, of: nodes.length, ms: performance.now() - t0 },
        }
      }
      // 2. Every cross near its prediction.
      const hits = []
      for (const n of nodes) {
        const p = placement.predict(n.xMm, n.yMm)
        if (p.px < 0 || p.py < 0 || p.px > bmp.width || p.py > bmp.height) continue
        const hit = find(p.px, p.py, refinePx)
        if (hit) hits.push({ slot: n.id, ...hit })
      }
      // A weak peak is texture, not a cross.
      const floor = 0.35 * (hits.length ? med(hits.map((h) => h.score)) : 0)
      const detections = hits.filter((h) => h.score >= floor)
      return {
        result: {
          detections,
          placed: placed.length,
          found: detections.length,
          of: nodes.length,
          ms: performance.now() - t0,
        },
      }
    } finally {
      bmp.close()
    }
  }

  // Reseau crosses of a half-frame scan (SAT-5), grown from one: no frame centre to
  // place the lattice from. A seed cross near `start` (scan px) whose lattice neighbours
  // are there too, then breadth first: each next cross is predicted from an affine of
  // its found neighbours (the film's deformation bends the grid slowly) and searched
  // within `refinePx`. A weak peak (texture, the dark border) stops the growth there.
  // opts: { pitchMm, spacingMm, armPx, widthPx, refinePx, start: { px, py } }.
  // → { found: [{ di, dj, px, py, score }] (grid steps from the seed: di right, dj
  // down), seed, ms }.
  async function growReseau([url, opts], { emit } = {}) {
    const t0 = performance.now()
    const { pitchMm, spacingMm, armPx, widthPx = 1, refinePx } = opts
    const cell = spacingMm / pitchMm
    const bmp = await decodeBitmap(url)
    try {
      const margin = Math.ceil(armPx) + 2 * Math.max(1, Math.round(widthPx)) + 3
      const find = (px, py, radius) => {
        if (px < margin || py < margin || px > bmp.width - margin || py > bmp.height - margin) return null
        const half = Math.ceil(radius) + margin
        const win = cropGray(bmp, px - half, py - half, 2 * half + 1, 2 * half + 1)
        const hit = crossInWindow(win, { armPx, widthPx })
        if (!hit) return null
        const x = win.originX + hit.x,
          y = win.originY + hit.y
        return Math.hypot(x - px, y - py) <= radius + 0.5 ? { px: x, py: y, score: hit.score } : null
      }
      // 1. A seed with its neighbours (axis-aligned lattice: the scan is rotated < 2°).
      const start = opts.start ?? { px: bmp.width / 2, py: bmp.height / 2 }
      let seed = null
      const tries = [
        [0, 0],
        [0.5, 0],
        [-0.5, 0],
        [0, 0.5],
        [0, -0.5],
        [1.5, 0],
        [-1.5, 0],
        [0, 1.5],
        [0, -1.5],
      ]
      for (const [ox, oy] of tries) {
        const c = find(start.px + ox * cell, start.py + oy * cell, 0.6 * cell)
        if (!c) continue
        const r = Math.max(refinePx, 0.03 * cell)
        const near = [
          [cell, 0],
          [-cell, 0],
          [0, cell],
          [0, -cell],
        ]
          .map(([dx, dy]) => find(c.px + dx, c.py + dy, r))
          .filter(Boolean)
        if (near.length >= 3) {
          seed = c
          break
        }
      }
      if (!seed) return { result: { found: [], seed: null, ms: performance.now() - t0 } }
      // 2. Breadth first from the seed.
      const key = (di, dj) => `${di},${dj}`
      const found = new Map([[key(0, 0), { di: 0, dj: 0, ...seed }]])
      const queue = [[0, 0]]
      const scores = [seed.score]
      const predict = (di, dj) => {
        const near = []
        for (let b = -2; b <= 2; b++)
          for (let a = -2; a <= 2; a++) {
            const f = found.get(key(di + a, dj + b))
            if (f) near.push({ xMm: f.di, yMm: f.dj, px: f.px, py: f.py })
          }
        const fit = near.length >= 3 ? fitLatticeAffine(near) : null
        if (fit) return fit.predict(di, dj)
        for (const [a, b] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]) {
          const f = found.get(key(di + a, dj + b))
          if (f) return { px: f.px - a * cell, py: f.py - b * cell }
        }
        return null
      }
      while (queue.length) {
        const [di, dj] = queue.shift()
        for (const [a, b] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const ni = di + a,
            nj = dj + b
          if (found.has(key(ni, nj))) continue
          const p = predict(ni, nj)
          if (!p) continue
          const hit = find(p.px, p.py, refinePx)
          if (!hit || hit.score < 0.35 * upperMedian(scores)) {
            found.set(key(ni, nj), null)
            continue
          }
          found.set(key(ni, nj), { di: ni, dj: nj, ...hit })
          if (scores.length < 200) scores.push(hit.score)
          queue.push([ni, nj])
        }
      }
      const list = [...found.values()].filter(Boolean)
      emit?.('log', [
        `Reseau: grew ${pluralize(list.length, 'cross', 'crosses')} from (${seed.px.toFixed(0)}, ${seed.py.toFixed(0)}) on ${bmp.width}×${bmp.height}`,
        'debug',
        'Fiducial',
      ])
      return { result: { found: list, seed, ms: performance.now() - t0 } }
    } finally {
      bmp.close()
    }
  }

  // Film mm → a half's scan px over a patch of the stitched grid, sampled bilinearly.
  function sampleHalf(bmp, fit, geom, c0, r0, w, h, inside, step = 32) {
    // The film under the output pixel's centre (pixel (c, r) spans [c, c + 1) × [r, r + 1)).
    const toSource = (x, y) =>
      invertFiducialTransform({ x: geom.x0Mm + x * geom.pitchMm, y: geom.y0Mm - y * geom.pitchMm }, fit)
    return sampleMapped(bmp, toSource, c0, r0, w, h, inside, step)
  }

  // An output patch [c0, c0 + w) × [r0, r0 + h) sampled bilinearly from `bmp` through
  // `toSource(x, y)`: output pixel-edge position → source pixel-edge position. The exact
  // map runs on a coarse lattice every `step` px; between, the (smooth) map is
  // interpolated. `inside(c)`: the output columns this source supplies (all if null).
  // → Float32Array (NaN off the source).
  function sampleMapped(bmp, toSource, c0, r0, w, h, inside = null, step = 32) {
    const out = new Float32Array(w * h).fill(NaN)
    const gw = Math.ceil(w / step) + 1,
      gh = Math.ceil(h / step) + 1
    const gx = new Float64Array(gw * gh),
      gy = new Float64Array(gw * gh)
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      any = !inside
    for (let b = 0; b < gh; b++)
      for (let a = 0; a < gw; a++) {
        const c = c0 + Math.min(w, a * step),
          r = r0 + Math.min(h, b * step)
        const q = toSource(c + 0.5, r + 0.5)
        gx[b * gw + a] = q.x
        gy[b * gw + a] = q.y
      }
    // Which pixels this source supplies (the caller's seam), and its source window.
    if (inside) for (let r = 0; r < h; r += step) for (let c = 0; c < w; c += step) if (inside(c0 + c)) any = true
    if (!any && !inside(c0 + w - 1)) return out
    for (let k = 0; k < gx.length; k++) {
      x0 = Math.min(x0, gx[k])
      x1 = Math.max(x1, gx[k])
      y0 = Math.min(y0, gy[k])
      y1 = Math.max(y1, gy[k])
    }
    const sx0 = Math.max(0, Math.floor(x0) - 2),
      sy0 = Math.max(0, Math.floor(y0) - 2)
    const sx1 = Math.min(bmp.width, Math.ceil(x1) + 2),
      sy1 = Math.min(bmp.height, Math.ceil(y1) + 2)
    if (sx1 <= sx0 || sy1 <= sy0) return out
    const win = cropGray(bmp, sx0, sy0, sx1 - sx0, sy1 - sy0)
    const ww = win.width,
      wh = win.height,
      d = win.data
    for (let r = 0; r < h; r++) {
      const fb = r / step,
        b = Math.min(gh - 2, Math.floor(fb)),
        tb = fb - b
      for (let c = 0; c < w; c++) {
        if (inside && !inside(c0 + c)) continue
        const fa = c / step,
          a = Math.min(gw - 2, Math.floor(fa)),
          ta = fa - a
        const k = b * gw + a
        const lerp = (g) =>
          (1 - tb) * ((1 - ta) * g[k] + ta * g[k + 1]) + tb * ((1 - ta) * g[k + gw] + ta * g[k + gw + 1])
        // Pixel-edge source coords → sample at the pixel-centre grid of the window.
        const x = lerp(gx) - win.originX - 0.5,
          y = lerp(gy) - win.originY - 0.5
        const ix = Math.floor(x),
          iy = Math.floor(y)
        if (ix < 0 || iy < 0 || ix >= ww - 1 || iy >= wh - 1) continue
        const fx = x - ix,
          fy = y - iy,
          i = iy * ww + ix
        out[r * w + c] = (1 - fy) * ((1 - fx) * d[i] + fx * d[i + 1]) + fy * ((1 - fx) * d[i + ww] + fx * d[i + ww + 1])
      }
    }
    return out
  }

  // The two halves' agreement in their overlap for each candidate pair of fits (their
  // lattice indexing): the same film points sampled from both, as one normalised
  // cross-correlation over a few patches. A column off by one disagrees everywhere.
  // [urlA, urlB, { candidates: [{ fitA, fitB }], geometry, xMm: [lo, hi] }] → { scores }.
  async function reseauOverlapScore([urlA, urlB, { candidates, geometry, xMm }]) {
    const [A, B] = [await decodeBitmap(urlA), await decodeBitmap(urlB)]
    try {
      const size = 96,
        all = () => true
      const scores = candidates.map(({ fitA, fitB }) => {
        let sa = 0,
          sb = 0,
          saa = 0,
          sbb = 0,
          sab = 0,
          n = 0
        for (const fy of [0.25, 0.5, 0.75])
          for (const fx of [0.3, 0.7]) {
            const xm = xMm[0] + fx * (xMm[1] - xMm[0])
            const c0 = Math.round((xm - geometry.x0Mm) / geometry.pitchMm) - size / 2
            const r0 = Math.round(fy * geometry.height) - size / 2
            const pa = sampleHalf(A, fitA, geometry, c0, r0, size, size, all, 16)
            const pb = sampleHalf(B, fitB, geometry, c0, r0, size, size, all, 16)
            for (let k = 0; k < pa.length; k++) {
              const a = pa[k],
                b = pb[k]
              if (!Number.isFinite(a) || !Number.isFinite(b)) continue
              sa += a
              sb += b
              saa += a * a
              sbb += b * b
              sab += a * b
              n++
            }
          }
        if (n < 100) return null
        const cov = sab / n - (sa / n) * (sb / n),
          va = saa / n - (sa / n) ** 2,
          vb = sbb / n - (sb / n) ** 2
        return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null
      })
      return { result: { scores } }
    } finally {
      A.close()
      B.close()
    }
  }

  // The stitched frame (SAT-5): every pixel of the film grid `geometry` (reseauDetect.js
  // stitchedFrameGeometry) sampled from half A left of `seamXMm`, from B right of it,
  // through each half's reseau fit — placement and film deformation removed. Written
  // block by block as a tiled 8-bit TIFF (DEFLATE). → a Blob (image/tiff).
  async function stitchReseauFrame([urlA, urlB, { fitA, fitB, geometry, seamXMm }], { emit } = {}) {
    const t0 = performance.now()
    const [A, B] = [await decodeBitmap(urlA), await decodeBitmap(urlB)]
    try {
      const { width: W, height: H } = geometry,
        BLOCK = 2048
      const builder = createCogBuilder(
        {
          width: W,
          height: H,
          tileSize: 512,
          ArrayType: Uint8Array,
          samples: [{ bits: 8, format: 1 }],
          photometric: 1,
          pixelScale: [1, 1, 0],
          tiepoint: [0, 0, 0, 0, 0, 0],
          geoKeys: geoKeysForEpsg(null, false),
        },
        { blockSize: BLOCK, compress: deflateTile },
      )
      const seamCol = (seamXMm - geometry.x0Mm) / geometry.pitchMm
      const nb = Math.ceil(W / BLOCK) * Math.ceil(H / BLOCK)
      let done = 0
      for (let r0 = 0; r0 < H; r0 += BLOCK)
        for (let c0 = 0; c0 < W; c0 += BLOCK) {
          const w = Math.min(BLOCK, W - c0),
            h = Math.min(BLOCK, H - r0)
          const out = new Uint8Array(w * h)
          for (const [bmp, fit, inside] of [
            [A, fitA, (c) => c + 0.5 < seamCol],
            [B, fitB, (c) => c + 0.5 >= seamCol],
          ]) {
            if (c0 + w <= seamCol && bmp === B) continue
            if (c0 >= seamCol && bmp === A) continue
            const v = sampleHalf(bmp, fit, geometry, c0, r0, w, h, inside)
            for (let k = 0; k < v.length; k++)
              if (Number.isFinite(v[k])) out[k] = Math.max(0, Math.min(255, Math.round(v[k])))
          }
          await builder.addBlock({ col0: c0, row0: r0, width: w, height: h, data: out })
          emit?.('progress', [++done, nb, 'Stitching…'])
        }
      const { parts } = await builder.finish()
      emit?.('log', [
        `Reseau: stitched ${W}×${H} from ${A.width}×${A.height} + ${B.width}×${B.height} in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
        'info',
        'Fiducial',
      ])
      return { result: new Blob(parts, { type: 'image/tiff' }) }
    } finally {
      A.close()
      B.close()
    }
  }

  // Split panoramic strips (core/sfm/panoramic.js): every segment of one strip resampled
  // from the strip's cylinder onto its own pinhole image, block by block, each written as
  // a tiled 8-bit TIFF (DEFLATE). Off the strip is black.
  // [url, { strip, layout }] → [Blob (image/tiff)] in segment order.
  async function splitPanoramicStrip([url, { strip, layout }], { emit } = {}) {
    const t0 = performance.now()
    const bmp = await decodeBitmap(url)
    try {
      const BLOCK = 2048
      const total = layout.segments.reduce((n, g) => n + Math.ceil(g.width / BLOCK) * Math.ceil(g.height / BLOCK), 0)
      const blobs = []
      let done = 0
      for (const seg of layout.segments) {
        const { width: W, height: H } = seg
        const builder = createCogBuilder(
          {
            width: W,
            height: H,
            tileSize: 512,
            ArrayType: Uint8Array,
            samples: [{ bits: 8, format: 1 }],
            photometric: 1,
            pixelScale: [1, 1, 0],
            tiepoint: [0, 0, 0, 0, 0, 0],
            geoKeys: geoKeysForEpsg(null, false),
          },
          { blockSize: BLOCK, compress: deflateTile },
        )
        const toSource = (a, b) => {
          const q = segmentToStrip(seg, layout, strip, a, b)
          return { x: q.u, y: q.v }
        }
        for (let r0 = 0; r0 < H; r0 += BLOCK)
          for (let c0 = 0; c0 < W; c0 += BLOCK) {
            const w = Math.min(BLOCK, W - c0),
              h = Math.min(BLOCK, H - r0)
            const v = sampleMapped(bmp, toSource, c0, r0, w, h)
            const out = new Uint8Array(w * h)
            for (let k = 0; k < v.length; k++)
              if (Number.isFinite(v[k])) out[k] = Math.max(0, Math.min(255, Math.round(v[k])))
            await builder.addBlock({ col0: c0, row0: r0, width: w, height: h, data: out })
            emit?.('progress', [++done, total, `Segment ${seg.index + 1} of ${layout.segments.length}…`])
          }
        const { parts } = await builder.finish()
        blobs.push(new Blob(parts, { type: 'image/tiff' }))
      }
      emit?.('log', [
        `Panoramic: ${bmp.width}×${bmp.height} → ${pluralize(layout.segments.length, 'segment')} of ` +
          `${layout.segments[0].width}×${layout.segments[0].height} in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
        'info',
        'Fiducial',
      ])
      return { result: blobs }
    } finally {
      bmp.close()
    }
  }

  return {
    prepareFiducialTemplates,
    detectFiducials,
    detectFiducialSpots,
    detectReseau,
    growReseau,
    reseauOverlapScore,
    stitchReseauFrame,
    splitPanoramicStrip,
  }
}
