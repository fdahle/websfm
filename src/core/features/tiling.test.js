import { describe, it, expect } from 'vitest'

import {
  planTiles, tileOwns, sliceRaster, nmsByPosition, autoTileSize, SIFT_TILE_ALIGN,
} from './tiling.js'

// Distinct starts along one axis, with each tile's extent.
const axis = (tiles, key, size) => {
  const seen = new Map()
  for (const t of tiles) seen.set(t[key], t[size])
  return [...seen].sort((a, b) => a[0] - b[0]).map(([start, len]) => ({ start, len }))
}

// Deterministic pseudo-random sequence for the property sweep.
function lcg(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

describe('planTiles', () => {
  it('returns a single full-span tile, owning everything, when the image fits', () => {
    const tiles = planTiles(800, 600, 1024, 64)
    expect(tiles.map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual([{ x: 0, y: 0, w: 800, h: 600 }])
    expect(tileOwns(tiles[0], -0.5, 599.9)).toBe(true)
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

  it('uses the overlap that was asked for, not the slack of full-size tiles', () => {
    // 3072 px in ≤1536 px tiles needs 3 columns; at full size they would overlap by
    // 768 px (2× the detection work). Shrunk, they overlap by ~64 px.
    const tiles = planTiles(3072, 2304, 1536, 64, { align: SIFT_TILE_ALIGN })
    const cols = axis(tiles, 'x', 'w')
    expect(cols).toHaveLength(3)
    for (let i = 0; i + 1 < cols.length; i++) {
      const ov = cols[i].start + cols[i].len - cols[i + 1].start
      expect(ov).toBeGreaterThanOrEqual(64)
      expect(ov).toBeLessThan(64 + 2 * SIFT_TILE_ALIGN)
    }
    expect(tiles.every((t) => t.w <= 1536 && t.h <= 1536)).toBe(true)
    expect(Math.max(...tiles.map((t) => t.x + t.w))).toBe(3072)
    expect(Math.max(...tiles.map((t) => t.y + t.h))).toBe(2304)
  })

  it('holds its invariants across random sizes, overlaps and alignments', () => {
    const rnd = lcg(7)
    for (let trial = 0; trial < 500; trial++) {
      const ts = 256 + Math.floor(rnd() * 1800)
      const ov = Math.floor(rnd() * ts * 0.6)
      const align = [1, 8, 16][Math.floor(rnd() * 3)]
      const W = 1 + Math.floor(rnd() * 9000)
      const H = 1 + Math.floor(rnd() * 9000)
      const tiles = planTiles(W, H, ts, ov, { align })
      const ctx = `W=${W} H=${H} ts=${ts} ov=${ov} align=${align}`
      for (const [key, size, total] of [['x', 'w', W], ['y', 'h', H]]) {
        const a = axis(tiles, key, size)
        expect(a[0].start, ctx).toBe(0)
        const last = a[a.length - 1]
        expect(last.start + last.len, ctx).toBe(total) // reaches the far edge
        for (const { start, len } of a) {
          expect(len, ctx).toBeLessThanOrEqual(ts)
          expect(len, ctx).toBeGreaterThan(0)
          if (a.length > 1) expect(start % align, ctx).toBe(0)
        }
        for (let i = 0; i + 1 < a.length; i++) {
          // ≥ ov overlap: every kept keypoint is ≥ ov/2 from a cut edge.
          expect(a[i].start + a[i].len - a[i + 1].start, ctx).toBeGreaterThanOrEqual(ov)
        }
      }
      // Ownership partitions the raster: exactly one tile owns each sample point,
      // and it lies inside that tile with ≥ ⌊ov/2⌋ clearance to any cut edge.
      for (let k = 0; k < 40; k++) {
        const x = rnd() * W - 0.5, y = rnd() * H - 0.5
        const owners = tiles.filter((t) => tileOwns(t, x, y))
        expect(owners, `${ctx} at ${x},${y}`).toHaveLength(1)
        const t = owners[0]
        const clear = Math.floor(ov / 2) - 1
        if (t.x > 0) expect(x - t.x, ctx).toBeGreaterThanOrEqual(clear)
        if (t.y > 0) expect(y - t.y, ctx).toBeGreaterThanOrEqual(clear)
        if (t.x + t.w < W) expect(t.x + t.w - x, ctx).toBeGreaterThanOrEqual(clear)
        if (t.y + t.h < H) expect(t.y + t.h - y, ctx).toBeGreaterThanOrEqual(clear)
      }
    }
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

  it('suppresses only across tiles when items carry a tile id', () => {
    const items = [
      { x: 10, y: 10, scale: 2, response: 0.9, tile: 0 },
      { x: 11, y: 10, scale: 4, response: 0.5, tile: 0 }, // same tile: the detector's call → kept
      { x: 10.5, y: 10, scale: 2, response: 0.4, tile: 1 }, // neighbour's copy of #0 → dropped
    ]
    expect(nmsByPosition(items, 2)).toEqual([0, 1])
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
