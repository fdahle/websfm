import { describe, it, expect } from 'vitest'
import { computed, ref } from 'vue'
import { usePresetSettings, presetOwnedKeys, sameSettingValue } from './usePresetSettings.js'
import {
  MATCH_DEFAULTS, MATCH_PRESETS, MATCH_PRESET_META,
  MESH_DEFAULTS, MESH_PRESETS, MESH_PRESET_META,
  RECONSTRUCT_DEFAULTS, RECONSTRUCT_PRESETS, RECONSTRUCT_PRESET_META,
  FILTER_CLOUD_DEFAULTS, FILTER_CLOUD_PRESETS, FILTER_CLOUD_PRESET_META,
  DETECT_SIFT_DEFAULTS, DETECT_SIFT_PRESETS, DETECT_PRESET_META,
} from '../core/defaults.user.js'

const setup = (defaults, presets, cards, extra = {}) => {
  const settings = ref({ ...defaults })
  return { settings, ...usePresetSettings({ settings, defaults, presets, cards, ...extra }) }
}

describe('presetOwnedKeys / sameSettingValue', () => {
  it('unions the keys every preset patches', () => {
    expect(presetOwnedKeys(MATCH_PRESETS).sort()).toEqual(['maxIters', 'minInlierRatio', 'ratioThreshold'])
    expect(presetOwnedKeys(MESH_PRESETS)).toEqual(['depth'])
    expect(presetOwnedKeys({})).toEqual([])
  })
  it('compares arrays by element', () => {
    expect(sameSettingValue(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameSettingValue(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameSettingValue(['a'], 'a')).toBe(false)
    expect(sameSettingValue(1, 1)).toBe(true)
  })
})

describe('usePresetSettings', () => {
  it('opens on medium (≡ the defaults)', () => {
    const p = setup(MATCH_DEFAULTS, MATCH_PRESETS, MATCH_PRESET_META)
    expect(p.activePreset.value).toBe('medium')
    expect(p.baseId.value).toBe('medium')
  })

  it('a match preset patches only the keys presets own', () => {
    const p = setup(MATCH_DEFAULTS, MATCH_PRESETS, MATCH_PRESET_META)
    Object.assign(p.settings.value, {
      preselectMethod: 'footprint', maxNeighbors: 4, minOverlap: 55, sequentialOverlap: 3,
      sequentialLoopClosure: true, lgTiled: true, lgMaxKeypoints: 1024, lgTileBudget: 512,
    })
    p.selectPreset('high')
    expect(p.settings.value).toMatchObject({
      ...MATCH_PRESETS.high,
      preselectMethod: 'footprint', maxNeighbors: 4, minOverlap: 55, sequentialOverlap: 3,
      sequentialLoopClosure: true, lgTiled: true, lgMaxKeypoints: 1024, lgTileBudget: 512,
    })
    expect(p.activePreset.value).toBe('high')
    expect(p.baseId.value).toBe('high')
    // Back to Balanced restores the owned keys Strict changed — including maxIters,
    // which only Strict patches.
    p.selectPreset('medium')
    expect(p.settings.value.maxIters).toBe(MATCH_DEFAULTS.maxIters)
    expect(p.settings.value.ratioThreshold).toBe(MATCH_DEFAULTS.ratioThreshold)
    expect(p.settings.value.lgTiled).toBe(true)
  })

  it('an orthogonal edit keeps the card; an owned edit shows custom', () => {
    const p = setup(MATCH_DEFAULTS, MATCH_PRESETS, MATCH_PRESET_META)
    p.settings.value = { ...p.settings.value, lgTiled: true } // Full density
    expect(p.activePreset.value).toBe('medium')
    p.settings.value = { ...p.settings.value, ratioThreshold: 0.7 }
    expect(p.activePreset.value).toBe('custom')
    expect(p.baseId.value).toBe('medium') // the "· modified" tag + Reset target
    p.selectPreset(p.baseId.value)
    expect(p.activePreset.value).toBe('medium')
  })

  it('a mesh preset changes only the depth', () => {
    const p = setup(MESH_DEFAULTS, MESH_PRESETS, MESH_PRESET_META)
    Object.assign(p.settings.value, { trim: 'off', fillHoles: false, removeFloaters: false, colorize: false })
    p.selectPreset('high')
    expect(p.settings.value).toEqual({ ...MESH_DEFAULTS, depth: 10, trim: 'off', fillHoles: false, removeFloaters: false, colorize: false })
    expect(p.activePreset.value).toBe('high')
  })

  it('reconstruct presets own the BA iterations and reprojection gate', () => {
    const p = setup(RECONSTRUCT_DEFAULTS, RECONSTRUCT_PRESETS, RECONSTRUCT_PRESET_META)
    p.settings.value.refineIntrinsics = 'f'
    p.selectPreset('low')
    expect(p.settings.value).toEqual({ ...RECONSTRUCT_DEFAULTS, ...RECONSTRUCT_PRESETS.low, refineIntrinsics: 'f' })
    expect(p.activePreset.value).toBe('low')
  })

  it('filter presets compare and copy the ordered methods list', () => {
    const p = setup(FILTER_CLOUD_DEFAULTS, FILTER_CLOUD_PRESETS, FILTER_CLOUD_PRESET_META)
    p.settings.value.methods = ['sor']
    expect(p.activePreset.value).toBe('medium')
    p.selectPreset('strong')
    expect(p.settings.value.methods).toEqual(['isolated', 'sor'])
    expect(p.settings.value.methods).not.toBe(FILTER_CLOUD_PRESETS.strong.methods) // a copy
    p.settings.value.methods.push('voxel')
    expect(FILTER_CLOUD_PRESETS.strong.methods).toEqual(['isolated', 'sor'])
    expect(p.activePreset.value).toBe('custom')
    p.settings.value.sorK = 30 // not owned
    p.selectPreset('strong')
    expect(p.activePreset.value).toBe('strong')
    expect(p.settings.value.sorK).toBe(30)
  })

  it('checks cards in order, so the first matching one wins', () => {
    const settings = ref({ a: 1, b: 2 })
    const p = usePresetSettings({
      settings, defaults: { a: 1, b: 2 },
      presets: { rec: { a: 1 }, medium: {}, low: { a: 0 } }, cards: ['rec', 'medium', 'low'],
    })
    expect(p.activePreset.value).toBe('rec')
  })

  it('follows reactive defaults/presets and a writable computed target (Detect: per detector)', () => {
    const detector = ref('sift')
    const store = ref({ sift: { ...DETECT_SIFT_DEFAULTS }, other: { maxDim: 500, maxDimMode: 'absolute', maxKeypoints: 50 } })
    const settings = computed({
      get: () => store.value[detector.value],
      set: (v) => { store.value = { ...store.value, [detector.value]: v } },
    })
    const presets = computed(() => (detector.value === 'sift' ? DETECT_SIFT_PRESETS : { low: { maxDim: 100 }, medium: {} }))
    const defaults = computed(() => (detector.value === 'sift' ? DETECT_SIFT_DEFAULTS : { maxDim: 500, maxDimMode: 'absolute', maxKeypoints: 50 }))
    const p = usePresetSettings({ settings, defaults, presets, cards: DETECT_PRESET_META })
    settings.value = { ...settings.value, maxDimMode: 'auto' } // orthogonal mode
    expect(p.activePreset.value).toBe('medium')
    p.selectPreset('high')
    expect(store.value.sift).toMatchObject({ ...DETECT_SIFT_PRESETS.high, maxDimMode: 'auto' })
    detector.value = 'other'
    expect(p.ownedKeys.value).toEqual(['maxDim'])
    expect(p.activePreset.value).toBe('medium')
    p.selectPreset('low')
    expect(store.value.other.maxDim).toBe(100)
    expect(store.value.sift.maxDim).toBe(DETECT_SIFT_PRESETS.high.maxDim)
  })

  it('honours explicit ownedKeys', () => {
    const settings = ref({ a: 1, b: 2 })
    const p = usePresetSettings({ settings, defaults: { a: 1, b: 2 }, presets: { medium: {}, x: { a: 5 } }, ownedKeys: ['a', 'b'] })
    settings.value.b = 3
    expect(p.activePreset.value).toBe('custom')
    p.selectPreset('x')
    expect(settings.value).toEqual({ a: 5, b: 2 })
  })
})
