import { describe, it, expect } from 'vitest'

import { planTiles, sliceRaster, nmsByPosition, autoTileSize } from './tiling.js'

describe('planTiles', () => {
  it('returns a single full-span tile when the image fits', () => {
    expect(planTiles(800, 600, 1024, 64)).toEqual([{ x: 0, y: 0, w: 800, h: 600 }])
  })

  it('covers every pixel with overlapping tiles', () => {
    const W = 3000, H = 2000, ts = 1024, ov = 64
    const tiles = planTiles(W, H, ts, ov)
    // Union of tiles must cover [0,W)×[0,H): build a coverage bitmap on a coarse grid.
    const step = 50
    for (let x = 0; x < W; x += step) {
      for (let y = 0; y < H; y += step) {
        const covered = tiles.some((t) => x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h)
        expect(covered, `pixel ${x},${y} uncovered`).toBe(true)
      }
    }
  })

  it('pins the final tile flush to the far edge', () => {
    const tiles = planTiles(2500, 1000, 1024, 64)
    const maxRight = Math.max(...tiles.map((t) => t.x + t.w))
    const maxBottom = Math.max(...tiles.map((t) => t.y + t.h))
    expect(maxRight).toBe(2500)
    expect(maxBottom).toBe(1000)
    // Every interior tile is exactly tileSize wide/tall (only the span clamps).
    expect(tiles.every((t) => t.w === 1024)).toBe(true)
  })

  it('adjacent tiles overlap by ~overlap px', () => {
    const tiles = planTiles(2000, 500, 1024, 100)
    const xs = [...new Set(tiles.map((t) => t.x))].sort((a, b) => a - b)
    expect(xs.length).toBeGreaterThan(1)
    // step = tileSize - overlap = 924, except the last (edge-pinned) start.
    expect(xs[1] - xs[0]).toBe(924)
  })
})

describe('sliceRaster', () => {
  it('extracts a tile-local RGBA buffer at the right offset', () => {
    const W = 4, H = 3
    // Encode each pixel's R channel as its row-major index so we can verify layout.
    const data = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < W * H; i++) data[i * 4] = i
    const out = sliceRaster(data, W, H, { x: 1, y: 1, w: 2, h: 2 })
    // Tile covers full-image indices (row1: 5,6) (row2: 9,10).
    expect([out[0], out[4], out[8], out[12]]).toEqual([5, 6, 9, 10])
    expect(out.length).toBe(2 * 2 * 4)
  })
})

describe('nmsByPosition', () => {
  it('keeps the strongest of a near-duplicate cluster', () => {
    const items = [
      { x: 10, y: 10, response: 0.2 },
      { x: 11, y: 10, response: 0.9 }, // within radius of #0 → wins
      { x: 200, y: 200, response: 0.5 }, // far away → kept
    ]
    const kept = nmsByPosition(items, 3)
    expect(kept).toEqual([1, 2]) // strongest-first, duplicate #0 dropped
  })

  it('returns response-sorted indices with no suppression at radius 0', () => {
    const items = [
      { x: 0, y: 0, response: 0.1 },
      { x: 0, y: 0, response: 0.4 },
    ]
    expect(nmsByPosition(items, 0)).toEqual([1, 0])
  })

  it('handles the empty case', () => {
    expect(nmsByPosition([], 3)).toEqual([])
  })

  it('keeps SIFT orientation siblings but drops them with their extremum', () => {
    const items = [
      { x: 10, y: 10, scale: 2, response: 0.9 }, // A
      { x: 10, y: 10, scale: 2, response: 0.9 }, // A's sibling (second orientation)
      { x: 11, y: 10, scale: 2.4, response: 0.5 }, // same blob from the next tile → dup
      { x: 11, y: 10, scale: 2.4, response: 0.5 }, //   … and its sibling goes with it
      { x: 50, y: 50, scale: 2, response: 0.3 },
    ]
    expect(nmsByPosition(items, 3)).toEqual([0, 1, 4])
  })

  it('never treats scale-less items (SuperPoint) as siblings', () => {
    const items = [{ x: 5, y: 5, response: 0.9 }, { x: 5, y: 5, response: 0.8 }]
    expect(nmsByPosition(items, 3)).toEqual([0])
  })
})

describe('autoTileSize', () => {
  it('falls back to the max default with no GPU info', () => {
    expect(autoTileSize({ maxBindingBytes: 0 })).toBe(1536)
  })

  it('shrinks as the binding limit shrinks, clamped and 32-aligned', () => {
    const small = autoTileSize({ maxBindingBytes: 128 * 1024 * 1024 })
    const big = autoTileSize({ maxBindingBytes: 2 * 1024 * 1024 * 1024 })
    expect(small).toBeLessThanOrEqual(big)
    expect(small % 32).toBe(0)
    expect(small).toBeGreaterThanOrEqual(384)
    expect(big).toBeLessThanOrEqual(1536)
  })
})
