import { describe, it, expect } from 'vitest'
import {
  createMemLedger, projectDensePeakBytes, projectDensifyPeakBytes, densifyInputBytes, DENSIFY_CELL_BYTES, formatBytes, DEFAULT_BUDGET_BYTES,
  deviceBudget,
} from './memBudget.js'

const GiB = 1024 ** 3

describe('deviceBudget', () => {
  it('derives from navigator.deviceMemory (50%, passed through for U2)', () => {
    const b = deviceBudget({ deviceMemoryGB: 8 })
    expect(b.budgetBytes).toBe(4 * GiB) // 50% of 8
    expect(b.deviceMemoryGB).toBe(8)
    expect(b.source).toBe('navigator.deviceMemory')
  })

  it('clamps the device-derived budget into [1, 6] GB', () => {
    expect(deviceBudget({ deviceMemoryGB: 2 }).budgetBytes).toBe(1 * GiB)  // 50%·2 = 1, at floor
    expect(deviceBudget({ deviceMemoryGB: 1 }).budgetBytes).toBe(1 * GiB)  // below floor → clamped
    expect(deviceBudget({ deviceMemoryGB: 32 }).budgetBytes).toBe(6 * GiB) // above ceiling → clamped
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
  it('sums store + raster with no GPU term on the WASM path', () => {
    const npix = 1000 * 1000
    const p = projectDensePeakBytes({ nImages: 5, maxDim: 1000, backend: 'wasm' })
    expect(p.store).toBe(5 * 23 * npix) // depth 4 + cost 4 + rgb 3 + normals 12
    expect(p.raster).toBe(5 * 4 * npix)
    expect(p.gpu).toBe(0)
    expect(p.total).toBe(p.store + p.raster)
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

  it('a lower rasterBytesPerPx (gray-only cache) reduces the raster term', () => {
    const full = projectDensePeakBytes({ nImages: 5, maxDim: 1000, rasterBytesPerPx: 4 })
    const gray = projectDensePeakBytes({ nImages: 5, maxDim: 1000, rasterBytesPerPx: 1 })
    expect(gray.raster).toBeLessThan(full.raster)
  })
})

describe('projectDensifyPeakBytes', () => {
  it('sums input + measured cells × the accumulator and output footprints', () => {
    const p = projectDensifyPeakBytes({ inputBytes: 1000, cells: 3 })
    expect(p.cells).toBe(3)
    expect(p.input).toBe(1000)
    expect(p.accumulator).toBe(3 * DENSIFY_CELL_BYTES)
    expect(p.output).toBe(3 * 36) // 6·4 (pos+col) + 3·4 (normals)
    expect(p.total).toBe(p.input + p.accumulator + p.output)
  })
})

describe('densifyInputBytes', () => {
  // 2×2 maps.
  const mk = () => ({
    width: 2, height: 2,
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

  it('bounds a streamed run by two full maps + the scratch planes of the largest', () => {
    const metas = [
      { width: 10, height: 10, hasNormals: true },
      { width: 20, height: 10, hasNormals: false },
      { width: 5, height: 5, hasNormals: true },
    ]
    // largest two: 100·23 = 2300, 200·11 = 2200; scratch 200·12
    expect(densifyInputBytes(metas, { streamed: true })).toBe(2300 + 2200 + 200 * 12)
  })
})

describe('formatBytes', () => {
  it('formats GB / MB / KB', () => {
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.00 GB')
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB')
    expect(formatBytes(4 * 1024)).toBe('4 KB')
    expect(formatBytes(0)).toBe('0 B')
  })
})
