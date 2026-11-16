import { describe, it, expect } from 'vitest'
import { isTextLine, linePolygon, recurringBoxes, boxPolygon, coveredShare, mappedBox } from './textMask.js'
import { polyBounds } from './quad.js'

describe('isTextLine', () => {
  it('keeps a line read surely, drops one read unsurely', () => {
    expect(isTextLine({ text: 'F31 USN GS', textScore: 0.95 })).toBe(true)
    expect(isTextLine({ text: 'Fa', textScore: 0.38 })).toBe(false)
  })

  it('asks more of a read of one or two characters (terrain reads as single letters)', () => {
    expect(isTextLine({ text: 'o', textScore: 0.6 })).toBe(false)
    expect(isTextLine({ text: '142', textScore: 0.6 })).toBe(true)
    expect(isTextLine({ text: '5', textScore: 0.88 })).toBe(true)
  })

  it('drops a read with no letter or digit', () => {
    expect(isTextLine({ text: '.,', textScore: 0.99 })).toBe(false)
  })

  it('keeps every found line when nothing was read', () => {
    expect(isTextLine({ quad: [], score: 0.7 })).toBe(true)
  })
})

describe('linePolygon', () => {
  it('scales a box to native pixels and pads it', () => {
    const line = {
      quad: [
        [10, 10],
        [20, 10],
        [20, 12],
        [10, 12],
      ],
    }
    expect(polyBounds(linePolygon(line, 0.25, 5)).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([35, 35, 85, 53])
  })
})

describe('recurringBoxes', () => {
  // The data strip at the same place on frames a, b, c (shifted a little), missing on d;
  // a crevasse read on b alone.
  const strip = (dx) => [0.95 + dx, 0.1, 0.97 + dx, 0.4]
  const frames = [
    { id: 'a', boxes: [strip(0)] },
    { id: 'b', boxes: [strip(0.002), [0.3, 0.3, 0.32, 0.31]] },
    { id: 'c', boxes: [strip(-0.003)] },
    { id: 'd', boxes: [] },
  ]

  it('returns text found at the same place on enough frames, not a single find', () => {
    const boxes = recurringBoxes(frames, 0.2)
    expect(boxes).toHaveLength(1)
    const [x0, y0, x1, y1] = boxes[0]
    expect(x0).toBeGreaterThan(0.945)
    expect(x1).toBeLessThan(0.975)
    expect(y0).toBeCloseTo(0.1, 9)
    expect(y1).toBeCloseTo(0.4, 9)
  })

  it('needs at least two frames, however few there are', () => {
    expect(recurringBoxes([{ id: 'a', boxes: [strip(0)] }], 0.2)).toEqual([])
  })

  it('keeps one misplaced frame from growing the box over the photo', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, boxes: [strip(0)] }))
    many.push({ id: 'off', boxes: [[0.6, 0.1, 0.97, 0.4]] })
    const [box] = recurringBoxes(many, 0.2)
    expect(box[0]).toBeGreaterThan(0.9)
  })

  it('maps a shared box back onto a frame', () => {
    const toNative = ([x, y]) => [x * 1000, y * 2000]
    expect(polyBounds(boxPolygon([0.1, 0.2, 0.3, 0.4], toNative))).toEqual([100, 400, 300, 800])
    expect(mappedBox(boxPolygon([0.1, 0.2, 0.3, 0.4], toNative), ([x, y]) => [x / 1000, y / 2000])).toEqual([
      0.1, 0.2, 0.3, 0.4,
    ])
  })
})

describe('coveredShare', () => {
  it('measures the share of the photo covered, clipped to it', () => {
    const poly = [
      [-10, 0],
      [50, 0],
      [50, 100],
      [-10, 100],
    ]
    expect(coveredShare([poly], 100, 100)).toBeCloseTo(0.5, 12)
  })
})
