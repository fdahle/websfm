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
import { NO_LABEL } from '../products/ortho.js'

export function orthoStats(rgba, width, height, labels = null) {
  const n = width * height
  const luma = new Float32Array(n)
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    luma[i] = rgba[o + 3] ? 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2] : NaN
  }
  let gradSum = 0, gradCells = 0
  for (let r = 1; r < height - 1; r++) {
    for (let c = 1; c < width - 1; c++) {
      const i = r * width + c
      const a = luma[i - width - 1], b = luma[i - width], d = luma[i - width + 1]
      const e = luma[i - 1], f = luma[i + 1]
      const g = luma[i + width - 1], h = luma[i + width], k = luma[i + width + 1]
      const gx = (d + 2 * f + k) - (a + 2 * e + g)
      const gy = (g + 2 * h + k) - (a + 2 * b + d)
      const m = Math.sqrt(gx * gx + gy * gy) / 8
      if (Number.isNaN(m) || Number.isNaN(luma[i])) continue // any uncoloured neighbour
      gradSum += m; gradCells++
    }
  }
  const out = {
    sharpness: gradCells ? gradSum / gradCells : null,
    sharpnessCells: gradCells,
    labelled: 0, sources: 0, seamPairs: 0, seamStep: null, interiorStep: null, seamRatio: null, seamDensity: null,
  }
  if (!labels) return out

  const used = new Set()
  let seamSum = 0, seamPairs = 0, inSum = 0, inPairs = 0, labelled = 0
  const step = (p, q) => (Math.abs(rgba[4 * p] - rgba[4 * q]) + Math.abs(rgba[4 * p + 1] - rgba[4 * q + 1])
    + Math.abs(rgba[4 * p + 2] - rgba[4 * q + 2])) / 3
  const pair = (p, q) => {
    if (labels[q] === NO_LABEL) return
    if (labels[p] === labels[q]) { inSum += step(p, q); inPairs++ } else { seamSum += step(p, q); seamPairs++ }
  }
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * width + c
      if (labels[i] === NO_LABEL) continue
      labelled++
      used.add(labels[i])
      if (c + 1 < width) pair(i, i + 1)
      if (r + 1 < height) pair(i, i + width)
    }
  }
  out.labelled = labelled
  out.sources = used.size
  out.seamPairs = seamPairs
  out.seamStep = seamPairs ? seamSum / seamPairs : null
  out.interiorStep = inPairs ? inSum / inPairs : null
  out.seamRatio = out.seamStep != null && out.interiorStep ? out.seamStep / out.interiorStep : null
  out.seamDensity = labelled ? seamPairs / labelled : null
  return out
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
