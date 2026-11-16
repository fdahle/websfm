import { describe, it, expect } from 'vitest'
import { detTiles, detInput, stitchTile, dbBoxes, detectText, DET_MEAN, DET_STD } from './detect.js'
import { polyBounds, minAreaRect } from './quad.js'

describe('detTiles', () => {
  it('covers every pixel exactly once with the kept parts, sides a multiple of 32', () => {
    for (const [w, h] of [
      [100, 70],
      [1280, 1280],
      [2447, 2560],
      [3001, 1400],
    ]) {
      const tiles = detTiles(w, h, 1280, 128)
      const seen = new Uint8Array(w * h)
      for (const t of tiles) {
        expect(t.w % 32).toBe(0)
        expect(t.h % 32).toBe(0)
        expect(t.w).toBeLessThanOrEqual(1280)
        const { x0, y0, x1, y1 } = t.keep
        expect(x0).toBeGreaterThanOrEqual(t.x)
        expect(x1).toBeLessThanOrEqual(t.x + t.w)
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) seen[y * w + x]++
      }
      expect(seen.every((v) => v === 1)).toBe(true)
    }
  })

  it('keeps a pixel in the tile where it lies at least half the overlap from a seam', () => {
    const tiles = detTiles(3000, 100, 1280, 128)
    for (const t of tiles) {
      const { x0, x1 } = t.keep
      if (x0 > 0) expect(x0 - t.x).toBeGreaterThanOrEqual(64)
      if (x1 < 3000) expect(t.x + t.w - x1).toBeGreaterThanOrEqual(64)
    }
  })
})

describe('detInput', () => {
  it('normalises grey per BGR channel and repeats the edge past the raster', () => {
    const gray = Uint8Array.from([0, 255, 128, 64])
    const t = { x: 0, y: 0, w: 32, h: 32 }
    const x = detInput(gray, 2, 2, t)
    const plane = 32 * 32
    for (let c = 0; c < 3; c++) {
      expect(x[c * plane]).toBeCloseTo((0 - DET_MEAN[c]) / DET_STD[c], 5)
      expect(x[c * plane + 1]).toBeCloseTo((1 - DET_MEAN[c]) / DET_STD[c], 5)
      // Column 31 of row 0 repeats raster column 1; row 31 repeats raster row 1.
      expect(x[c * plane + 31]).toBeCloseTo((1 - DET_MEAN[c]) / DET_STD[c], 5)
      expect(x[c * plane + 31 * 32]).toBeCloseTo((128 / 255 - DET_MEAN[c]) / DET_STD[c], 5)
    }
  })
})

// A probability map with filled rectangles (axis-aligned) at `value`.
function probMap(w, h, rects, value = 0.9) {
  const p = new Float32Array(w * h)
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) p[y * w + x] = value
  return p
}

describe('dbBoxes', () => {
  it('finds each text region as one box, grown by the unclip distance', () => {
    const p = probMap(200, 100, [
      [20, 30, 120, 40],
      [150, 10, 160, 90],
    ])
    const boxes = dbBoxes(p, 200, 100)
    expect(boxes).toHaveLength(2)
    const wide = boxes.find((b) => polyBounds(b.quad)[2] - polyBounds(b.quad)[0] > 50)
    // The region spans pixel centres 20..119 × 30..39: a 99 × 9 rectangle, grown by
    // d = 99·9·1.5 / (2·108) on each side.
    const d = (99 * 9 * 1.5) / 216
    const [x0, y0, x1, y1] = polyBounds(wide.quad)
    expect(x0).toBeCloseTo(20 - d, 6)
    expect(x1).toBeCloseTo(119 + d, 6)
    expect(y0).toBeCloseTo(30 - d, 6)
    expect(y1).toBeCloseTo(39 + d, 6)
    expect(wide.score).toBeCloseTo(0.9, 5)
  })

  it('drops regions whose mean probability is below the box threshold', () => {
    const p = probMap(100, 50, [[10, 10, 60, 20]], 0.5)
    expect(dbBoxes(p, 100, 50)).toHaveLength(0)
    expect(dbBoxes(p, 100, 50, { boxThresh: 0.4 })).toHaveLength(1)
  })

  it('drops regions thinner than the minimum size', () => {
    const p = probMap(100, 50, [[10, 10, 60, 12]])
    expect(dbBoxes(p, 100, 50)).toHaveLength(0)
  })

  it('follows a turned line with a turned box, not its bounding box', () => {
    const w = 200,
      h = 200
    const p = new Float32Array(w * h)
    // A 100 × 8 band along the diagonal.
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const u = (x - 100 + (y - 100)) / Math.SQRT2,
          v = (-(x - 100) + (y - 100)) / Math.SQRT2
        if (Math.abs(u) <= 50 && Math.abs(v) <= 4) p[y * w + x] = 0.95
      }
    const [box] = dbBoxes(p, w, h)
    const r = minAreaRect(box.quad)
    expect(Math.max(r.w, r.h)).toBeGreaterThan(100)
    expect(Math.min(r.w, r.h)).toBeLessThan(25)
  })
})

describe('detectText', () => {
  it('stitches the tiles so a line across a seam stays one box', async () => {
    const w = 3000,
      h = 64
    const gray = new Uint8Array(w * h)
    // The "network" marks text where the raster is dark: a line from x = 1000 to 1400
    // crosses the first tile seam.
    for (let y = 20; y < 40; y++) for (let x = 1000; x < 1400; x++) gray[y * w + x] = 0
    for (let i = 0; i < gray.length; i++) if (gray[i] !== 0) gray[i] = 255
    for (let y = 20; y < 40; y++) for (let x = 1000; x < 1400; x++) gray[y * w + x] = 0
    const run = async (input, dims) => {
      const [, , th, tw] = dims
      const out = new Float32Array(th * tw)
      for (let i = 0; i < th * tw; i++) out[i] = input[i] < 0 ? 0.95 : 0
      return out
    }
    const { boxes, tiles } = await detectText(gray, w, h, run)
    expect(tiles).toBeGreaterThan(2)
    expect(boxes).toHaveLength(1)
    const [x0, , x1] = polyBounds(boxes[0].quad)
    expect(x0).toBeLessThan(1000)
    expect(x1).toBeGreaterThan(1399)
  })

  it('stitchTile writes only the kept part of a tile', () => {
    const prob = new Float32Array(10 * 4)
    const t = { x: 2, y: 0, w: 6, h: 4, keep: { x0: 3, y0: 1, x1: 6, y1: 3 } }
    stitchTile(prob, 10, new Float32Array(24).fill(1), t)
    expect(prob.reduce((a, b) => a + b, 0)).toBe(6)
    expect(prob[1 * 10 + 3]).toBe(1)
    expect(prob[1 * 10 + 2]).toBe(0)
  })
})
