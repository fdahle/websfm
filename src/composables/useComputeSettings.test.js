import { beforeEach, describe, expect, it, vi } from 'vitest'

const GiB = 1024 ** 3

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }
}

describe('useComputeSettings hardware budget wiring', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('navigator', { hardwareConcurrency: 8, deviceMemory: 8 })
    vi.stubGlobal('localStorage', memoryStorage())
  })

  it('uses the detected budget and supplies device memory to recommendations', async () => {
    const { useComputeSettings } = await import('./useComputeSettings.js')
    const settings = useComputeSettings()

    expect(settings.memBudgetAuto.value).toBe(true)
    expect(settings.memBudgetGb.value).toBe(4)
    expect(settings.memBudgetBytes.value).toBe(4 * GiB)
    expect(settings.deviceBudgetInfo.source).toBe('navigator.deviceMemory')

    const recs = settings.recommendForDataset({ nImages: 5, scale: 'small' })
    expect(recs.depthmap.quality.value).toBe('high')
    expect(recs.depthmap.quality.reason).toContain('8 GB')
  })

  it('preserves a manual safety limit and can reset it to automatic', async () => {
    const storage = memoryStorage({ 'websfm.dense.memBudgetGb': '3' })
    vi.stubGlobal('localStorage', storage)
    const { useComputeSettings } = await import('./useComputeSettings.js')
    const settings = useComputeSettings()

    expect(settings.memBudgetAuto.value).toBe(false)
    expect(settings.memBudgetBytes.value).toBe(3 * GiB)

    settings.setMemBudgetGb(1.5)
    expect(storage.getItem('websfm.dense.memBudgetGb')).toBe('1.5')
    expect(settings.memBudgetBytes.value).toBe(1.5 * GiB)

    settings.resetMemBudgetAuto()
    expect(settings.memBudgetAuto.value).toBe(true)
    expect(settings.memBudgetGb.value).toBe(4)
    expect(storage.getItem('websfm.dense.memBudgetGb')).toBeNull()
  })
})
