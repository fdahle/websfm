import { describe, it, expect } from 'vitest'
import { prefixOffsets, indexAtOffset, computeWindow, scrollToReveal } from './virtualWindow.js'

describe('prefixOffsets / indexAtOffset', () => {
  it('builds n + 1 prefix sums', () => {
    expect([...prefixOffsets([10, 20, 5])]).toEqual([0, 10, 30, 35])
    expect([...prefixOffsets([])]).toEqual([0])
  })
  it('finds the row containing y, clamped', () => {
    const o = prefixOffsets([10, 20, 5])
    expect(indexAtOffset(o, -3)).toBe(0)
    expect(indexAtOffset(o, 0)).toBe(0)
    expect(indexAtOffset(o, 9.9)).toBe(0)
    expect(indexAtOffset(o, 10)).toBe(1)
    expect(indexAtOffset(o, 29)).toBe(1)
    expect(indexAtOffset(o, 30)).toBe(2)
    expect(indexAtOffset(o, 999)).toBe(2)
    expect(indexAtOffset(prefixOffsets([]), 5)).toBe(0)
  })
  it('skips zero-height rows when locating y', () => {
    const o = prefixOffsets([10, 0, 10])
    expect(indexAtOffset(o, 10)).toBe(2)
  })
})

describe('computeWindow', () => {
  it('is empty for no rows', () => {
    expect(computeWindow({ count: 0, itemHeight: 20 })).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, total: 0 })
  })

  it('fixed height: renders the viewport plus overscan and keeps the total', () => {
    const w = computeWindow({ count: 1000, itemHeight: 20, scrollTop: 400, viewportHeight: 200, overscan: 5 })
    expect(w.start).toBe(15) // row 20 is the first visible, minus 5
    expect(w.end).toBe(35) // rows 20..29 visible (+1 partial guard) + 5
    expect(w.padTop).toBe(15 * 20)
    expect(w.padTop + (w.end - w.start) * 20 + w.padBottom).toBe(w.total)
    expect(w.total).toBe(20000)
  })

  it('fixed height: clamps at both ends', () => {
    const top = computeWindow({ count: 50, itemHeight: 20, scrollTop: 0, viewportHeight: 100, overscan: 5 })
    expect(top.start).toBe(0)
    expect(top.padTop).toBe(0)
    const bottom = computeWindow({ count: 50, itemHeight: 20, scrollTop: 5000, viewportHeight: 100, overscan: 5 })
    expect(bottom.end).toBe(50)
    expect(bottom.padBottom).toBe(0)
    expect(bottom.start).toBeLessThan(50)
  })

  it('renders a first screenful when the viewport is not laid out', () => {
    const w = computeWindow({ count: 1000, itemHeight: 20, scrollTop: 0, viewportHeight: 0, overscan: 2, minRows: 30 })
    expect(w.start).toBe(0)
    expect(w.end).toBe(32)
  })

  it('variable heights: window and spacers agree with the offsets', () => {
    const heights = Array.from({ length: 500 }, (_, i) => (i % 10 === 0 ? 100 : 24))
    const offsets = prefixOffsets(heights)
    const w = computeWindow({ count: 500, offsets, scrollTop: 3000, viewportHeight: 300, overscan: 3 })
    let rendered = 0
    for (let i = w.start; i < w.end; i++) rendered += heights[i]
    expect(w.padTop).toBe(offsets[w.start])
    expect(w.padTop + rendered + w.padBottom).toBeCloseTo(offsets[500], 9)
    // Every row intersecting [3000, 3300) is inside the window.
    for (let i = 0; i < 500; i++) {
      const visible = offsets[i + 1] > 3000 && offsets[i] < 3300
      if (visible) {
        expect(i).toBeGreaterThanOrEqual(w.start)
        expect(i).toBeLessThan(w.end)
      }
    }
  })

  it('a list smaller than the viewport renders every row', () => {
    const w = computeWindow({ count: 5, itemHeight: 20, scrollTop: 0, viewportHeight: 800 })
    expect(w).toMatchObject({ start: 0, end: 5, padTop: 0, padBottom: 0 })
  })
})

describe('scrollToReveal', () => {
  it('returns null when the row is already visible', () => {
    expect(scrollToReveal({ index: 5, count: 100, itemHeight: 20, scrollTop: 0, viewportHeight: 200 })).toBeNull()
  })
  it('scrolls up to a row above and down to a row below', () => {
    expect(scrollToReveal({ index: 2, count: 100, itemHeight: 20, scrollTop: 100, viewportHeight: 200 })).toBe(40)
    expect(scrollToReveal({ index: 20, count: 100, itemHeight: 20, scrollTop: 0, viewportHeight: 200 })).toBe(220)
  })
  it('aligns the top of a row taller than the viewport', () => {
    const offsets = prefixOffsets([20, 500, 20])
    expect(scrollToReveal({ index: 1, count: 3, offsets, scrollTop: 0, viewportHeight: 100 })).toBe(20)
  })
  it('ignores an out-of-range index', () => {
    expect(scrollToReveal({ index: 7, count: 3, itemHeight: 20 })).toBeNull()
  })
})
