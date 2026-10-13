import { describe, it, expect } from 'vitest'
import {
  orthorectify, orthorectifyStreamed, orthorectifyTiled, smoothLabels, chamferTo, srgbToLinear, linearToSrgb,
  mosaicSeamCells, orthoHalo, orthoTiledWorkingBytes, NO_LABEL,
} from './ortho.js'
import { resampledGeometry } from './surface.js'

// Two nadir cameras 10 units above the z = 0 plane at x = ∓2, each map seeing the
// whole plane at depth 10 (2 map px per unit).
function nadirMap(cx, rgb, { cost = () => 0 } = {}) {
  const w = 64, h = 64, n = w * h
  return {
    uuid: `cam${cx}`, width: w, height: h, K: { fx: 20, fy: 20, cx: 32, cy: 32 },
    R: [[1, 0, 0], [0, -1, 0], [0, 0, -1]], t: [-cx, 0, 10],
    depth: new Float32Array(n).fill(10),
    cost: Float32Array.from({ length: n }, (_, i) => cost(i)),
    rgb: Uint8Array.from({ length: n * 3 }, (_, i) => rgb[i % 3]),
  }
}
function plane(w = 40, h = 20, gsd = 0.25) {
  return { width: w, height: h, gsd, originX: -(w * gsd) / 2, originY: (h * gsd) / 2,
    data: new Float32Array(w * h), mask: new Uint8Array(w * h).fill(1) }
}
async function run(surface, maps, opts, hooks = {}) {
  const geom = resampledGeometry(surface, 0)
  const blocks = []
  const res = await orthorectifyTiled(surface, geom, maps, async (i) => maps[i], (p) => p,
    { fillRadius: 0, mapsResident: true, ...opts }, { ...hooks, onBlock: (b) => blocks.push(b) })
  const { width: W, height: H } = surface
  const rgba = new Uint8ClampedArray(W * H * 4), labels = new Uint16Array(W * H)
  for (const b of blocks) for (let r = 0; r < b.height; r++) {
    rgba.set(b.rgba.subarray(r * b.width * 4, (r + 1) * b.width * 4), ((b.row0 + r) * W + b.col0) * 4)
    labels.set(b.labels.subarray(r * b.width, (r + 1) * b.width), (b.row0 + r) * W + b.col0)
  }
  return { ...res, rgba, labels }
}
const cellX = (s, c) => s.originX + (c + 0.5) * s.gsd

describe('sRGB ↔ linear', () => {
  it('round-trips every 8-bit value exactly', () => {
    for (let v = 0; v < 256; v++) expect(linearToSrgb(srgbToLinear(v))).toBe(v)
  })
  it('is monotonic between the table entries', () => {
    let prev = -1
    for (let v = 0; v <= 255; v += 0.25) { const l = srgbToLinear(v); expect(l).toBeGreaterThanOrEqual(prev); prev = l }
  })
})

describe('chamferTo', () => {
  it('equals the brute-force 3-4 chamfer distance to the nearest seed', () => {
    const w = 23, h = 17, labels = new Uint16Array(w * h).fill(NO_LABEL)
    let seed = 7
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const seeds = []
    for (let i = 0; i < w * h; i++) if (rand() < 0.03) { labels[i] = 5; seeds.push([i % w, Math.floor(i / w)]) }
    labels[3] = 9 // another label is not a seed
    const dist = new Uint16Array(w * h)
    chamferTo(labels, w, 0, 0, w, h, 5, dist)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      let best = 0xffff
      for (const [sx, sy] of seeds) {
        const dx = Math.abs(sx - c), dy = Math.abs(sy - r)
        best = Math.min(best, 4 * Math.min(dx, dy) + 3 * (Math.max(dx, dy) - Math.min(dx, dy)))
      }
      expect(dist[r * w + c]).toBe(best)
    }
  })
})

describe('smoothLabels', () => {
  it('removes a single-cell flip, keeps the regions, leaves unlabelled cells and the input alone', () => {
    const w = 8, h = 6, src = new Uint16Array(w * h)
    for (let i = 0; i < w * h; i++) src[i] = i % w < 4 ? 1 : 2
    src[2 * w + 1] = 2          // a lone flip inside region 1
    src[5 * w + 7] = NO_LABEL   // no view sees this cell
    const before = src.slice()
    const out = smoothLabels(src, new Uint16Array(w * h), new Uint16Array(w * h), w, h)
    expect([...src]).toEqual([...before])
    expect(out[2 * w + 1]).toBe(1)
    expect(out[5 * w + 7]).toBe(NO_LABEL)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (src[r * w + c] !== NO_LABEL) expect(out[r * w + c]).toBe(c < 4 ? 1 : 2)
  })
})

describe('mosaic sizing', () => {
  it('resolves the seam band from a % of the short side, clamped', () => {
    expect(mosaicSeamCells(4000, 2000, 1)).toBe(20)
    expect(mosaicSeamCells(4000, 2000, 0)).toBe(0)
    expect(mosaicSeamCells(100, 100, 0.1)).toBe(1)
    expect(mosaicSeamCells(1e5, 1e5, 50)).toBe(128)
  })
  it('widens the halo by the band and the smoothing passes, and counts its state', () => {
    expect(orthoHalo({ width: 4000, height: 2000, blend: 'best', fillRadius: 2 })).toBe(3)
    expect(orthoHalo({ width: 4000, height: 2000, blend: 'mosaic', fillRadius: 2, seamWidth: 1 })).toBe(3 + 20 + 2)
    const best = orthoTiledWorkingBytes({ width: 9000, height: 9000, blend: 'best' })
    const mosaic = orthoTiledWorkingBytes({ width: 9000, height: 9000, blend: 'mosaic', seamWidth: 1 })
    expect(mosaic).toBeGreaterThan(best)
  })
})

describe('mosaic orthophoto', () => {
  it('is tiled-only', () => {
    const s = plane()
    expect(() => orthorectify(s, [nadirMap(0, [1, 2, 3])], (p) => p, { blend: 'mosaic' })).toThrow('orthorectifyTiled')
    return expect(orthorectifyStreamed(s, [], async () => null, (p) => p, { blend: 'mosaic' })).rejects.toThrow('orthorectifyTiled')
  })

  it('labels each cell with the nearest-nadir view, where best follows the noisy matching cost', async () => {
    const s = plane()
    // Matching cost that varies pixel to pixel: 'best' flips with it, 'mosaic' does not.
    const maps = [nadirMap(-2, [255, 0, 0], { cost: (i) => (i * 7) % 11 / 20 }), nadirMap(2, [0, 0, 255], { cost: (i) => (i * 5) % 13 / 20 })]
    const mosaic = await run(s, maps, { blend: 'mosaic', seamWidth: 0, blockSize: 7 })
    for (let r = 0; r < s.height; r++) for (let c = 0; c < s.width; c++) {
      const x = cellX(s, c)
      if (Math.abs(x) < 0.3) continue
      expect(mosaic.labels[r * s.width + c]).toBe(x < 0 ? 0 : 1)
    }
    const best = await run(s, maps, { blend: 'best', blockSize: 7 })
    expect(mosaic.stats.seamDensity).toBeLessThan(best.stats.seamDensity / 5)
    expect(mosaic.covered).toBe(s.width * s.height)
    expect(mosaic.mosaic).toEqual({ seamCells: 0, smoothPasses: 2, balance: null })
  })

  it('a hard seam reproduces the source colours exactly; feathering ramps across the seam', async () => {
    const s = plane()
    const maps = [nadirMap(-2, [200, 40, 40]), nadirMap(2, [40, 40, 200])]
    const hard = await run(s, maps, { blend: 'mosaic', seamWidth: 0 })
    const soft = await run(s, maps, { blend: 'mosaic', seamWidth: 20, blockSize: 9 }) // 4 cells of 20
    expect(soft.mosaic.seamCells).toBe(4)
    const row = 10, at = (res, c) => [...res.rgba.subarray((row * s.width + c) * 4, (row * s.width + c) * 4 + 3)]
    expect(at(hard, 0)).toEqual([200, 40, 40])
    expect(at(hard, s.width - 1)).toEqual([40, 40, 200])
    // Far from the seam both are the pure source; at the seam the feathered one mixes.
    expect(at(soft, 0)).toEqual([200, 40, 40])
    const reds = Array.from({ length: s.width }, (_, c) => at(soft, c)[0])
    for (let c = 1; c < s.width; c++) expect(reds[c]).toBeLessThanOrEqual(reds[c - 1])
    const mid = reds[s.width / 2 - 1]
    expect(mid).toBeGreaterThan(40); expect(mid).toBeLessThan(200)
    expect(soft.stats.seamStep).toBeLessThan(hard.stats.seamStep / 3)
  })

  it('colour balance recovers a 0.7× exposure difference and evens the halves', async () => {
    const s = plane(40, 20, 0.25)
    const bright = 180, dark = linearToSrgb(0.7 * srgbToLinear(bright))
    const maps = [nadirMap(-2, [bright, bright, bright]), nadirMap(2, [dark, dark, dark])]
    // A uniform source photo per map (map pixels = photo pixels).
    const loadImage = async (mi, m) => ({ width: m.width, height: m.height, map: null,
      data: new Uint8ClampedArray(m.width * m.height * 4).fill(mi === 0 ? bright : dark) })
    const off = await run(s, maps, { blend: 'mosaic', seamWidth: 0 }, { loadImage })
    const on = await run(s, maps, { blend: 'mosaic', seamWidth: 0, colourBalance: true }, { loadImage })
    const b = on.mosaic.balance
    expect(b.images).toBe(2)
    expect(b.pairs).toBe(1)
    expect(b.max / b.min).toBeCloseTo(1 / 0.7, 2)
    expect(Math.abs(b.max / b.min * 0.7 - 1)).toBeLessThan(0.01)
    // The overall level is kept: the log gains are centred, so the two gains multiply to 1.
    expect(b.min * b.max).toBeCloseTo(1, 6)
    expect(b.clamped).toBe(0)
    const left = (res) => res.rgba[(10 * s.width + 2) * 4], right = (res) => res.rgba[(10 * s.width + s.width - 3) * 4]
    expect(left(off) - right(off)).toBeGreaterThan(20)
    expect(Math.abs(left(on) - right(on))).toBeLessThanOrEqual(1)
  })

  it('colour balance does not shrink the gains when overlap ratios disagree around a loop', async () => {
    // Four photos in a 2×2 block whose pairwise ratios are inconsistent (the measured
    // exposures differ by channel-noise-like amounts): the linear Brown–Lowe form shrank
    // every gain towards 0 here; the log form keeps the level (geometric mean 1).
    const s = plane(40, 40, 0.25)
    const level = [180, 120, 150, 100]
    const maps = [nadirMap(-2, [0, 0, 0]), nadirMap(2, [0, 0, 0]), nadirMap(-2, [0, 0, 0]), nadirMap(2, [0, 0, 0])]
    maps[2].t = [2, -2, 10]; maps[3].t = [-2, -2, 10]; maps[0].t = [2, 2, 10]; maps[1].t = [-2, 2, 10]
    const loadImage = async (mi, m) => {
      const data = new Uint8ClampedArray(m.width * m.height * 4)
      // A gradient inside each photo makes the overlap means depend on where the overlap is.
      for (let i = 0; i < m.width * m.height; i++) data.fill(Math.min(255, level[mi] + (i % m.width) / 4), 4 * i, 4 * i + 4)
      return { width: m.width, height: m.height, map: null, data }
    }
    const res = await run(s, maps, { blend: 'mosaic', seamWidth: 0, colourBalance: true }, { loadImage })
    const b = res.mosaic.balance
    expect(b.images).toBe(4)
    expect(b.clamped).toBe(0)
    // Without the in-photo gradient the answer is g_i ∝ 1 / lin(level_i) with a geometric
    // mean of 1: 0.53, 1.28, 0.79, 1.89. The gradient perturbs the overlap means by a few %.
    const lin = level.map((v) => srgbToLinear(v)), gm = Math.exp(lin.reduce((s, l) => s + Math.log(l), 0) / 4)
    const want = lin.map((l) => gm / l).sort((a, b) => a - b)
    expect(b.min / want[0]).toBeGreaterThan(0.9); expect(b.min / want[0]).toBeLessThan(1.1)
    expect(b.median / want[2]).toBeGreaterThan(0.9); expect(b.median / want[2]).toBeLessThan(1.1)
    expect(b.max / want[3]).toBeGreaterThan(0.9); expect(b.max / want[3]).toBeLessThan(1.1)
  })

  it('falls back to the pass-1 label where the smoothed label cannot see the cell', async () => {
    const s = plane(20, 10, 0.5)
    // Map 1 sees only the one-cell column at x = 0.75 (map px 30; no depth elsewhere)
    // and map 0 is blind exactly there (map px 38). Pass 1 labels the column 1, the
    // majority relabels it 0 — which cannot see it — so the fallback must colour it.
    const m0 = nadirMap(-2, [255, 0, 0]), m1 = nadirMap(2, [0, 0, 255])
    for (let v = 0; v < 64; v++) for (let u = 0; u < 64; u++) if (u !== 30) m1.depth[v * 64 + u] = 0
    for (let v = 0; v < 64; v++) m0.depth[v * 64 + 38] = 0
    const res = await run(s, [m0, m1], { blend: 'mosaic', seamWidth: 0 })
    expect(res.covered).toBe(s.width * s.height)
    const blue = []
    for (let i = 0; i < s.width * s.height; i++) if (res.rgba[i * 4 + 2] === 255) blue.push(res.labels[i])
    expect(blue.length).toBeGreaterThan(0)
    expect(blue.every((l) => l === 1)).toBe(true)
  })
})
