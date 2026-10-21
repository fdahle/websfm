// Graph-cut seamlines for the mosaicked orthophoto (plan O5). Pure.
//
// The nearest-nadir partition puts every seam halfway between two photos' nadir
// points, whatever lies there: a seam through a roof shows the roof leaning one way on
// one side and the other way on the other, a seam through a tree cuts it in two
// shapes. Here the label map is chosen by energy minimisation instead (Kwatra et al.
// 2003, "Graphcut textures"; Agarwala et al. 2004, "Interactive digital photomontage"):
//
//   E(labels) = Σ_cells D_p(l_p) + Σ_neighbours V_pq(l_p, l_q)
//
//   D_p(l)  the data cost: DATA_WEIGHT · (s_l / s_best − 1), s the foreshortened
//           footprint depth / (f·cos²θ) the nearest-nadir label minimises (ortho.js
//           labelFromMap), so the most nadir view costs 0 and a view only a little
//           less nadir costs little. A view that does not see the cell (occlusion
//           test, cost gate) is not a candidate at all.
//   V_pq(a, b)  the seam cost between neighbours p, q labelled a ≠ b: SEAM_STEP plus
//           the colour difference of the two photos at both cells, Σ|ΔRGB| in sRGB
//           levels after the gains. Where two photos agree (flat ground, well-aligned)
//           a seam is cheap; through a building or a tree, whose relief displacement
//           and parallax differ between the photos, it is expensive. Where one of the
//           two photos does not see a cell its colour there is unknown: UNKNOWN_DIFF.
//
// The minimum is approximated by alpha-expansion (Boykov, Veksler & Zabih 2001): for
// each label α in turn, a binary min cut decides which cells switch to α, over only
// the cells where α is a candidate. Moves that the truncation of a non-metric V
// (Rother et al. 2005) would make worse are rejected, so the energy never rises.
//
// Memory and determinism. A min cut is a global problem, so it cannot be solved
// block by block and still let blocks join. It is solved once for the whole ortho on
// a coarse grid (SEAM_CUT_CELLS cells, ~1 M: every f-th cell, a few MB of labels),
// before the blocks, from one more read of every photo (decoded coarse) — the pass the
// gain fit already makes. Each block then reads its labels from that grid, cell by
// cell, so the labels do not depend on the block layout. Seams therefore run on the
// coarse grid's cell edges (steps of f ortho cells); the seam blending hides the steps.
// The expansion order is fixed (ascending label, cycles until nothing changes, at most
// MAX_CYCLES) and the capacities are integers, so the result is deterministic.
import { createGridGraph, gridNode, gridMaxflow, inSinkSet, resetGridGraph } from './gridMaxflow.js'
import { srgbToLinear, linearToSrgb } from './colourGains.js'

export const SEAM_CUT_CELLS = 1 << 20 // target size of the coarse label grid
export const SEAM_CANDIDATES = 8 // views kept per coarse cell (the most nadir)
const DATA_WEIGHT = 600 // levels (Σ|ΔRGB|) per unit of relative footprint increase
const SEAM_STEP = 6 // levels per seam edge, so seams stay short where colours agree
const UNKNOWN_DIFF = 150 // levels for a photo's colour at a cell it does not see
const MAX_CYCLES = 4
export const NO_LABEL = 0xffff

// The coarse grid over a W × H ortho: every f-th cell, f ≥ 1 the smallest factor that
// keeps it within `target` cells. Coarse cell (i, j) covers ortho cells
// [i·f, (i+1)·f) × [j·f, (j+1)·f) and is sampled at its centre cell (clamped).
export function seamGrid(W, H, target = SEAM_CUT_CELLS) {
  const f = Math.max(1, Math.ceil(Math.sqrt((W * H) / target)))
  return { f, cw: Math.ceil(W / f), ch: Math.ceil(H / f) }
}
export const seamSampleCol = ({ f }, i, W) => Math.min(W - 1, i * f + (f >> 1))

// The per-cell candidates: up to K views, sorted by footprint (ties keep the lower
// image index: maps are offered in ascending order), each with its sRGB colour.
export function createSeamSurvey({ f, cw, ch }, K = SEAM_CANDIDATES) {
  const n = cw * ch
  return {
    f,
    cw,
    ch,
    K,
    count: new Uint8Array(n),
    img: new Uint16Array(n * K),
    score: new Float32Array(n * K),
    rgb: new Uint8Array(n * K * 3),
  }
}

export function addSeamCandidate(sv, p, mi, s, r, g, b) {
  const { K, count, img, score, rgb } = sv
  const base = p * K
  let k = count[p]
  if (k === K) {
    if (!(s < score[base + K - 1])) return
    k = K - 1
  } else count[p]++
  // Insertion: shift the worse ones down one slot.
  while (k > 0 && score[base + k - 1] > s) {
    img[base + k] = img[base + k - 1]
    score[base + k] = score[base + k - 1]
    const o = 3 * (base + k)
    rgb[o] = rgb[o - 3]
    rgb[o + 1] = rgb[o - 2]
    rgb[o + 2] = rgb[o - 1]
    k--
  }
  img[base + k] = mi
  score[base + k] = s
  const o = 3 * (base + k)
  rgb[o] = r
  rgb[o + 1] = g
  rgb[o + 2] = b
}

// Solve the labels. `gains` (3 per image, linear light, or null) are applied to the
// candidate colours first, so a seam is priced on the colours the mosaic will show.
// → { labels: Uint16Array(cw·ch) (NO_LABEL where no view sees the cell), summary }
export function solveSeams(sv, gains = null, weights = {}) {
  const { cw, ch, K, count, img, score, rgb } = sv
  const dataW = weights.data ?? DATA_WEIGHT,
    step = weights.step ?? SEAM_STEP,
    unknown = weights.unknown ?? UNKNOWN_DIFF
  const n = cw * ch
  if (gains) {
    for (let p = 0; p < n; p++)
      for (let k = 0; k < count[p]; k++) {
        const s = p * K + k,
          mi = img[s]
        for (let c = 0; c < 3; c++) rgb[3 * s + c] = linearToSrgb(gains[3 * mi + c] * srgbToLinear(rgb[3 * s + c]))
      }
  }
  // Integer data costs per candidate slot.
  const data = new Int32Array(n * K)
  for (let p = 0; p < n; p++) {
    const s0 = score[p * K]
    for (let k = 1; k < count[p]; k++) data[p * K + k] = Math.round(dataW * (score[p * K + k] / s0 - 1))
  }
  const slotOf = (p, l) => {
    const b = p * K,
      e = b + count[p]
    for (let s = b; s < e; s++) if (img[s] === l) return s
    return -1
  }
  // Colour difference of views a and b at cell x (candidate slots sa, sb).
  const diff = (sa, sb) => {
    if (sa < 0 || sb < 0) return unknown
    const oa = 3 * sa,
      ob = 3 * sb
    return Math.abs(rgb[oa] - rgb[ob]) + Math.abs(rgb[oa + 1] - rgb[ob + 1]) + Math.abs(rgb[oa + 2] - rgb[ob + 2])
  }
  const V = (p, q, a, b) => {
    if (a === b || a === NO_LABEL || b === NO_LABEL) return 0
    return step + diff(slotOf(p, a), slotOf(p, b)) + diff(slotOf(q, a), slotOf(q, b))
  }
  const D = (p, l) => data[slotOf(p, l)]

  const labels = new Uint16Array(n).fill(NO_LABEL)
  let nLabels = 0
  for (let p = 0; p < n; p++) {
    if (count[p]) labels[p] = img[p * K]
    for (let k = 0; k < count[p]; k++) nLabels = Math.max(nLabels, img[p * K + k] + 1)
  }
  const init = labels.slice()
  // Each label's candidate bounding box.
  const box = new Int32Array(4 * nLabels)
  for (let l = 0; l < nLabels; l++) box.set([cw, ch, -1, -1], 4 * l)
  for (let r = 0, p = 0; r < ch; r++)
    for (let c = 0; c < cw; c++, p++) {
      for (let k = 0; k < count[p]; k++) {
        const b = 4 * img[p * K + k]
        if (c < box[b]) box[b] = c
        if (r < box[b + 1]) box[b + 1] = r
        if (c > box[b + 2]) box[b + 2] = c
        if (r > box[b + 3]) box[b + 3] = r
      }
    }
  const energy = () => {
    let e = 0
    for (let r = 0, p = 0; r < ch; r++)
      for (let c = 0; c < cw; c++, p++) {
        if (labels[p] === NO_LABEL) continue
        e += D(p, labels[p])
        if (c + 1 < cw) e += V(p, p + 1, labels[p], labels[p + 1])
        if (r + 1 < ch) e += V(p, p + cw, labels[p], labels[p + cw])
      }
    return e
  }
  const e0 = energy()

  // One graph, sized for the largest box, reused by every expansion.
  let gw = 0,
    gh = 0
  for (let l = 0; l < nLabels; l++)
    if (box[4 * l + 2] >= 0) {
      gw = Math.max(gw, box[4 * l + 2] - box[4 * l] + 1)
      gh = Math.max(gh, box[4 * l + 3] - box[4 * l + 1] + 1)
    }
  // The box lies in the graph's top-left corner; the rest of the graph stays isolated.
  const g = gw ? createGridGraph(gw, gh) : null
  const isVar = new Uint8Array(n),
    changed = new Int32Array(n),
    oldLab = new Uint16Array(n)
  let accepted = 0,
    rejected = 0,
    cycles = 0,
    maxflows = 0
  for (; cycles < MAX_CYCLES; cycles++) {
    let moved = false
    for (let a = 0; a < nLabels; a++) {
      const x0 = box[4 * a],
        y0 = box[4 * a + 1],
        x1 = box[4 * a + 2],
        y1 = box[4 * a + 3]
      if (x1 < 0) continue
      let nVar = 0
      for (let r = y0; r <= y1; r++)
        for (let c = x0; c <= x1; c++) {
          const p = r * cw + c
          const v = labels[p] !== a && slotOf(p, a) >= 0
          isVar[p] = v ? 1 : 0
          if (v) nVar++
        }
      if (!nVar) continue
      resetGridGraph(g, x1 - x0 + 1, y1 - y0 + 1)
      const { cap, tr } = g
      for (let r = y0; r <= y1; r++)
        for (let c = x0; c <= x1; c++) {
          const p = r * cw + c
          if (!isVar[p]) continue
          const fp = labels[p],
            i = gridNode(g, c - x0, r - y0)
          let t = D(p, a) - D(p, fp) // E(1) − E(0): source minus sink
          // Right and down neighbours pair with p here; left and up ones, where they are
          // variables too, already paired with p as their right / down neighbour.
          for (let d = 0; d < 4; d++) {
            const qc = c + (d === 0 ? 1 : d === 1 ? -1 : 0),
              qr = r + (d === 2 ? 1 : d === 3 ? -1 : 0)
            if (qc < 0 || qr < 0 || qc >= cw || qr >= ch) continue
            const q = qr * cw + qc,
              fq = labels[q]
            const qVar = qc >= x0 && qc <= x1 && qr >= y0 && qr <= y1 && isVar[q]
            if (!qVar) {
              t += V(p, q, a, fq) - V(p, q, fp, fq)
              continue
            }
            if (d === 1 || d === 3) continue
            // E(x_p, x_q): A = E(0,0), B = E(0,1), C = E(1,0), D = E(1,1) = 0.
            let A = V(p, q, fp, fq)
            const B = V(p, q, fp, a),
              C = V(p, q, a, fq)
            if (A > B + C) A = B + C // not submodular here: truncate (checked below)
            t += C - A
            tr[gridNode(g, qc - x0, qr - y0)] -= C
            cap[4 * i + d] += B + C - A
          }
          tr[i] += t
        }
      gridMaxflow(g)
      maxflows++
      // Apply the move, then keep it only if the true energy fell.
      let nCh = 0,
        dE = 0
      for (let r = y0; r <= y1; r++)
        for (let c = x0; c <= x1; c++) {
          const p = r * cw + c
          if (!isVar[p] || !inSinkSet(g, gridNode(g, c - x0, r - y0))) continue
          changed[nCh++] = p
          oldLab[p] = labels[p]
        }
      for (let k = 0; k < nCh; k++) {
        const p = changed[k]
        dE += D(p, a) - D(p, oldLab[p])
        labels[p] = a
      }
      for (let k = 0; k < nCh; k++) {
        const p = changed[k],
          c = p % cw,
          r = (p - c) / cw
        for (let d = 0; d < 4; d++) {
          const qc = c + (d === 0 ? 1 : d === 1 ? -1 : 0),
            qr = r + (d === 2 ? 1 : d === 3 ? -1 : 0)
          if (qc < 0 || qr < 0 || qc >= cw || qr >= ch) continue
          const q = qr * cw + qc
          const qChanged = labels[q] === a && isVar[q] && qc >= x0 && qc <= x1 && qr >= y0 && qr <= y1
          if (qChanged && q < p) continue // counted from q
          const oq = qChanged ? oldLab[q] : labels[q]
          dE += V(p, q, a, labels[q]) - V(p, q, oldLab[p], oq)
        }
      }
      if (nCh && dE < 0) {
        accepted++
        moved = true
      } else {
        if (nCh) rejected++
        for (let k = 0; k < nCh; k++) labels[changed[k]] = oldLab[changed[k]]
      }
      for (let r = y0; r <= y1; r++) isVar.fill(0, r * cw + x0, r * cw + x1 + 1)
    }
    if (!moved) {
      cycles++
      break
    }
  }
  let differ = 0,
    labelled = 0
  for (let p = 0; p < n; p++)
    if (labels[p] !== NO_LABEL) {
      labelled++
      if (labels[p] !== init[p]) differ++
    }
  return {
    labels,
    summary: {
      factor: sv.f,
      width: cw,
      height: ch,
      labelled,
      cycles,
      maxflows,
      accepted,
      rejected,
      energyNadir: e0,
      energy: energy(),
      changedCells: differ,
    },
  }
}
