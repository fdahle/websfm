import { describe, it, expect } from 'vitest'
import {
  needsPyramid,
  planPyramid,
  levelFor,
  levelScale,
  tilesForRect,
  tileSize,
  buildIndex,
  tileRange,
  halveRows,
  createLevelCascade,
} from './rasterPyramid.js'

describe('planPyramid', () => {
  it('halves (rounding up) down to the first level ≤ minLong', () => {
    const p = planPyramid(65714, 32857, { tileSize: 2048, minLong: 1024 })
    expect(p.levels.map((L) => [L.width, L.height])).toEqual([
      [65714, 32857],
      [32857, 16429],
      [16429, 8215],
      [8215, 4108],
      [4108, 2054],
      [2054, 1027],
      [1027, 514],
      [514, 257],
    ])
    expect(p.levels[0]).toMatchObject({ cols: 33, rows: 17 })
  })

  it('flags images past the canvas limits only', () => {
    expect(needsPyramid(16429, 8214)).toBe(false) // 135 MP: one canvas still works
    expect(needsPyramid(65714, 32857)).toBe(true)
    expect(needsPyramid(31000, 1000)).toBe(true) // a side past 30 k (Chrome: 32,767)
  })
})

describe('levelFor', () => {
  it('with slack, takes a level a request lies just above', () => {
    const p = planPyramid(65714, 32857)
    expect(levelFor(p, 0.2501)).toBe(1)
    expect(levelFor(p, 0.2501, { slack: 0.02 })).toBe(2)
    expect(levelFor(p, 0.26, { slack: 0.02 })).toBe(1)
  })
  const p = planPyramid(65714, 32857)
  it('picks the coarsest level still at or above the requested scale', () => {
    expect(levelFor(p, 1)).toBe(0)
    expect(levelFor(p, 0.25)).toBe(2) // exactly 2^-2
    expect(levelFor(p, 0.26)).toBe(1)
    expect(levelFor(p, 4000 / 65714)).toBe(4)
    expect(levelScale(4)).toBe(1 / 16)
    expect(levelFor(p, 1e-6)).toBe(p.levels.length - 1)
  })
})

describe('tilesForRect', () => {
  const p = planPyramid(5000, 3000, { tileSize: 1024 })
  it('covers a rect exactly once, with partial edge tiles', () => {
    const rect = { x0: 1000, y0: 900, x1: 3100.5, y1: 3000 }
    const parts = tilesForRect(p, 0, rect)
    let area = 0
    for (const t of parts) {
      const sz = tileSize(p, 0, t.col, t.row)
      expect(t.sx + t.sw).toBeLessThanOrEqual(sz.width)
      expect(t.sy + t.sh).toBeLessThanOrEqual(sz.height)
      area += t.sw * t.sh
    }
    expect(area).toBe((3101 - 1000) * (3000 - 900))
    expect(parts[0]).toMatchObject({ col: 0, row: 0, sx: 1000, sy: 900, dx: 0, dy: 0 })
    expect(tileSize(p, 0, 4, 2)).toEqual({ width: 5000 - 4096, height: 3000 - 2048 })
  })
})

describe('halveRows / createLevelCascade', () => {
  it('box-averages 2×2 with the edge replicated', () => {
    // 3 × 3 single channel → 2 × 2.
    const src = Uint8Array.from([0, 4, 8, 12, 16, 20, 24, 28, 32])
    expect([...halveRows(src, 3, 3, 1)]).toEqual([8, 14, 26, 32])
  })

  it('streams every level in tile rows, matching a whole-image halving', () => {
    const W = 37,
      H = 29,
      C = 1,
      ts = 8
    const img = new Uint8Array(W * H)
    for (let i = 0; i < img.length; i++) img[i] = (i * 37 + (i >> 3) * 11) & 255
    const plan = planPyramid(W, H, { tileSize: ts, minLong: 4 })
    const got = plan.levels.map((L) => new Uint8Array(L.width * L.height * C))
    const seen = plan.levels.map(() => 0)
    const cascade = createLevelCascade(plan, C, (k, y0, rows, data) => {
      expect(y0).toBe(seen[k])
      seen[k] += rows
      got[k].set(data, y0 * plan.levels[k].width * C)
    })
    // Uneven feeding (bands of 5 rows) must not matter.
    for (let y = 0; y < H; y += 5) cascade.push(img.subarray(y * W, Math.min(H, y + 5) * W), Math.min(5, H - y))
    cascade.finish()
    let want = img,
      w = W,
      h = H
    for (let k = 0; k < plan.levels.length; k++) {
      expect(seen[k]).toBe(plan.levels[k].height)
      expect([...got[k]]).toEqual([...want])
      want = halveRows(want, w, h, C)
      w = Math.ceil(w / 2)
      h = Math.ceil(h / 2)
    }
  })
})

describe('buildIndex / tileRange', () => {
  it('lays tiles out level by level, row-major', () => {
    const plan = planPyramid(3000, 1500, { tileSize: 1024, minLong: 1000 })
    const n = plan.levels.reduce((a, L) => a + L.cols * L.rows, 0)
    const lengths = Array.from({ length: n }, (_, i) => 100 + i)
    const idx = buildIndex(plan, lengths, 1)
    expect(idx.bytes).toBe(lengths.reduce((a, b) => a + b, 0))
    expect(tileRange(idx, 0, 1, 1)).toEqual({ offset: 100 + 101 + 102 + 103, length: 104 })
    expect(tileRange(idx, 1, 0, 0).offset).toBe(lengths.slice(0, 6).reduce((a, b) => a + b, 0))
    expect(() => buildIndex(plan, lengths.slice(1), 1)).toThrow()
  })
})
