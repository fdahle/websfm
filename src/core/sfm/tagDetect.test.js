import { describe, it, expect } from 'vitest'
import { detectTags, tagTiles, mergeTags, tagNumber, tagScore } from './tagDetect.js'
import { gaussianBlur } from './targetDetect.js'
import * as TAG from './tags/tag36h11.js'

// Render tag `id` (10 × 10 cells, its 8-cell box mapped onto `corners`: top-left,
// top-right, bottom-right, bottom-left) by 4 × 4 supersampling, on mid-grey with noise.
function renderTag({ id, corners, map = null, flips = [], w = 200, h = 200, noise = 3, seed = 3 }) {
  const cells = Array.from({ length: 10 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => (x === 0 || y === 0 || x === 9 || y === 9 ? 1 : 0)),
  )
  const code = TAG.CODES[id]
  for (let i = 0; i < TAG.NBITS; i++) {
    const bit = Math.floor(code / 2 ** (TAG.NBITS - 1 - i)) % 2
    cells[TAG.BIT_Y[i] + 1][TAG.BIT_X[i] + 1] = flips.includes(i) ? 1 - bit : bit
  }
  // Image → box coordinates (0..8 over the black ring's outer edge), the inverse map.
  const inv = invHomography(corners, map)
  let s = seed
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const [u, t] = inv(x - 0.5 + (i + 0.5) / 4, y - 0.5 + (j + 0.5) / 4)
          const cx = Math.floor(u * 8) + 1,
            cy = Math.floor(t * 8) + 1
          v += cx >= 0 && cy >= 0 && cx < 10 && cy < 10 ? (cells[cy][cx] ? 230 : 20) : 120
        }
      data[y * w + x] = v / 16 + noise * rand()
    }
  return { data, width: w, height: h }
}

// The inverse of the map from the unit square to `q` (by Newton on the forward map).
function invHomography(q, map = null) {
  const fwd =
    map ??
    ((u, v) => {
      const top = { x: q[0].x + u * (q[1].x - q[0].x), y: q[0].y + u * (q[1].y - q[0].y) }
      const bot = { x: q[3].x + u * (q[2].x - q[3].x), y: q[3].y + u * (q[2].y - q[3].y) }
      return [top.x + v * (bot.x - top.x), top.y + v * (bot.y - top.y)]
    })
  return (x, y) => {
    let u = 0.5,
      v = 0.5
    for (let k = 0; k < 20; k++) {
      const [fx, fy] = fwd(u, v)
      const e = 1e-6
      const [ax, ay] = fwd(u + e, v),
        [bx, by] = fwd(u, v + e)
      const j00 = (ax - fx) / e,
        j01 = (bx - fx) / e,
        j10 = (ay - fy) / e,
        j11 = (by - fy) / e
      const det = j00 * j11 - j01 * j10
      const dx = x - fx,
        dy = y - fy
      u += (j11 * dx - j01 * dy) / det
      v += (-j10 * dx + j00 * dy) / det
    }
    return [u, v]
  }
}

// A bilinear (not projective) quad keeps these tests' corners exact: its centre is the
// mean of the corners' midpoints, as the detector's homography puts it for a parallelogram.
const square = (cx, cy, half, angle) =>
  [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, b]) => ({
    x: cx + half * (a * Math.cos(angle) - b * Math.sin(angle)),
    y: cy + half * (a * Math.sin(angle) + b * Math.cos(angle)),
  }))

describe('detectTags', () => {
  it('reads the id and centres the tag, in every rotation', () => {
    for (const [id, angle] of [
      [0, 0.1],
      [7, 1.7],
      [123, -2.6],
      [586, 3.9],
    ]) {
      const corners = square(98.3, 101.6, 40, angle)
      const img = gaussianBlur(renderTag({ id, corners }), 0.8)
      const tags = detectTags(img)
      expect(
        tags.map((t) => t.id),
        `id ${id}`,
      ).toEqual([id])
      expect(Math.hypot(tags[0].center.x - 98.3, tags[0].center.y - 101.6)).toBeLessThan(0.15)
      expect(tags[0].hamming).toBe(0)
    }
  })

  it('finds a small, noisy tag and nothing in an empty frame', () => {
    const corners = square(60.4, 55.2, 13, 0.4)
    const img = gaussianBlur(renderTag({ id: 42, corners, w: 120, h: 110, noise: 8 }), 0.7)
    const tags = detectTags(img, { minSide: 12 })
    expect(tags.map((t) => t.id)).toEqual([42])
    expect(Math.hypot(tags[0].center.x - 60.4, tags[0].center.y - 55.2)).toBeLessThan(0.3)
    const empty = { width: 100, height: 100, data: new Float32Array(10000).map((_, i) => 120 + ((i * 7919) % 23)) }
    expect(detectTags(empty)).toEqual([])
  })
})

describe('detectTags under perspective and damage', () => {
  // A real perspective: a tag on the ground seen obliquely (x' = (a·u + b) / (c·v + 1)).
  const persp = (u, v) => {
    const w = 1 + 0.6 * v
    return [60 + (90 * u - 10 * v) / w, 50 + (85 * v + 5 * u) / w]
  }
  it('centres a tag seen in perspective where its diagonals cross', () => {
    const img = gaussianBlur(renderTag({ id: 300, corners: null, map: persp, w: 220, h: 200 }), 0.8)
    const [t] = detectTags(img)
    expect(t.id).toBe(300)
    const [cx, cy] = persp(0.5, 0.5)
    expect(Math.hypot(t.center.x - cx, t.center.y - cy)).toBeLessThan(0.2)
  })
  it('corrects two wrong bits, and finds several tags in one image', () => {
    const a = renderTag({ id: 11, corners: square(55, 60, 30, 0.2), flips: [3, 20], w: 260, h: 130 })
    const b = renderTag({ id: 500, corners: square(190, 65, 28, -0.7), w: 260, h: 130, seed: 9 })
    // Two tags side by side: each half of the image from its own render.
    const both = { width: 260, height: 130, data: new Float32Array(260 * 130) }
    for (let y = 0; y < 130; y++)
      for (let x = 0; x < 260; x++) both.data[y * 260 + x] = (x < 125 ? a : b).data[y * 260 + x]
    const tags = detectTags(gaussianBlur(both, 0.8)).sort((p, q) => p.id - q.id)
    expect(tags.map((t) => [t.id, t.hamming])).toEqual([
      [11, 2],
      [500, 0],
    ])
  })
})

describe('tiles, merging and names', () => {
  it('covers a photo with overlapping tiles whose cores split it exactly', () => {
    const tiles = tagTiles(5472, 3648, { tile: 2048, overlap: 400 })
    expect(tiles.length).toBe(4 * 2)
    for (const t of tiles) {
      expect(t.x0 + t.w).toBeLessThanOrEqual(5472)
      // The core lies at least half the overlap inside the tile, except at the photo's edge.
      if (t.x0 > 0) expect(t.core.x0 - t.x0).toBeGreaterThanOrEqual(200)
      if (t.x0 + t.w < 5472) expect(t.x0 + t.w - t.core.x1).toBeGreaterThanOrEqual(200)
    }
    // Every pixel is in exactly one core.
    for (const [x, y] of [
      [0, 0],
      [1900.5, 1700],
      [5471, 3647],
    ])
      expect(tiles.filter((t) => x >= t.core.x0 && x < t.core.x1 && y >= t.core.y0 && y < t.core.y1).length).toBe(1)
    expect(tagTiles(1000, 800, { tile: 2048, overlap: 400 })).toEqual([
      { x0: 0, y0: 0, w: 1000, h: 800, core: { x0: 0, y0: 0, x1: 1000, y1: 800 } },
    ])
  })
  it('keeps one detection per tag, and reads the tag number from a GCP name', () => {
    const m = mergeTags([
      { id: 4, hamming: 1, contrast: 0.9 },
      { id: 4, hamming: 0, contrast: 0.5 },
      { id: 2, hamming: 0, contrast: 0.4 },
      { id: 2, hamming: 0, contrast: 0.6 },
    ])
    expect(m).toEqual([
      { id: 2, hamming: 0, contrast: 0.6 },
      { id: 4, hamming: 0, contrast: 0.5 },
    ])
    expect(['7', 'Tag 7', 'GCP-07', 'T12', 'base', 'GCP 3a 4', null].map(tagNumber)).toEqual([
      7,
      7,
      7,
      12,
      null,
      null,
      null,
    ])
    expect([0, 1, 2].map(tagScore)).toEqual([1, 0.82, 0.64])
  })
})
