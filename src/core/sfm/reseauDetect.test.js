import { describe, expect, it } from 'vitest'
import { reseauLattice, crossInWindow, fitLatticeAffine, nominalScanPosition } from './reseauDetect.js'

let seed = 5
const rnd = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296 }

// A textured window with an anti-aliased dark cross centred at (cx, cy) (pixel-edge coords).
function windowWithCross(W, H, cx, cy, { arm = 18, width = 1, contrast = 90, noise = 4, line = false } = {}) {
  const data = new Float32Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const tex = 128 + 30 * Math.sin(x / 7) * Math.cos(y / 11) + noise * (rnd() - 0.5) * 2
    // Coverage of the 1-px-wide bars at this pixel (box-filtered, so sub-pixel placement shows).
    const px = x + 0.5, py = y + 0.5
    const cover = (d) => Math.max(0, Math.min(1, width / 2 + 0.5 - Math.abs(d)))
    const h = Math.abs(px - cx) <= arm ? cover(py - cy) : 0
    const v = !line && Math.abs(py - cy) <= arm ? cover(px - cx) : 0
    data[y * W + x] = tex - contrast * Math.max(h, v)
  }
  return { data, width: W, height: H }
}

describe('crossInWindow', () => {
  it('finds a cross to a fraction of a pixel on texture', () => {
    for (const [cx, cy] of [[40.3, 41.7], [37.5, 44.2], [45.8, 38.1]]) {
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
    expect(nominalScanPosition({ xMm: 10, yMm: 10 }, { width: 16000, height: 8000, pitchMm: 0.028 }))
      .toEqual({ px: 8000 + 10 / 0.028, py: 4000 - 10 / 0.028 })
  })
  it('fits the placement that predicts the rest', () => {
    const truth = (x, y) => ({ px: 8000 + 35.71 * x - 0.12 * y + 12, py: 4000 - 0.1 * x - 35.7 * y - 7 })
    const found = [[0, 0], [10, 0], [0, 10], [-10, -10], [20, 5]].map(([x, y]) => ({ xMm: x, yMm: y, ...truth(x, y) }))
    const fit = fitLatticeAffine(found)
    const p = fit.predict(200, -100), t = truth(200, -100)
    expect(Math.hypot(p.px - t.px, p.py - t.py)).toBeLessThan(1e-6)
  })
})
