import { describe, it, expect } from 'vitest'
import {
  createMemLedger,
  projectDensePeakBytes,
  projectDensifyPeakBytes,
  projectDensifyPoolBytes,
  accumulatorCellLimit,
  cloudPointLimit,
  densifyInputBytes,
  DENSIFY_CELL_BYTES,
  formatBytes,
  DEFAULT_BUDGET_BYTES,
  MAX_BUDGET_BYTES,
  deviceBudget,
  DENSIFY_STREAMED_REF_BYTES_PER_PX,
  workingPixels,
} from './memBudget.js'

const GiB = 1024 ** 3

describe('deviceBudget', () => {
  it('derives from navigator.deviceMemory (50%, passed through for U2)', () => {
    const b = deviceBudget({ deviceMemoryGB: 8 })
    expect(b.budgetBytes).toBe(4 * GiB) // 50% of 8
    expect(b.deviceMemoryGB).toBe(8)
    expect(b.source).toBe('navigator.deviceMemory')
  })

  it('derives at least 1 GB, and half of what the browser reports past the pool', () => {
    expect(deviceBudget({ deviceMemoryGB: 2 }).budgetBytes).toBe(1 * GiB) // 50%·2 = 1, at floor
    expect(deviceBudget({ deviceMemoryGB: 1 }).budgetBytes).toBe(1 * GiB) // below floor → clamped
    expect(deviceBudget({ deviceMemoryGB: 16 }).budgetBytes).toBe(8 * GiB) // 50% of 16
    // Past the tab's buffer pool: runs held in ArrayBuffers take at most MAX_BUDGET_BYTES of it.
    expect(deviceBudget({ deviceMemoryGB: 32 }).budgetBytes).toBe(16 * GiB)
    expect(deviceBudget({ jsHeapLimitBytes: 64 * GiB }).budgetBytes).toBe(MAX_BUDGET_BYTES)
  })

  it('falls back to the JS-heap limit when deviceMemory is absent (deviceMemoryGB stays null)', () => {
    const b = deviceBudget({ jsHeapLimitBytes: 4 * GiB })
    expect(b.budgetBytes).toBe(3 * GiB) // 75% of 4
    expect(b.deviceMemoryGB).toBeNull() // so U2 falls back to size-based
    expect(b.source).toBe('performance.memory')
  })

  it('prefers deviceMemory over the heap limit when both are present', () => {
    expect(deviceBudget({ deviceMemoryGB: 8, jsHeapLimitBytes: 2 * GiB }).source).toBe('navigator.deviceMemory')
  })

  it('returns the conservative default when nothing is known (Safari/Firefox)', () => {
    for (const readings of [undefined, {}, { deviceMemoryGB: 0 }, { deviceMemoryGB: null, jsHeapLimitBytes: NaN }]) {
      const b = deviceBudget(readings)
      expect(b.budgetBytes).toBe(DEFAULT_BUDGET_BYTES)
      expect(b.source).toBe('default')
      expect(b.deviceMemoryGB).toBeNull()
    }
  })

  it('always carries a human-readable note', () => {
    for (const r of [{ deviceMemoryGB: 8 }, { jsHeapLimitBytes: 3 * GiB }, {}]) {
      expect(typeof deviceBudget(r).note).toBe('string')
      expect(deviceBudget(r).note.length).toBeGreaterThan(0)
    }
  })
})

describe('createMemLedger', () => {
  it('tracks, releases, and reports live + peak usage', () => {
    const l = createMemLedger()
    expect(l.used()).toBe(0)
    l.track('a', 100)
    l.track('b', 50)
    expect(l.used()).toBe(150)
    expect(l.peak()).toBe(150)
    l.release('a')
    expect(l.used()).toBe(50)
    expect(l.peak()).toBe(150) // high-water mark stays
  })

  it('re-tracking a tag replaces its size (resized buffer)', () => {
    const l = createMemLedger()
    l.track('x', 100)
    l.track('x', 300)
    expect(l.used()).toBe(300)
    expect(l.size()).toBe(1)
  })

  it('releasing an unknown tag is a no-op', () => {
    const l = createMemLedger()
    l.track('x', 100)
    l.release('ghost')
    expect(l.used()).toBe(100)
  })
})

describe('projectDensePeakBytes', () => {
  it('counts real working pixels when sizes are given, not maxDim²', () => {
    // A 2 : 1 frame at maxDim 8000 is 8000 × 4000: half the square bound.
    expect(workingPixels(16000, 8000, 8000)).toBe(8000 * 4000)
    expect(workingPixels(1000, 500, 4000)).toBe(1000 * 500) // never upscaled
    expect(workingPixels(0, 0, 300)).toBe(300 * 300) // unknown size: the bound
    const sq = projectDensePeakBytes({ nImages: 4, maxDim: 8000, backend: 'gpu' })
    const px = Array(4).fill(workingPixels(16000, 8000, 8000))
    const real = projectDensePeakBytes({ nImages: 4, maxDim: 8000, backend: 'gpu', pixels: px })
    expect(real.total).toBe(sq.total / 2)
    // Streaming holds one map: the largest, whatever the mix of sizes.
    const mixed = projectDensePeakBytes({
      nImages: 2,
      maxDim: 1000,
      retainedMaps: 1,
      filterMaps: 0,
      pixels: [100, 400],
    })
    expect(mixed.store).toBe(23 * 400)
    expect(mixed.raster).toBe(4 * 500)
  })

  it('sums store + raster with no GPU term on the WASM path', () => {
    const npix = 1000 * 1000
    const p = projectDensePeakBytes({ nImages: 5, maxDim: 1000, backend: 'wasm' })
    expect(p.store).toBe(5 * 23 * npix) // depth 4 + cost 4 + rgb 3 + normals 12
    expect(p.raster).toBe(5 * 4 * npix)
    expect(p.gpu).toBe(0)
    expect(p.total).toBe(p.store + p.raster + p.filter)
  })

  it('adds a GPU transient term on the GPU path', () => {
    const wasm = projectDensePeakBytes({ nImages: 5, maxDim: 1000, backend: 'wasm' })
    const gpu = projectDensePeakBytes({ nImages: 5, maxDim: 1000, backend: 'gpu', nSources: 6 })
    expect(gpu.gpu).toBeGreaterThan(0)
    expect(gpu.total).toBeGreaterThan(wasm.total)
  })

  it('scales with maxDim² and flags an over-budget 8000px run', () => {
    const p = projectDensePeakBytes({ nImages: 5, maxDim: 8000, backend: 'gpu' })
    expect(p.total).toBeGreaterThan(DEFAULT_BUDGET_BYTES) // the reported tab-kill case
  })

  it("charges the cross-view filter's 1 B/px drop mask per map it judges in memory", () => {
    const npix = 1000 * 1000
    const p = projectDensePeakBytes({ nImages: 5, maxDim: 1000 })
    expect(p.filter).toBe(5 * npix) // in-memory filter: every map's mask at once
    expect(p.total).toBe(p.store + p.raster + p.gpu + p.filter)
    // Streamed maps are filtered by a separate pass over the saved maps; off is off.
    expect(projectDensePeakBytes({ nImages: 5, maxDim: 1000, retainedMaps: 1, filterMaps: 0 }).filter).toBe(0)
    expect(projectDensePeakBytes({ nImages: 5, maxDim: 1000, filterMaps: 3 }).filter).toBe(3 * npix)
  })

  it('a lower rasterBytesPerPx (gray-only cache) reduces the raster term', () => {
    const full = projectDensePeakBytes({ nImages: 5, maxDim: 1000, rasterBytesPerPx: 4 })
    const gray = projectDensePeakBytes({ nImages: 5, maxDim: 1000, rasterBytesPerPx: 1 })
    expect(gray.raster).toBeLessThan(full.raster)
  })
})

describe('projectDensifyPeakBytes', () => {
  it('sums input + measured cells × the accumulator footprint', () => {
    // Finishing writes the cloud while it frees the accumulator: no output term on top.
    const p = projectDensifyPeakBytes({ inputBytes: 1000, cells: 3 })
    expect(p.cells).toBe(3)
    expect(p.input).toBe(1000)
    expect(p.accumulator).toBe(3 * DENSIFY_CELL_BYTES)
    expect(p.total).toBe(p.input + p.accumulator)
  })
})

describe('densifyInputBytes', () => {
  // 2×2 maps.
  const mk = () => ({
    width: 2,
    height: 2,
    depth: Float32Array.from([1, 1, 0, 1]),
    cost: Float32Array.from([0.1, 0.1, 0, 0.1]),
    rgb: new Uint8Array(4 * 3),
    normals: new Float32Array(4 * 3),
  })
  const perMap = 4 * 4 + 4 * 4 + 12 + 4 * 12

  it('sums the resident planes, times residency', () => {
    expect(densifyInputBytes([mk(), mk()])).toBe(perMap * 2)
    expect(densifyInputBytes([mk()], { residency: 2 })).toBe(perMap * 2)
  })

  it('bounds a streamed run by the largest reference: its planes, the agree/angle scratch and the eligible-pixel buffers', () => {
    const metas = [
      { width: 10, height: 10, hasNormals: true },
      { width: 20, height: 10, hasNormals: false },
      { width: 5, height: 5, hasNormals: true },
    ]
    // Per map: planes (23 B/px with normals, 11 without) + agree/angle 12 B/px + every
    // pixel eligible, Int32 index + Float64×3 point + Int32 open-list entry = 32 B/px.
    // Comparison planes live in the separately charged cache — no second full map is ever held.
    // 100·(23+12+32) = 6700 vs 200·(11+12+32) = 11000.
    expect(densifyInputBytes(metas, { streamed: true })).toBe(200 * (11 + 12 + 32))
    expect(densifyInputBytes([metas[0], metas[2]], { streamed: true })).toBe(100 * (23 + 12 + 32))
    expect(DENSIFY_STREAMED_REF_BYTES_PER_PX).toBe(12 + 32)
  })
})

describe('formatBytes', () => {
  it('formats GB / MB / KB with one decimal below 10, and a missing value as a dash', () => {
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB')
    expect(formatBytes(1.25 * 1024 ** 4)).toBe('1.3 TB')
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB')
    expect(formatBytes(4 * 1024)).toBe('4.0 KB')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(NaN)).toBe('—')
  })
})

describe('limits past ArrayBuffers', () => {
  it('the accumulator holds 2^27 cells in plain buffers, 2^29 in 4 GiB, 2^30 with Memory64', () => {
    expect(accumulatorCellLimit(2 ** 31 - 2 ** 21)).toBe(2 ** 27)
    expect(accumulatorCellLimit(4 * GiB)).toBe(2 ** 29)
    expect(accumulatorCellLimit(16 * GiB)).toBe(2 ** 30)
  })

  it('the cloud holds 12 B a point of its largest array', () => {
    expect(cloudPointLimit(2 ** 31 - 2 ** 21)).toBe(178782208)
    expect(cloudPointLimit(16 * GiB)).toBe(1431655765)
  })

  it('counts in the pool what stays in ArrayBuffers', () => {
    const plan = { inputBytes: 1000, cells: 1000, tileCells: 250, workers: 2 }
    const all = projectDensifyPeakBytes(plan)
    expect(projectDensifyPoolBytes(plan).total).toBe(all.total)
    const offPool = projectDensifyPoolBytes({ ...plan, accumulatorsInPool: false })
    expect(offPool.fusing).toBe(all.input + all.finished)
    // A cloud whose arrays pass 2 GiB goes to shared memory: only the colour stays.
    const big = { inputBytes: 0, cells: 2e8 }
    expect(projectDensifyPoolBytes({ ...big, accumulatorsInPool: false, sharedPastPlain: true }).total).toBe(0)
    const tiled = projectDensifyPoolBytes({ ...big, tileCells: 1e8, accumulatorsInPool: false, sharedPastPlain: true })
    expect(tiled.assemble).toBe(2 * 1e8 * 27 + 3 * 2e8)
  })
})
