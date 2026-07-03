import { describe, it, expect } from 'vitest'
import {
  createMemLedger, projectDensePeakBytes, formatBytes, DEFAULT_BUDGET_BYTES,
} from './memBudget.js'

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
    expect(p.store).toBe(5 * 11 * npix)
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

describe('formatBytes', () => {
  it('formats GB / MB / KB', () => {
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.00 GB')
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB')
    expect(formatBytes(4 * 1024)).toBe('4 KB')
    expect(formatBytes(0)).toBe('0 B')
  })
})
