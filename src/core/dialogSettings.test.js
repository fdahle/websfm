import { describe, it, expect } from 'vitest'
import {
  normalizeSettings,
  changedSettings,
  presetName,
  renamePreset,
  withPreset,
  withoutPreset,
} from './dialogSettings.js'

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

describe('named presets', () => {
  const all = {
    'dense-cloud': [
      { name: 'Fast', settings: { q: 1 } },
      { name: 'Mine', settings: { q: 2 } },
    ],
    'dem': [{ name: 'Fine', settings: { gsd: 0.05 } }],
  }

  it('adds or replaces a preset, sorted, without touching the input', () => {
    const next = withPreset(all, 'dense-cloud', 'Alpha', { q: 3 })
    expect(next['dense-cloud'].map((p) => p.name)).toEqual(['Alpha', 'Fast', 'Mine'])
    expect(withPreset(all, 'dense-cloud', 'Fast', { q: 9 })['dense-cloud'][0]).toEqual({
      name: 'Fast',
      settings: { q: 9 },
    })
    expect(withPreset({}, 'mesh', 'Big', {})).toEqual({ mesh: [{ name: 'Big', settings: {} }] })
    expect(all['dense-cloud']).toHaveLength(2)
  })

  it('removes a preset, and a dialog left with none', () => {
    expect(withoutPreset(all, 'dense-cloud', 'Fast')['dense-cloud'].map((p) => p.name)).toEqual(['Mine'])
    expect(withoutPreset(all, 'dem', 'Fine')).toEqual({ 'dense-cloud': all['dense-cloud'] })
  })

  it('renames a preset, keeping its settings, and refuses a clash or an empty name', () => {
    const { all: next } = renamePreset(all, 'dense-cloud', 'Mine', '  Arch  sites ')
    expect(next['dense-cloud']).toEqual([
      { name: 'Arch sites', settings: { q: 2 } },
      { name: 'Fast', settings: { q: 1 } },
    ])
    expect(renamePreset(all, 'dense-cloud', 'Mine', 'Fast')).toEqual({ error: 'taken' })
    expect(renamePreset(all, 'dense-cloud', 'Mine', '   ')).toEqual({ error: 'empty' })
    expect(renamePreset(all, 'dense-cloud', 'Nope', 'X')).toEqual({ error: 'missing' })
    expect(renamePreset(all, 'dense-cloud', 'Mine', 'Mine')).toEqual({ all })
  })
})
