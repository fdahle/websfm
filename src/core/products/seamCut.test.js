import { describe, it, expect } from 'vitest'
import { createGridGraph, gridNode, gridMaxflow, inSinkSet, resetGridGraph } from './gridMaxflow.js'
import { seamGrid, createSeamSurvey, addSeamCandidate, solveSeams, NO_LABEL } from './seamCut.js'

let seed = 11
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647

describe('gridMaxflow', () => {
  // Brute force: the cheapest of all 2^n source/sink assignments.
  function bruteMinCut(w, h, edges, tr) {
    const n = w * h
    let best = Infinity
    for (let mask = 0; mask < 1 << n; mask++) {
      let cost = 0
      for (let i = 0; i < n; i++) {
        const sink = (mask >> i) & 1
        if (tr[i] > 0 && sink) cost += tr[i]
        if (tr[i] < 0 && !sink) cost -= tr[i]
      }
      for (const [a, b, c] of edges) if (!((mask >> a) & 1) && ((mask >> b) & 1)) cost += c
      best = Math.min(best, cost)
    }
    return best
  }
  it.each([[3, 3], [4, 3], [2, 5], [4, 4], [1, 6]])('equals the brute-force minimum cut on random %ix%i grids', (w, h) => {
    for (let trial = 0; trial < 25; trial++) {
      const g = createGridGraph(w, h), edges = [], tr = []
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        const i = r * w + c, t = Math.round(rand() * 20 - 10)
        tr.push(t); g.tr[gridNode(g, c, r)] = t
        const nb = [[c + 1, r, 0], [c - 1, r, 1], [c, r + 1, 2], [c, r - 1, 3]]
        for (const [qc, qr, d] of nb) {
          if (qc < 0 || qr < 0 || qc >= w || qr >= h || rand() < 0.2) continue
          const cap = Math.round(rand() * 8)
          g.cap[4 * gridNode(g, c, r) + d] = cap
          edges.push([i, qr * w + qc, cap])
        }
      }
      const flow = gridMaxflow(g)
      // The flow plus the terminal constants equals the cut; check the cut the sets give.
      let cut = 0
      const sink = (i) => inSinkSet(g, gridNode(g, i % w, Math.floor(i / w)))
      for (let i = 0; i < w * h; i++) { if (tr[i] > 0 && sink(i)) cut += tr[i]; if (tr[i] < 0 && !sink(i)) cut -= tr[i] }
      for (const [a, b, c] of edges) if (!sink(a) && sink(b)) cut += c
      const best = bruteMinCut(w, h, edges, tr)
      expect(cut).toBe(best)
      expect(flow).toBe(best)
    }
  })
  it('reuses a larger graph for a smaller problem in its corner', () => {
    const g = createGridGraph(6, 5)
    // A first problem over the whole graph leaves trees, flows and capacities behind …
    for (let i = 0; i < g.n; i++) g.tr[i] = 0
    for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) {
      g.tr[gridNode(g, c, r)] = (c + r) % 3 - 1
      for (let d = 0; d < 4; d++) {
        const qc = c + [1, -1, 0, 0][d], qr = r + [0, 0, 1, -1][d]
        if (qc >= 0 && qr >= 0 && qc < 6 && qr < 5) g.cap[4 * gridNode(g, c, r) + d] = 2
      }
    }
    gridMaxflow(g)
    // … which must not leak into a 2 × 2 one: source → a → b → sink, cut at a → b (1).
    resetGridGraph(g, 2, 2)
    g.tr[gridNode(g, 0, 0)] = 5; g.tr[gridNode(g, 1, 0)] = -5
    g.cap[4 * gridNode(g, 0, 0)] = 1
    expect(gridMaxflow(g)).toBe(1)
    expect(inSinkSet(g, gridNode(g, 0, 0))).toBe(false)
    expect(inSinkSet(g, gridNode(g, 1, 0))).toBe(true)
  })
})

describe('seam survey', () => {
  it('sizes the coarse grid to the target', () => {
    expect(seamGrid(1000, 1000, 1 << 20)).toEqual({ f: 1, cw: 1000, ch: 1000 })
    const g = seamGrid(10843, 17973, 1 << 20)
    expect(g.f).toBe(14)
    expect(g.cw * g.ch).toBeLessThanOrEqual(1 << 20)
  })
  it('keeps the K most nadir views, sorted, ties in arrival order', () => {
    const sv = createSeamSurvey({ f: 1, cw: 1, ch: 1 }, 3)
    addSeamCandidate(sv, 0, 0, 5, 1, 1, 1)
    addSeamCandidate(sv, 0, 1, 2, 2, 2, 2)
    addSeamCandidate(sv, 0, 2, 5, 3, 3, 3)
    addSeamCandidate(sv, 0, 3, 9, 4, 4, 4) // worse than all three: dropped
    addSeamCandidate(sv, 0, 4, 1, 5, 5, 5) // best: pushes the last out
    expect(sv.count[0]).toBe(3)
    expect([...sv.img]).toEqual([4, 1, 0])
    expect([...sv.score]).toEqual([1, 2, 5])
    expect([...sv.rgb]).toEqual([5, 5, 5, 2, 2, 2, 1, 1, 1])
  })
})

describe('solveSeams', () => {
  // Two photos over a w × h strip, photo 0 most nadir on the left half, photo 1 on the
  // right (footprint grows with the distance from each nadir point). Both see the same
  // ground colour except on a "building" straddling the middle, which photo 1 shows
  // displaced (another colour there).
  function strip(w, h, building) {
    const sv = createSeamSurvey({ f: 1, cw: w, ch: h }, 4)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const p = r * w + c, x = (c + 0.5) / w
      const inB = building && c >= building[0] && c < building[1] && r >= building[2] && r < building[3]
      addSeamCandidate(sv, p, 0, 1 + 0.2 * x * x, 100, 100, 100)
      addSeamCandidate(sv, p, 1, 1 + 0.2 * (1 - x) * (1 - x), inB ? 200 : 100, inB ? 60 : 100, 100)
    }
    return sv
  }
  it('keeps the nadir partition where the photos agree', () => {
    const w = 20, h = 6, { labels, summary } = solveSeams(strip(w, h, null))
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) expect(labels[r * w + c]).toBe(c < w / 2 ? 0 : 1)
    expect(summary.changedCells).toBe(0)
    expect(summary.energy).toBe(summary.energyNadir)
  })
  it('routes the seam around a building the two photos disagree on', () => {
    const w = 40, h = 30, B = [16, 23, 10, 20]
    const sv = strip(w, h, B)
    const { labels, summary } = solveSeams(sv)
    expect(summary.energy).toBeLessThan(summary.energyNadir)
    expect(summary.changedCells).toBeGreaterThan(0)
    // The building comes from one photo only, and the seam never crosses it.
    const inside = new Set()
    for (let r = B[2]; r < B[3]; r++) for (let c = B[0]; c < B[1]; c++) inside.add(labels[r * w + c])
    expect(inside.size).toBe(1)
    // Far from the building the nadir partition stands.
    for (let r = 0; r < 4; r++) for (let c = 0; c < w; c++) if (Math.abs(c - w / 2) > 2) expect(labels[r * w + c]).toBe(c < w / 2 ? 0 : 1)
  })
  it('only labels a cell with a view that sees it, and leaves unseen cells unlabelled', () => {
    const w = 12, h = 8, sv = createSeamSurvey({ f: 1, cw: w, ch: h }, 4)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const p = r * w + c
      if (c === 0 && r === 0) continue // no view
      if (c < 8) addSeamCandidate(sv, p, 0, 1 + c / 20, 90, 90, 90)
      if (c > 3) addSeamCandidate(sv, p, 1, 1 + (w - c) / 20, 120, 80, 90)
    }
    const { labels } = solveSeams(sv)
    expect(labels[0]).toBe(NO_LABEL)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      if (!c && !r) continue
      const l = labels[r * w + c]
      if (c < 4) expect(l).toBe(0)
      if (c >= 8) expect(l).toBe(1)
    }
  })
  it('prices seams on the balanced colours', () => {
    // Photo 1 is 2× darker everywhere: unbalanced, every cell is a "difference"; with
    // gains that undo it the nadir partition is kept.
    const w = 16, h = 4, sv = createSeamSurvey({ f: 1, cw: w, ch: h }, 4)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const p = r * w + c, x = (c + 0.5) / w
      addSeamCandidate(sv, p, 0, 1 + 0.2 * x * x, 160, 160, 160)
      addSeamCandidate(sv, p, 1, 1 + 0.2 * (1 - x) * (1 - x), 117, 117, 117) // ≈ 0.5× in linear light
    }
    const { summary } = solveSeams(sv, Float64Array.from([1, 1, 1, 2, 2, 2]))
    expect(summary.changedCells).toBe(0)
  })
})
