import { describe, expect, it } from 'vitest'
import {
  reseauLattice,
  crossInWindow,
  fitLatticeAffine,
  nominalScanPosition,
  assignReseauIndices,
  pairReseauHalves,
  stitchedFrameGeometry,
} from './reseauDetect.js'

let seed = 5
const rnd = () => {
  seed = (1664525 * seed + 1013904223) >>> 0
  return seed / 4294967296
}

// A textured window with an anti-aliased dark cross centred at (cx, cy) (pixel-edge coords).
function windowWithCross(W, H, cx, cy, { arm = 18, width = 1, contrast = 90, noise = 4, line = false } = {}) {
  const data = new Float32Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const tex = 128 + 30 * Math.sin(x / 7) * Math.cos(y / 11) + noise * (rnd() - 0.5) * 2
      // Coverage of the 1-px-wide bars at this pixel (box-filtered, so sub-pixel placement shows).
      const px = x + 0.5,
        py = y + 0.5
      const cover = (d) => Math.max(0, Math.min(1, width / 2 + 0.5 - Math.abs(d)))
      const h = Math.abs(px - cx) <= arm ? cover(py - cy) : 0
      const v = !line && Math.abs(py - cy) <= arm ? cover(px - cx) : 0
      data[y * W + x] = tex - contrast * Math.max(h, v)
    }
  return { data, width: W, height: H }
}

describe('crossInWindow', () => {
  it('finds a cross to a fraction of a pixel on texture', () => {
    for (const [cx, cy] of [
      [40.3, 41.7],
      [37.5, 44.2],
      [45.8, 38.1],
    ]) {
      const r = crossInWindow(windowWithCross(84, 84, cx, cy), { armPx: 18, widthPx: 1 })
      expect(Math.hypot(r.x - cx, r.y - cy)).toBeLessThan(0.25)
    }
  })
  it('scores a lone dark line far below a cross', () => {
    const cross = crossInWindow(windowWithCross(84, 84, 42, 42), { armPx: 18 })
    const line = crossInWindow(windowWithCross(84, 84, 42, 42, { line: true }), { armPx: 18 })
    expect(line?.score ?? 0).toBeLessThan(0.3 * cross.score)
  })
})

describe('the lattice', () => {
  it('spans the film from the centre out, with shared slot ids', () => {
    const nodes = reseauLattice({ spacingMm: 10, filmWidthMm: 460, filmHeightMm: 230 })
    expect(nodes.length).toBe(47 * 23)
    expect(nodes.find((n) => n.id === 'r:-23:11')).toMatchObject({ xMm: -230, yMm: 110 })
    expect(nominalScanPosition({ xMm: 10, yMm: 10 }, { width: 16000, height: 8000, pitchMm: 0.028 })).toEqual({
      px: 8000 + 10 / 0.028,
      py: 4000 - 10 / 0.028,
    })
  })
  it('fits the placement that predicts the rest', () => {
    const truth = (x, y) => ({ px: 8000 + 35.71 * x - 0.12 * y + 12, py: 4000 - 0.1 * x - 35.7 * y - 7 })
    const found = [
      [0, 0],
      [10, 0],
      [0, 10],
      [-10, -10],
      [20, 5],
    ].map(([x, y]) => ({ xMm: x, yMm: y, ...truth(x, y) }))
    const fit = fitLatticeAffine(found)
    const p = fit.predict(200, -100),
      t = truth(200, -100)
    expect(Math.hypot(p.px - t.px, p.py - t.py)).toBeLessThan(1e-6)
  })
})

describe('half-frame scans', () => {
  // A left half: columns −23 … +2 seen, all 23 rows; steps relative to a first cross at (−5, 3).
  const left = []
  for (let i = -23; i <= 2; i++)
    for (let j = -11; j <= 11; j++) left.push({ di: i + 5, dj: 3 - j, px: 0, py: 0, score: 1 })
  it('indexes a left half from its outer edge and centres its rows', () => {
    const r = assignReseauIndices(left, { side: 'left', ni: 23, nj: 11 })
    expect(r.rows).toBe(23)
    expect(r.columns).toBe(26)
    const ids = new Set(r.detections.map((d) => d.slot))
    expect(ids.has('r:-23:11')).toBe(true)
    expect(ids.has('r:2:-11')).toBe(true)
    expect(
      assignReseauIndices(left, { side: 'left', ni: 23, nj: 11, shift: 1 }).detections.some(
        (d) => d.slot === 'r:-23:0',
      ),
    ).toBe(false)
  })
  it('indexes a right half from its outer edge', () => {
    const right = []
    for (let i = -2; i <= 23; i++)
      for (let j = -11; j <= 11; j++) right.push({ di: i - 7, dj: -j, px: 0, py: 0, score: 1 })
    const r = assignReseauIndices(right, { side: 'right', ni: 23, nj: 11 })
    expect(Math.min(...r.detections.map((d) => d.i))).toBe(-2)
    expect(Math.max(...r.detections.map((d) => d.i))).toBe(23)
  })
  it('pairs _a / _b scans by name', () => {
    const imgs = ['L004_a.tif', 'L004_b.tif', 'L005-A.TIF', 'L005-B.TIF', 'L006_a.tif', 'other.tif'].map(
      (name, id) => ({ id, name }),
    )
    expect(pairReseauHalves(imgs).map((p) => [p.stem, p.a.name, p.b.name])).toEqual([
      ['L004', 'L004_a.tif', 'L004_b.tif'],
      ['L005', 'L005-A.TIF', 'L005-B.TIF'],
    ])
  })
  it('lays the stitched frame on the film grid, principal point in pixel-centre terms', () => {
    const g = stitchedFrameGeometry({
      spacingMm: 10,
      filmWidthMm: 460,
      filmHeightMm: 230,
      pitchMm: 0.028,
      marginMm: 2,
      ppxMm: 0.02,
      ppyMm: -0.03,
    })
    expect(g.width * g.pitchMm).toBeGreaterThanOrEqual(464)
    expect(g.x0Mm).toBeCloseTo((-g.width / 2) * 0.028)
    expect(g.cx).toBeCloseTo(g.width / 2 + 0.02 / 0.028 - 0.5)
    expect(g.cy).toBeCloseTo(g.height / 2 + 0.03 / 0.028 - 0.5)
  })
})
