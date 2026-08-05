import { describe, expect, it } from 'vitest'
import {
  RECOMMENDED_PRESET_ID,
  badgePreset,
  diffRecommendations,
  recommendationLines,
  recommendationPatch,
  recommendedPresetCard,
} from './recommendUi.js'

describe('recommendation UI policy', () => {
  const recs = {
    same: { value: 2, reason: 'already the default' },
    changed: { value: 'auto', reason: 'large source imagery' },
    disabled: { value: false, reason: 'derived boolean' },
  }

  it('shows only derived values that differ from static defaults', () => {
    expect(diffRecommendations(recs, { same: 2, changed: 'off', disabled: true }))
      .toEqual([
        { key: 'changed', value: 'auto', reason: 'large source imagery' },
        { key: 'disabled', value: false, reason: 'derived boolean' },
      ])
  })

  it('turns visible recommendations into an explicit apply patch', () => {
    const items = diffRecommendations(recs, { same: 2, changed: 'off', disabled: true })
    expect(recommendationPatch(items)).toEqual({ changed: 'auto', disabled: false })
  })
})

describe('recommendation as preset metadata', () => {
  const items = [
    { key: 'maxDim', value: 2400, reason: 'Half of the native 4800 px long edge.' },
    { key: 'tiling', value: 'auto', reason: 'Very large scan.' },
  ]
  const labels = { maxDim: 'Detection resolution' }

  it('builds one card carrying every reason, labelled through the label map', () => {
    const card = recommendedPresetCard(items, { labels })
    expect(card.id).toBe(RECOMMENDED_PRESET_ID)
    expect(card.blurb).toBe('Tuned to this dataset · detection resolution · tiling')
    expect(card.title).toBe(
      'Detection resolution = 2400 — Half of the native 4800 px long edge.\n'
      + 'Tiling = auto — Very large scan.',
    )
  })

  // Nothing derived ⇒ no card at all, never an empty one occupying the hero row.
  it('is absent when nothing differs from the defaults', () => {
    expect(recommendedPresetCard([], { labels })).toBeNull()
  })

  it('renders booleans as On/Off in the audit lines', () => {
    expect(recommendationLines([{ key: 'lgTiled', value: false, reason: 'small set' }]))
      .toEqual(['Lg Tiled = Off — small set'])
  })

  it('badges an existing card in place rather than adding a second one', () => {
    const presets = [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }]
    const out = badgePreset(presets, 'high', { title: 'ample memory' })
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ id: 'high', label: 'High', badge: 'Recommended', title: 'ample memory' })
    expect(out[0]).toBe(presets[0]) // untouched entries keep identity
  })

  it('leaves the card list alone when there is no recommended id', () => {
    const presets = [{ id: 'low', label: 'Low' }]
    expect(badgePreset(presets, undefined)).toBe(presets)
  })
})
