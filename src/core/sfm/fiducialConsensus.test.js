import { describe, expect, it } from 'vitest'
import { fiducialBatchConsensus, fiducialShapeCheck } from './fiducialConsensus.js'

// One scan: marks at the four mid-sides of a 10000×10000 film frame inset in an
// 11000×11000 scan. `shift` moves the whole scan on the platen (the frame moves
// with it); `bad` displaces one slot, the way a data-strip blob captures a mark.
function scan(id, { shift = 0, jitter = 0, bad = null } = {}) {
  const inset = 500 + shift, size = 10000
  const j = (k) => (jitter ? ((id.charCodeAt(0) * 37 + k * 91) % 100) / 100 * jitter - jitter / 2 : 0)
  const marks = {
    'side-left': [inset - 300, inset + size / 2],
    'side-right': [inset + size + 300, inset + size / 2],
    'side-top': [inset + size / 2, inset - 300],
    'side-bottom': [inset + size / 2, inset + size + 300],
  }
  const accepted = Object.entries(marks).map(([slot, [px, py]], k) => ({
    slot,
    px: px + j(k) + (bad?.slot === slot ? bad.dx ?? 0 : 0),
    py: py + j(k + 7) + (bad?.slot === slot ? bad.dy ?? 0 : 0),
  }))
  return {
    id, name: `${id}.tif`, accepted,
    frame: { left: inset, right: inset + size, top: inset, bottom: inset + size },
    natW: 11000, natH: 11000,
  }
}

describe('fiducialBatchConsensus', () => {
  it('flags the one mark that disagrees with the flight, and only that one', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => scan(id))
    rows[2] = scan('c', { bad: { slot: 'side-left', dx: 600, dy: -400 } })
    const { outliers, basis } = fiducialBatchConsensus(rows)
    expect(basis).toBe('frame')
    expect(outliers).toHaveLength(1)
    expect(outliers[0]).toMatchObject({ imageId: 'c', slot: 'side-left' })
    expect(outliers[0].distPx).toBeGreaterThan(700)
    expect(outliers[0].tolPx).toBeLessThan(outliers[0].distPx)
  })

  it('accepts a consistently noisy batch — the tolerance follows its own spread', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => scan(id, { jitter: 60 }))
    expect(fiducialBatchConsensus(rows).outliers).toEqual([])
  })

  // Frame-relative, not raster-relative: a scan sitting 400 px off on the platen
  // moves every mark with it. Comparing raw pixels would flag the whole image.
  it('is immune to the scan sitting elsewhere on the platen', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => scan(id, { shift: i * 120 }))
    const out = fiducialBatchConsensus(rows)
    expect(out.basis).toBe('frame')
    expect(out.outliers).toEqual([])
  })

  it('says nothing on a batch too small for the median to be evidence', () => {
    const rows = [scan('a'), scan('b'), scan('c', { bad: { slot: 'side-left', dx: 900 } })]
    expect(fiducialBatchConsensus(rows).outliers).toEqual([])
  })

  // A slot only a couple of images found is not checked, even when the batch is
  // large — three marks cannot outvote anything.
  it('skips a slot too few images found, while still checking the others', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => scan(id))
    for (const r of rows.slice(2)) r.accepted = r.accepted.filter((d) => d.slot !== 'side-top')
    rows[0].accepted.find((d) => d.slot === 'side-top').px += 900
    const { perSlot, outliers } = fiducialBatchConsensus(rows)
    expect(perSlot.find((s) => s.slot === 'side-top')).toMatchObject({ n: 2, checked: false })
    expect(perSlot.find((s) => s.slot === 'side-left')).toMatchObject({ n: 6, checked: true })
    expect(outliers).toEqual([])
  })

  // Mixed bases would compare frame-relative against raster-relative numbers, so
  // one frameless row drops the WHOLE batch to the raster basis.
  it('falls back to the raster basis for everyone when any frame is unusable', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => scan(id))
    rows[1].frame = null
    const out = fiducialBatchConsensus(rows)
    expect(out.basis).toBe('raster')
    expect(out.outliers).toEqual([])
  })
})

describe('fiducialShapeCheck', () => {
  // 8 marks on a sheared, scaled, rotated rectangle — an affine scan. Midpoints of
  // opposite pairs still coincide, so nothing may be flagged.
  const affine = ([u, v]) => [5000 + 4100 * u + 300 * v, 5200 - 150 * u + 3950 * v]
  const unit = { 'corner-tl': [-1, -1], 'corner-tr': [1, -1], 'corner-br': [1, 1], 'corner-bl': [-1, 1],
    'side-top': [0, -1.05], 'side-bottom': [0, 1.05], 'side-left': [-1.05, 0], 'side-right': [1.05, 0] }
  const marks = (slots, bump = {}) => slots.map((slot) => {
    const [px, py] = affine(unit[slot]), [dx, dy] = bump[slot] ?? [0, 0]
    return { slot, px: px + dx, py: py + dy }
  })
  const ALL = Object.keys(unit), CORNERS = ALL.slice(0, 4)

  it('accepts any affine image of a centrally symmetric layout', () => {
    const r = fiducialShapeCheck(marks(ALL, { 'corner-tl': [1.5, -2] }))
    expect(r.checked).toBe(true)
    expect(r.outliers).toEqual([])
  })
  it('names the offending pair once ≥3 pair centres vote', () => {
    // A data-strip hit 60 px off the real corner: centre moves 30 px; tol ≈ 0.002·extent ≈ 23 px.
    const r = fiducialShapeCheck(marks(ALL, { 'corner-tr': [60, 0] }))
    expect(r.outliers.map((o) => o.slot).sort()).toEqual(['corner-bl', 'corner-tr'])
  })
  it('sends both pairs to review when only two disagree', () => {
    const r = fiducialShapeCheck(marks(CORNERS, { 'corner-tr': [60, 0] }))
    expect(r.outliers.map((o) => o.slot).sort()).toEqual([...CORNERS].sort())
  })
  it('has no opinion with fewer than two opposite pairs', () => {
    expect(fiducialShapeCheck(marks(['corner-tl', 'corner-br', 'side-top'])).checked).toBe(false)
  })
})

describe('consensus frame confidence', () => {
  it('falls back to the raster basis when any frame is below the detector floor', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `i${i}`, natW: 1000, natH: 1000,
      frame: { left: 50, right: 950, top: 50, bottom: 950, confidence: i === 2 ? 0.01 : 0.5 },
      accepted: [{ slot: 'corner-tl', px: 60, py: 60 }],
    }))
    expect(fiducialBatchConsensus(rows).basis).toBe('raster')
    rows[2].frame.confidence = 0.5
    expect(fiducialBatchConsensus(rows).basis).toBe('frame')
  })
})
