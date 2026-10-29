import { describe, it, expect } from 'vitest'
import { BROWSER_FEATURES, browserWarnings, featureReport, missingFeatures } from './browserSupport.js'

// What the probe answered in Chrome 156 (Linux, NVIDIA) and Firefox 144 under
// Playwright on 2026-10-30.
const chrome = {
  storage: true,
  webgl2: true,
  webgpu: true,
  isolated: true,
  sharedMemory: true,
  simd: true,
  memory64: true,
  folderAccess: true,
  savePicker: true,
  deviceMemoryGB: 32,
}
const firefox = { ...chrome, webgpu: false, folderAccess: false, savePicker: false, deviceMemoryGB: null }

describe('browser support', () => {
  it('finds nothing missing in Chrome', () => {
    expect(missingFeatures(chrome)).toEqual([])
    expect(browserWarnings(chrome)).toEqual([])
  })

  it('names what Firefox lacks, and warns only about what matters', () => {
    expect(missingFeatures(firefox).map((f) => f.id)).toEqual(['webgpu', 'deviceMemory', 'folderAccess', 'savePicker'])
    expect(browserWarnings(firefox).map((w) => w.id)).toEqual(['webgpu', 'deviceMemory', 'folderAccess'])
  })

  it('needs isolation, shared memory and SIMD together for threads', () => {
    for (const key of ['isolated', 'sharedMemory', 'simd']) {
      expect(missingFeatures({ ...chrome, [key]: false }).map((f) => f.id)).toEqual(['threads'])
    }
  })

  it('treats an unknown probe as missing everything', () => {
    expect(missingFeatures(null)).toHaveLength(BROWSER_FEATURES.length)
  })

  it('reports every feature for System info, each with what it costs', () => {
    const report = featureReport(firefox)
    expect(report.map((f) => f.id)).toEqual(BROWSER_FEATURES.map((f) => f.id))
    expect(report.find((f) => f.id === 'storage').ok).toBe(true)
    for (const f of BROWSER_FEATURES) {
      expect(f.label).toBeTruthy()
      expect(f.without).toMatch(/\.$/)
    }
  })
})
