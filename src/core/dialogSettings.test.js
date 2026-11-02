import { describe, it, expect } from 'vitest'
import { normalizeSettings, changedSettings, presetName } from './dialogSettings.js'

const defaults = { quality: 'medium', maxDim: null, iterations: 3, methods: ['sor'], filter: true }

describe('normalizeSettings', () => {
  it('keeps what the dialog still has, of the same kind, and drops the rest', () => {
    const { settings, dropped } = normalizeSettings(
      { quality: 'high', maxDim: 2400, iterations: 'x', methods: ['sor', 'radius'], oldKey: 1, filter: false },
      defaults,
    )
    expect(settings).toEqual({
      quality: 'high',
      maxDim: 2400,
      iterations: 3,
      methods: ['sor', 'radius'],
      filter: false,
    })
    expect(dropped.sort()).toEqual(['iterations', 'oldKey'])
    expect(normalizeSettings({ iterations: NaN }, defaults).settings.iterations).toBe(3)
    expect(normalizeSettings(null, defaults).settings).toEqual(defaults)
  })
})

describe('changedSettings', () => {
  it('lists only what differs from the defaults', () => {
    expect(changedSettings({ ...defaults, iterations: 5, methods: ['sor'] }, defaults)).toEqual({ iterations: 5 })
  })
})

describe('presetName', () => {
  it('trims and caps a name, and refuses an empty one', () => {
    expect(presetName('  Film   scans ')).toBe('Film scans')
    expect(presetName('   ')).toBeNull()
    expect(presetName('x'.repeat(80))).toHaveLength(60)
  })
})
