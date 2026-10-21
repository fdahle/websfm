import { describe, it, expect } from 'vitest'
import {
  orthorectify, orthorectifyStreamed, orthorectifyTiled, smoothLabels, chamferTo, srgbToLinear, linearToSrgb,
  mosaicSeamCells, orthoHalo, orthoTiledWorkingBytes, orthoCacheLog, chooseGroupSize, NO_LABEL,
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
    if (b.labels) labels.set(b.labels.subarray(r * b.width, (r + 1) * b.width), (b.row0 + r) * W + b.col0)
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
    expect(mosaic.mosaic).toEqual({ seamline: 'nadir', seamBlend: 'feather', seamCells: 0, smoothPasses: 2, levels: 0, seamCut: null, balance: null })
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
    // A gradient inside each photo makes the overlap means depend on where the overlap is.
    // A map's own rgb plane is its photo at the depth map's scale (dense builds it from
    // the same decode), so it carries the same colours: the survey may sample either.
    const photoValue = (mi, i, w) => Math.min(255, level[mi] + (i % w) / 4)
    maps.forEach((m, mi) => { for (let i = 0; i < m.width * m.height; i++) m.rgb.fill(Math.round(photoValue(mi, i, m.width)), 3 * i, 3 * i + 3) })
    const loadImage = async (mi, m) => {
      const data = new Uint8ClampedArray(m.width * m.height * 4)
      for (let i = 0; i < m.width * m.height; i++) data.fill(photoValue(mi, i, m.width), 4 * i, 4 * i + 4)
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
    // Map 1 sees only the one-cell column at x = 0.75 (map px 30; something nearer
    // occludes the rest) and map 0 is occluded exactly there (map px 38). Pass 1 labels
    // the column 1, the majority relabels it 0 — which cannot see it — so the fallback
    // must colour it.
    const m0 = nadirMap(-2, [255, 0, 0]), m1 = nadirMap(2, [0, 0, 255])
    for (let v = 0; v < 64; v++) for (let u = 0; u < 64; u++) if (u !== 30) m1.depth[v * 64 + u] = 5
    for (let v = 0; v < 64; v++) m0.depth[v * 64 + 38] = 5
    const res = await run(s, [m0, m1], { blend: 'mosaic', seamWidth: 0 })
    expect(res.covered).toBe(s.width * s.height)
    const blue = []
    for (let i = 0; i < s.width * s.height; i++) if (res.rgba[i * 4 + 2] === 255) blue.push(res.labels[i])
    expect(blue.length).toBeGreaterThan(0)
    expect(blue.every((l) => l === 1)).toBe(true)
  })
})

describe('depth-map holes', () => {
  it('a photo sees across a small hole in its depth map, never through a nearer surface', async () => {
    const s = plane(40, 20, 0.25)
    // Map 0 (most nadir on the left) has a 3-px hole in its depth map and, elsewhere,
    // a 3-px patch of a nearer surface; map 1 sees everything.
    const m0 = nadirMap(-2, [255, 0, 0]), m1 = nadirMap(2, [0, 0, 255])
    for (let v = 29; v < 32; v++) for (let u = 33; u < 36; u++) m0.depth[v * 64 + u] = 0
    for (let v = 34; v < 37; v++) for (let u = 33; u < 36; u++) m0.depth[v * 64 + u] = 5
    const res = await run(s, [m0, m1], { blend: 'mosaic', seamWidth: 0, seamline: 'nadir' })
    // Ground under map 0's pixel (u, v): x = (u − 32)/2 − 2, y = (32 − v)/2.
    const label = (u, v) => {
      const c = Math.floor(((u - 32) / 2 - 2 - s.originX) / s.gsd), r = Math.floor((s.originY - (32 - v) / 2) / s.gsd)
      return res.labels[r * s.width + c]
    }
    expect(label(34, 30)).toBe(0) // the hole: still map 0
    expect(label(34, 35)).toBe(1) // occluded in map 0: map 1
  })
})

describe('graph-cut seamlines and multiband blending', () => {
  // A "building" on the nadir seam (x = 0): ground x ∈ [−0.75, 0.75], y ∈ [−1, 1]. Map 0
  // shows it grey like the ground around it, map 1 shows it red (its relief lean).
  const B = { x0: -0.75, x1: 0.75, y0: -1, y1: 1 }
  const photo = (mi, m) => {
    const data = new Uint8ClampedArray(m.width * m.height * 4).fill(128)
    if (mi === 1) {
      // Map 1 (camera at x = 2): u = 2(x − 2) + 32, v = 32 − 2y.
      for (let v = 0; v < m.height; v++) for (let u = 0; u < m.width; u++) {
        const x = (u - 32) / 2 + 2, y = (32 - v) / 2
        if (x >= B.x0 && x <= B.x1 && y >= B.y0 && y <= B.y1) data.set([255, 0, 0, 255], 4 * (v * m.width + u))
      }
    }
    return { width: m.width, height: m.height, map: null, data }
  }
  const inBuilding = (s, c, r) => {
    const x = cellX(s, c), y = s.originY - (r + 0.5) * s.gsd
    return x > B.x0 && x < B.x1 && y > B.y0 && y < B.y1
  }
  it('routes the seam around a building the photos disagree on; nadir cuts through it', async () => {
    const s = plane(40, 20, 0.25)
    const maps = [nadirMap(-2, [0, 0, 0]), nadirMap(2, [0, 0, 0])]
    const sources = async (opts) => {
      const res = await run(s, maps, { blend: 'mosaic', seamWidth: 0, ...opts }, { loadImage: async (mi, m) => photo(mi, m) })
      const set = new Set()
      for (let r = 0; r < s.height; r++) for (let c = 0; c < s.width; c++) if (inBuilding(s, c, r)) set.add(res.labels[r * s.width + c])
      return { res, set }
    }
    const nadir = await sources({ seamline: 'nadir' })
    expect(nadir.set.size).toBe(2)
    const cut = await sources({ seamline: 'graphcut', blockSize: 7 })
    expect(cut.set.size).toBe(1)
    const sc = cut.res.mosaic.seamCut
    expect(sc.factor).toBe(1)
    expect(sc.energy).toBeLessThan(sc.energyNadir)
    expect(sc.changedCells).toBeGreaterThan(0)
    expect(cut.res.mosaic.smoothPasses).toBe(0)
    // Far from the building the nearest-nadir partition stands.
    for (let c = 0; c < s.width; c++) if (Math.abs(cellX(s, c)) > 1.5) expect(cut.res.labels[c]).toBe(cellX(s, c) < 0 ? 0 : 1)
  })

  it('multiband hides an exposure step, and leaves the photos alone away from the seam', async () => {
    const s = plane(80, 12, 0.125)
    const maps = [nadirMap(-2, [0, 0, 0]), nadirMap(2, [0, 0, 0])]
    const loadImage = async (mi, m) => ({ width: m.width, height: m.height, map: null,
      data: new Uint8ClampedArray(m.width * m.height * 4).fill(mi ? 90 : 170) })
    const hard = await run(s, maps, { blend: 'mosaic', seamWidth: 0 }, { loadImage })
    const mb = await run(s, maps, { blend: 'mosaic', seamBlend: 'multiband', blendLevels: 2, blockSize: 11 }, { loadImage })
    expect(mb.mosaic.levels).toBe(2)
    expect(mb.mosaic.seamBlend).toBe('multiband')
    expect(mb.stats.seamStep).toBeLessThan(hard.stats.seamStep / 4)
    const row = 6, red = (res, c) => res.rgba[(row * s.width + c) * 4]
    expect(red(mb, 0)).toBe(170)
    expect(red(mb, s.width - 1)).toBe(90)
    for (let c = 1; c < s.width; c++) expect(red(mb, c)).toBeLessThanOrEqual(red(mb, c - 1))
    // Labels are the hard partition; the blend only changes colours.
    expect([...mb.labels]).toEqual([...hard.labels])
  })
})

describe('the map/photo cache against one block', () => {
  it('reports the most maps one block sees', async () => {
    let seen = null
    await run(plane(), [nadirMap(-2, [200, 0, 0]), nadirMap(2, [0, 0, 200])], { blend: 'best' },
      { onBlocksStart: (n, info) => { seen = { n, ...info } } })
    expect(seen).toMatchObject({ n: 1, maxMaps: 2, groups: 1, groupMaps: 2 })
  })

  it('warns when fewer entries fit than one block needs, and says what helps', () => {
    const MB = 1024 ** 2
    const ok = orthoCacheLog(4000 * MB, 100 * MB, 30, { mosaic: true })
    expect(ok[1]).toBe('info')
    expect(ok[0]).toMatch(/holds about 40 depth maps with their photos \(up to 100 MB each\); one block sees up to 30 maps$/)
    const tight = orthoCacheLog(1000 * MB, 100 * MB, 30, { mosaic: true })
    expect(tight[1]).toBe('warn')
    expect(tight[0]).toMatch(/holds about 10 .* its passes re-read and re-decode the photos .* coarser GSD .* higher memory budget/)
    expect(orthoCacheLog(1000 * MB, 100 * MB, 30, { streamed: false })[0]).toMatch(/about 10 decoded photos .* it re-reads/)
  })
})

describe('blocks in groups (P6)', () => {
  // Four nadir views over a 40 × 24 plane in 8-cell blocks (5 × 3 = 15 blocks), each view
  // tinted, with a little cost so the seams have something to choose by.
  const views = () => [nadirMap(-3, [200, 40, 40]), nadirMap(-1, [40, 200, 40]), nadirMap(1, [40, 40, 200]),
    nadirMap(3, [200, 200, 40], { cost: (i) => (i % 7) / 20 })]
  // A photo per map: its own rgb plane as RGBA, counted.
  const photos = (maps) => {
    const load = async (mi) => {
      load.calls++
      const m = maps[mi], data = new Uint8ClampedArray(m.width * m.height * 4)
      for (let i = 0; i < m.width * m.height; i++) data.set([m.rgb[3 * i], m.rgb[3 * i + 1], m.rgb[3 * i + 2], 255], 4 * i)
      return { data, width: m.width, height: m.height, map: null }
    }
    load.calls = 0
    return load
  }
  const variants = [
    { blend: 'best' }, { blend: 'average' },
    { blend: 'mosaic', seamline: 'nadir', seamBlend: 'feather', seamWidth: 2 },
    { blend: 'mosaic', seamline: 'graphcut', seamBlend: 'multiband', colourBalance: true, seamCutCells: 64 },
  ]
  for (const v of variants) {
    it(`computes the same ortho grouped as block by block (${v.blend}${v.seamBlend ? ` · ${v.seamBlend}` : ''})`, async () => {
      const surface = plane(40, 24)
      const one = await run(surface, views(), { ...v, blockSize: 8, fillRadius: 1, groupBlocks: 1 }, { loadImage: photos(views()) })
      for (const g of [2, 4, 15]) {
        const grouped = await run(surface, views(), { ...v, blockSize: 8, fillRadius: 1, groupBlocks: g }, { loadImage: photos(views()) })
        expect(grouped.groups).toBeLessThan(one.groups)
        expect(Buffer.from(grouped.rgba).equals(Buffer.from(one.rgba))).toBe(true)
        expect(Buffer.from(grouped.labels).equals(Buffer.from(one.labels))).toBe(true)
        expect(grouped.covered).toBe(one.covered)
      }
    })
  }

  it('reads each photo once per pass of a group instead of once per block, when the cache holds none', async () => {
    const surface = plane(40, 24), v = { blend: 'mosaic', seamline: 'nadir', seamBlend: 'multiband', blockSize: 8, cacheBytes: 1, mapsResident: false }
    const byBlock = photos(views()), byGroup = photos(views())
    const a = await run(surface, views(), { ...v, groupBlocks: 1 }, { loadImage: byBlock })
    const b = await run(surface, views(), { ...v, groupBlocks: 15 }, { loadImage: byGroup })
    // One group of all 15 blocks: two photo passes × 4 maps.
    expect(byGroup.calls).toBe(8)
    expect(byBlock.calls).toBeGreaterThan(4 * byGroup.calls)
    expect(Buffer.from(b.rgba).equals(Buffer.from(a.rgba))).toBe(true)
  })
})

describe('choosing the group size (P6)', () => {
  // 6 × 5 blocks; one map centred on each block, seeing it and its 8 neighbours.
  const nbx = 6, nby = 5
  const blocks = []
  for (let by = 0; by < nby; by++) for (let bx = 0; bx < nbx; bx++) {
    const maps = []
    for (let my = 0; my < nby; my++) for (let mx = 0; mx < nbx; mx++) if (Math.abs(mx - bx) <= 1 && Math.abs(my - by) <= 1) maps.push(my * nbx + mx)
    blocks.push({ maps })
  }
  const MB = 2 ** 20
  it('groups blocks when the cache cannot keep a row of them, and says what it predicts', () => {
    // 5 entries: fewer than one block's 9 maps.
    const r = chooseGroupSize(nbx, nby, blocks, 3, true, { cacheBytes: 5 * 100 * MB + 8 * 10 * MB, blockBytes: 10 * MB, entryBytes: 100 * MB })
    expect(r.size).toBeGreaterThan(1)
    expect(r.predicted[r.size]).toBeLessThan(0.97 * r.predicted[1])
  })
  it('stays block by block when the cache holds everything', () => {
    const r = chooseGroupSize(nbx, nby, blocks, 3, true, { cacheBytes: 40 * 100 * MB, blockBytes: 300 * MB, entryBytes: 100 * MB })
    expect(r.size).toBe(1)
  })
  it('replays expected bytes: small real entries make block by block cheap, as the run finds', () => {
    const budget = { cacheBytes: 5 * 100 * MB + 8 * 10 * MB, blockBytes: 10 * MB, entryBytes: 100 * MB }
    const worst = chooseGroupSize(nbx, nby, blocks, 3, true, budget)
    // Planes 10 MB, photos 20 MB at their decode size: ~19 entries fit, more than a block's 9 maps.
    const sizes = blocks.map(() => ({ map: 10 * MB, photo: 20 * MB }))
    const real = chooseGroupSize(nbx, nby, blocks, 3, true, { ...budget, entrySizes: sizes })
    expect(real.predicted[1]).toBeLessThan(0.6 * worst.predicted[1])
    expect(real.size).toBeLessThanOrEqual(worst.size)
  })

  it('counts a colour pass as decoding only the maps that own part of a block', () => {
    const budget = { cacheBytes: 5 * 100 * MB + 8 * 10 * MB, blockBytes: 10 * MB, entryBytes: 100 * MB }
    const all = chooseGroupSize(nbx, nby, blocks, 3, true, budget)
    // The cut gives each block to its centre map alone.
    const owners = blocks.map((_, bi) => new Set([bi]))
    const owned = chooseGroupSize(nbx, nby, blocks, 3, true, { ...budget, owners })
    expect(owned.predicted[1]).toBeLessThan(0.6 * all.predicted[1])
  })

  it('never lets the groups take the whole cache', () => {
    const r = chooseGroupSize(nbx, nby, blocks, 3, true, { cacheBytes: 3 * 100 * MB, blockBytes: 200 * MB, entryBytes: 100 * MB })
    expect(Object.keys(r.predicted).map(Number).every((g) => 3 * 100 - (g - 1) * 200 >= 100)).toBe(true)
  })
})

describe('the mosaic survey without photo decodes (P6)', () => {
  it('samples the gains and seams from the maps\' own colour when it is as fine as the survey needs', async () => {
    const maps = [nadirMap(-2, [180, 90, 60]), nadirMap(2, [120, 160, 90])]
    let statsCalls = 0
    const loadStatsImage = async () => { statsCalls++; return null }
    const res = await run(plane(40, 24), maps, { blend: 'mosaic', seamline: 'graphcut', seamBlend: 'multiband', colourBalance: true, seamCutCells: 64 },
      { loadStatsImage })
    // 2 map px per unit at 0.25 units a cell, a gain step of 4 cells: 2 map px per step.
    expect(res.surveyFromMapRgb).toBe(2)
    expect(statsCalls).toBe(0)
    expect(res.mosaic.balance.images).toBe(2)
  })
})

describe('a photo decode the browser refuses memory for', () => {
  it('halves the cache and decodes the photo again, so the ortho is unchanged', async () => {
    const views = () => [nadirMap(-2, [200, 40, 40]), nadirMap(2, [40, 40, 200])]
    const photo = (maps) => async (mi) => {
      const m = maps[mi], data = new Uint8ClampedArray(m.width * m.height * 4)
      for (let i = 0; i < m.width * m.height; i++) data.set([m.rgb[3 * i], m.rgb[3 * i + 1], m.rgb[3 * i + 2], 255], 4 * i)
      return { data, width: m.width, height: m.height, map: null }
    }
    const opts = { blend: 'best', blockSize: 8, cacheBytes: 2 ** 30, mapsResident: false }
    const clean = await run(plane(40, 24), views(), opts, { loadImage: photo(views()) })
    const maps = views(), ok = photo(maps)
    let refused = 0
    const flaky = async (mi, m, per, o = {}) => {
      if (mi === 1 && !refused && o.rethrowOutOfMemory) { refused++; throw Object.assign(new Error('Out of memory at ImageData creation'), { outOfMemory: true }) }
      return ok(mi, m, per)
    }
    const res = await run(plane(40, 24), maps, opts, { loadImage: flaky })
    expect(refused).toBe(1)
    expect(res.cacheShrinks).toBe(1)
    expect(res.cacheLimit).toBeLessThan(2 ** 30)
    expect(Buffer.from(res.rgba).equals(Buffer.from(clean.rgba))).toBe(true)
  })
})

describe('a frame with no exact affine (a projected CRS, the curvature restored)', () => {
  // The surface sinks with the square of the distance from its centre: smooth, never
  // affine, as a projected CRS with the Earth's curvature restored is.
  const curved = (p) => [p[0], p[1], p[2] - (p[0] * p[0] + p[1] * p[1]) / 4e4]
  // The fourth camera, 30 units off, sees none of the plane: every block culls it.
  const maps = () => [nadirMap(-3, [200, 40, 40]), nadirMap(-1, [40, 200, 40]), nadirMap(2, [40, 40, 200]), nadirMap(30, [9, 9, 9])]
  for (const blend of ['best', 'average']) {
    it(`takes tile affines for the cells and culls with them, as the exact frame colours (${blend})`, async () => {
      const surface = plane(40, 24), geom = resampledGeometry(surface, 0)
      const exact = await orthorectifyStreamed(surface, maps(), async (i) => maps()[i], curved, { blend, fillRadius: 0 })
      const blocks = []
      const tiled = await orthorectifyTiled(surface, geom, maps(), async (i) => maps()[i], curved,
        { blend, fillRadius: 0, mapsResident: true, blockSize: 8 }, { onBlock: (b) => blocks.push(b) })
      const rgba = new Uint8ClampedArray(40 * 24 * 4)
      for (const b of blocks) for (let r = 0; r < b.height; r++) {
        rgba.set(b.rgba.subarray(r * b.width * 4, (r + 1) * b.width * 4), ((b.row0 + r) * 40 + b.col0) * 4)
      }
      let worst = 0
      for (let i = 0; i < rgba.length; i++) worst = Math.max(worst, Math.abs(rgba[i] - exact.rgba[i]))
      expect(worst).toBeLessThanOrEqual(1)
      expect(tiled.covered).toBe(exact.covered)
      // Culled with the blocks' own affines: 15 blocks × the 3 cameras that see them.
      expect(tiled.visits).toBe(15 * 3)
    })
  }
})
