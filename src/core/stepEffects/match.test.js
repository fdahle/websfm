import { describe, it, expect } from 'vitest'
import { repairEffect, onlyNewPairsEffect, onlyNewPairsDefault, selectionPairsEffect } from './match.js'
import { MATCH_DEFAULTS } from '../defaults.user.js'
import { MATCH_TUNING } from '../tuning.js'

describe('repairEffect', () => {
  it('names the pair budget when on, and what happens to the pieces when off', () => {
    expect(repairEffect(MATCH_DEFAULTS)).toContain(`up to ${MATCH_TUNING.bridgePerComponent} pairs`)
    expect(repairEffect(MATCH_DEFAULTS)).toContain(`(${MATCH_TUNING.bridgeMaxPairs} in all)`)
    expect(repairEffect({ ...MATCH_DEFAULTS, repairSplits: false })).toMatch(/^Off: .* stays in pieces/)
  })
})

describe('selectionPairsEffect', () => {
  it('counts the pairs with one of the selected images', () => {
    expect(selectionPairsEffect('exhaustive', { k: 2, n: 10 })).toBe(
      '2 selected images with every other image: 17 pairs.',
    )
    expect(selectionPairsEffect('preselect', { k: 2, n: 10 })).toMatch(/preselection chooses, those with one of them/)
    expect(selectionPairsEffect('exhaustive', { k: 0, n: 10 })).toMatch(/^None of the selected images/)
  })
})

describe('Match only new pairs', () => {
  it('starts on only when matched pairs exist and some images are in none of them', () => {
    expect(onlyNewPairsDefault({ matchedPairs: 120, unpairedImages: 8 })).toBe(true)
    expect(onlyNewPairsDefault({ matchedPairs: 120, unpairedImages: 0 })).toBe(false)
    expect(onlyNewPairsDefault({ matchedPairs: 0, unpairedImages: 30 })).toBe(false)
  })
  it('says which pairs keep their result', () => {
    const p = { matchedPairs: 120, unpairedImages: 8 }
    expect(onlyNewPairsEffect({ onlyNewPairs: true }, p)).toBe(
      'The 120 pairs already matched keep their result; only the others are matched (8 images in no pair yet).',
    )
    expect(onlyNewPairsEffect({ onlyNewPairs: false }, p)).toMatch(/^The 120 pairs already matched are matched again/)
    expect(onlyNewPairsEffect({ onlyNewPairs: true }, { matchedPairs: 0 })).toBe('')
  })
})
