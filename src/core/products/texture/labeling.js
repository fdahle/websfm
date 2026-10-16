// One source view per face (plan-texture ▸ Pipeline 2). Pure.
//
// A Markov random field over the face adjacency: the data term prefers each face's
// best view, a Potts term charges `smoothness` per edge whose two faces chose
// differently (each such edge becomes a texture seam). Without the Potts term every
// face takes its own best view and the atlas becomes confetti — many tiny charts with
// a colour step at every edge. Solved by min-sum loopy belief propagation over each
// face's candidate list (Waechter et al. 2014 use the same model).
//
// Data term: 1 − score / (the face's best score), so 0 for the best view and towards 1
// for a view that sees the face at a fraction of the resolution. Relative per face, so
// the smoothness weight means the same on every mesh and scale.

import { TEXTURE_TUNING } from '../../tuning.js'

// cand: faceCandidates output (scores sorted best first). adj/rev: faceAdjacency.
// → Int32Array(F): the chosen view per face, −1 where no view sees it.
export function selectViews(cand, adj, rev, opts = {}) {
  const {
    smoothness = 0.5, iterations = TEXTURE_TUNING.bpIterations, damping = TEXTURE_TUNING.bpDamping,
  } = opts
  const { K, count, view, score } = cand
  const F = count.length
  const labels = new Int32Array(F).fill(-1)
  const D = new Float32Array(F * K)
  for (let f = 0; f < F; f++) {
    const n = count[f], base = f * K, best = score[base]
    for (let i = 0; i < n; i++) D[base + i] = 1 - score[base + i] / best
  }
  if (!(smoothness > 0) || iterations <= 0) {
    for (let f = 0; f < F; f++) if (count[f]) labels[f] = view[f * K]
    return labels
  }

  // For directed slot (f, k) towards g = adj[3f+k]: for each of g's candidates j, the
  // index of the same view in f's list (−1 if f lacks it).
  const map = new Int8Array(3 * F * K).fill(-1)
  for (let f = 0; f < F; f++) {
    const nf = count[f]
    if (!nf) continue
    for (let k = 0; k < 3; k++) {
      const g = adj[3 * f + k]
      if (g < 0 || !count[g]) continue
      const mb = (3 * f + k) * K
      for (let j = 0; j < count[g]; j++) {
        const vj = view[g * K + j]
        for (let i = 0; i < nf; i++) if (view[f * K + i] === vj) { map[mb + j] = i; break }
      }
    }
  }

  // msg[(3f + k)·K + i]: the message into f from its neighbour across edge k, aligned
  // with f's candidates. All zero to start.
  const msg = new Float32Array(3 * F * K)
  const h = new Float64Array(K), out = new Float64Array(K)
  const update = (f) => {
    const nf = count[f]
    if (!nf) return
    const base = f * K
    for (let i = 0; i < nf; i++) h[i] = D[base + i] + msg[(3 * f) * K + i] + msg[(3 * f + 1) * K + i] + msg[(3 * f + 2) * K + i]
    for (let k = 0; k < 3; k++) {
      const g = adj[3 * f + k]
      if (g < 0) continue
      const ng = count[g]
      if (!ng) continue
      const inb = (3 * f + k) * K
      // f's belief without what g told it.
      let minAll = Infinity
      for (let i = 0; i < nf; i++) { const v = h[i] - msg[inb + i]; if (v < minAll) minAll = v }
      const mb = (3 * f + k) * K
      let mn = Infinity
      for (let j = 0; j < ng; j++) {
        const i = map[mb + j]
        const same = i >= 0 ? h[i] - msg[inb + i] : Infinity
        const v = Math.min(minAll + smoothness, same)
        out[j] = v
        if (v < mn) mn = v
      }
      const ob = (3 * g + rev[3 * f + k]) * K
      for (let j = 0; j < ng; j++) msg[ob + j] = damping * msg[ob + j] + (1 - damping) * (out[j] - mn)
    }
  }
  // Alternate the sweep direction: information travels the whole way in one pass.
  for (let it = 0; it < iterations; it++) {
    if (it % 2 === 0) for (let f = 0; f < F; f++) update(f)
    else for (let f = F - 1; f >= 0; f--) update(f)
  }
  for (let f = 0; f < F; f++) {
    const nf = count[f]
    if (!nf) continue
    let best = 0, bv = Infinity
    for (let i = 0; i < nf; i++) {
      const v = D[f * K + i] + msg[(3 * f) * K + i] + msg[(3 * f + 1) * K + i] + msg[(3 * f + 2) * K + i]
      if (v < bv) { bv = v; best = i }
    }
    labels[f] = view[f * K + best]
  }
  return labels
}

// Absorb tiny charts into their neighbours (plan-texture T4). The Potts term keeps most
// of the surface on few photos, but noisy geometry (vegetation, the fallback faces of
// an occluded wall) still leaves confetti: thousands of charts of a few faces, each a
// seam all round and a padded rectangle in the atlas. A chart smaller than `minFaces`
// takes the photo most of its border edges lead to, when every one of its faces has that
// photo among its candidates; a few passes let merged charts merge on.
// labels (modified in place), adj, cand → the number of faces relabelled.
export function mergeSmallCharts(labels, adj, cand, { minFaces = TEXTURE_TUNING.minChartFaces, passes = 3 } = {}) {
  const { K, count, view } = cand
  const F = labels.length
  const has = (f, v) => { for (let i = 0; i < count[f]; i++) if (view[f * K + i] === v) return true; return false }
  let total = 0
  const chartOf = new Int32Array(F), stack = new Int32Array(F), members = []
  for (let pass = 0; pass < passes; pass++) {
    chartOf.fill(-1)
    let changed = 0, nCharts = 0
    for (let seed = 0; seed < F; seed++) {
      if (labels[seed] < 0 || chartOf[seed] >= 0) continue
      // Flood the chart of `seed`.
      const L = labels[seed], c = nCharts++
      let sp = 0
      members.length = 0
      stack[sp++] = seed; chartOf[seed] = c
      while (sp) {
        const f = stack[--sp]
        members.push(f)
        for (let k = 0; k < 3; k++) {
          const g = adj[3 * f + k]
          if (g >= 0 && chartOf[g] < 0 && labels[g] === L) { chartOf[g] = c; stack[sp++] = g }
        }
      }
      if (members.length >= minFaces) continue
      // Border edges by neighbouring label.
      const votes = new Map()
      for (const f of members) {
        for (let k = 0; k < 3; k++) {
          const g = adj[3 * f + k]
          if (g >= 0 && labels[g] >= 0 && labels[g] !== L) votes.set(labels[g], (votes.get(labels[g]) ?? 0) + 1)
        }
      }
      // All or nothing: moving only the faces that have the photo would split the
      // chart into new, smaller fragments (measured: more charts, not fewer).
      const ranked = [...votes].sort((a, b) => b[1] - a[1])
      for (const [v] of ranked) {
        if (!members.every((f) => has(f, v))) continue
        for (const f of members) labels[f] = v
        changed += members.length
        break
      }
    }
    total += changed
    if (!changed) break
  }
  return total
}
