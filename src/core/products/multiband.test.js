import { describe, it, expect } from 'vitest'
import { createMultiband, multibandBegin, multibandAdd, multibandFinish, multibandReach } from './multiband.js'

const NONE = 0xffff

// A w × h window split into labels by `labelOf(c, r)`, label j showing the constant
// linear colour colour[j]; blend with the given levels and return the red channel.
function blend(w, h, labelOf, colour, levels) {
  const n = w * h, labels = new Uint16Array(n), base = new Float32Array(4 * n)
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c, l = labelOf(c, r)
    labels[i] = l
    if (l !== NONE) base[4 * i] = base[4 * i + 1] = base[4 * i + 2] = colour[l]
  }
  const mb = createMultiband(w, h, levels)
  multibandBegin(mb, w, h, labels, NONE)
  const { ring } = multibandReach(levels)
  for (let j = 0; j < colour.length; j++) {
    // Every photo sees the whole window here: its ring is the cells within `ring`
    // (Chebyshev) of its region; the box is the whole window.
    const d = new Float32Array(3 * n)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const i = r * w + c
      if (labels[i] === j || labels[i] === NONE) continue
      let near = false
      for (let dr = -ring; dr <= ring && !near; dr++) for (let dc = -ring; dc <= ring; dc++) {
        const rr = r + dr, cc = c + dc
        if (rr >= 0 && cc >= 0 && rr < h && cc < w && labels[rr * w + cc] === j) { near = true; break }
      }
      if (near) d[3 * i] = d[3 * i + 1] = d[3 * i + 2] = colour[j] - base[4 * i]
    }
    multibandAdd(mb, 0, 0, w, h, d, labels, j)
  }
  multibandFinish(mb, base)
  return Array.from({ length: n }, (_, i) => base[4 * i])
}

describe('multiband blending', () => {
  it('leaves a single photo exactly as it is', () => {
    const w = 37, h = 21
    const out = blend(w, h, (c, r) => (c + r) % 11 === 0 ? NONE : 0, [0.4], 3)
    for (let i = 0; i < w * h; i++) if (out[i]) expect(out[i]).toBeCloseTo(0.4, 6)
  })

  it('fades a step across the seam over ~2^levels cells, and leaves the far sides alone', () => {
    const w = 96, h = 8, levels = 3
    const out = blend(w, h, (c) => (c < w / 2 ? 0 : 1), [0.2, 0.8], levels)
    const row = out.slice(4 * w, 5 * w)
    for (let c = 1; c < w; c++) expect(row[c]).toBeGreaterThanOrEqual(row[c - 1] - 1e-6)
    // Symmetric about the seam, and half-way at it.
    expect((row[w / 2 - 1] + row[w / 2]) / 2).toBeCloseTo(0.5, 2)
    // Within one cell of the seam the colours already mix …
    expect(row[w / 2 - 1]).toBeGreaterThan(0.3)
    // … and 3·2^levels cells away they are the photos' own.
    expect(row[w / 2 - 3 * 2 ** levels - 1]).toBeCloseTo(0.2, 3)
    expect(row[w / 2 + 3 * 2 ** levels]).toBeCloseTo(0.8, 3)
    expect(row[0]).toBeCloseTo(0.2, 6)
    expect(row[w - 1]).toBeCloseTo(0.8, 6)
  })

  it('is not darkened at the edge of the data (normalised by the labelled cells)', () => {
    const w = 64, h = 20, levels = 3
    // Unlabelled cells on the right third; the two photos agree.
    const out = blend(w, h, (c) => (c >= 44 ? NONE : c < 22 ? 0 : 1), [0.5, 0.5], levels)
    for (let r = 0; r < h; r++) for (let c = 0; c < 44; c++) expect(out[r * w + c]).toBeCloseTo(0.5, 5)
  })
})
