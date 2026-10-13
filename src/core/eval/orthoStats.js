// Orthophoto quality figures — pure. They travel with the ortho as its run record
// (`stats`) and are what the bench compares across ortho changes:
//   sharpness  mean Sobel gradient magnitude of luma, in grey levels per cell (a ramp
//              of one level per cell reads 1), over cells whose 3×3 is fully coloured.
//              Comparable between orthos at the SAME gsd only.
//   seams      over 4-neighbour pairs that both have a source label: the mean |ΔRGB|
//              across pairs whose labels differ (a seam) vs pairs from one image. A
//              ratio near 1 means the seams are invisible in colour; well above 1 means
//              colour steps. `seamDensity` (seam pairs per labelled cell) is the
//              fragmentation: salt-and-pepper source switching scores high.
//
// A large ortho is built and scored one block at a time (core/products/ortho.js
// orthorectifyTiled), so every sum here is an INTEGER: luma in thousandths of a grey
// level, the gradient in 2⁻¹⁶ grey levels, |ΔRGB| unscaled. Integer sums are exact in
// a double below 2⁵³ and so independent of the order the blocks arrive in — a tiled
// run reproduces the whole-image figures bit for bit. The gradient is the only
// rounding, at 1.5e-5 grey levels per cell.
import { NO_LABEL } from '../products/ortho.js'

const GRAD_SCALE = 65536 / 8000 // sqrt(gx² + gy²) in luma thousandths → 2⁻¹⁶ grey levels, incl. Sobel's /8

// Accumulates the figures over windows of a width × height ortho.
//   add(win): win = { rgba, labels?, x0, y0, w, h } a window of the ortho (global cell
//             coords, stride w) holding a CORE rect { cx0, cy0, cw, ch } plus at least
//             the one-cell ring around it wherever the ortho has one. Each cell must
//             be the core of exactly one add().
export function createOrthoStats(width, height, hasLabels = false) {
  let gradSum = 0, gradCells = 0
  let seamSum = 0, seamPairs = 0, inSum = 0, inPairs = 0, labelled = 0
  const used = new Set()
  let luma = new Int32Array(0)

  function add({ rgba, labels = null, x0, y0, w, h, cx0, cy0, cw, ch }) {
    const n = w * h
    if (luma.length < n) luma = new Int32Array(n)
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      luma[i] = rgba[o + 3] ? 299 * rgba[o] + 587 * rgba[o + 1] + 114 * rgba[o + 2] : -1
    }
    for (let gr = Math.max(1, cy0); gr < Math.min(height - 1, cy0 + ch); gr++) {
      for (let gc = Math.max(1, cx0); gc < Math.min(width - 1, cx0 + cw); gc++) {
        const i = (gr - y0) * w + (gc - x0)
        const a = luma[i - w - 1], b = luma[i - w], d = luma[i - w + 1]
        const e = luma[i - 1], m = luma[i], f = luma[i + 1]
        const g = luma[i + w - 1], k = luma[i + w], l = luma[i + w + 1]
        if ((a | b | d | e | m | f | g | k | l) < 0) continue // any uncoloured cell in the 3×3
        const gx = (d + 2 * f + l) - (a + 2 * e + g)
        const gy = (g + 2 * k + l) - (a + 2 * b + d)
        gradSum += Math.round(Math.sqrt(gx * gx + gy * gy) * GRAD_SCALE); gradCells++
      }
    }
    if (!labels || !hasLabels) return
    const step = (p, q) => Math.abs(rgba[4 * p] - rgba[4 * q]) + Math.abs(rgba[4 * p + 1] - rgba[4 * q + 1])
      + Math.abs(rgba[4 * p + 2] - rgba[4 * q + 2])
    const pair = (p, q) => {
      if (labels[q] === NO_LABEL) return
      if (labels[p] === labels[q]) { inSum += step(p, q); inPairs++ } else { seamSum += step(p, q); seamPairs++ }
    }
    for (let gr = cy0; gr < cy0 + ch; gr++) {
      for (let gc = cx0; gc < cx0 + cw; gc++) {
        const i = (gr - y0) * w + (gc - x0)
        if (labels[i] === NO_LABEL) continue
        labelled++
        used.add(labels[i])
        if (gc + 1 < width) pair(i, i + 1)
        if (gr + 1 < height) pair(i, i + w)
      }
    }
  }

  function finish() {
    const out = {
      sharpness: gradCells ? gradSum / 65536 / gradCells : null,
      sharpnessCells: gradCells,
      labelled: 0, sources: 0, seamPairs: 0, seamStep: null, interiorStep: null, seamRatio: null, seamDensity: null,
    }
    if (!hasLabels) return out
    out.labelled = labelled
    out.sources = used.size
    out.seamPairs = seamPairs
    out.seamStep = seamPairs ? seamSum / 3 / seamPairs : null
    out.interiorStep = inPairs ? inSum / 3 / inPairs : null
    out.seamRatio = out.seamStep != null && out.interiorStep ? out.seamStep / out.interiorStep : null
    out.seamDensity = labelled ? seamPairs / labelled : null
    return out
  }

  return { add, finish }
}

export function orthoStats(rgba, width, height, labels = null) {
  const acc = createOrthoStats(width, height, !!labels)
  acc.add({ rgba, labels, x0: 0, y0: 0, w: width, h: height, cx0: 0, cy0: 0, cw: width, ch: height })
  return acc.finish()
}

// One log line for the run record.
export function describeOrthoStats(s) {
  const f = (v, d = 2) => (v == null ? '—' : v.toFixed(d))
  const seams = s.labelled
    ? `; ${s.sources} source image(s), seams: step ${f(s.seamStep)} vs interior ${f(s.interiorStep)} `
      + `(×${f(s.seamRatio)}), ${f(100 * (s.seamDensity ?? 0), 1)} seam pairs per 100 cells`
    : ''
  return `sharpness ${f(s.sharpness)} grey levels/cell${seams}`
}
