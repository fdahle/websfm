import { describe, it, expect } from 'vitest'
import { repairEffect, onlyNewPairsEffect, onlyNewPairsDefault, selectionPairsEffect, smallDetection } from './match.js'
import { MATCH_DEFAULTS } from '../defaults.user.js'
import { MATCH_TUNING } from '../tuning.js'

describe('repairEffect', () => {
  it('names the pair budget when on, and what happens to the pieces when off', () => {
    expect(repairEffect(MATCH_DEFAULTS)).toContain(`up to ${MATCH_TUNING.bridgePerComponent} pairs`)
    expect(repairEffect(MATCH_DEFAULTS)).toContain(`(${MATCH_TUNING.bridgeMaxPairs} in all)`)
    expect(repairEffect({ ...MATCH_DEFAULTS, repairSplits: false })).toMatch(/^Off: .* stays in pieces/)
  })

  it('says whether pieces still apart are detected again at full size', () => {
    const small = { images: 171, scale: 0.385, nativeMax: 10400 }
    expect(repairEffect(MATCH_DEFAULTS, MATCH_TUNING, small)).toContain(
      'detected again at full size (171 images were detected at 0.39× of up to 10,400 px), with about 65 % as many',
    )
    expect(repairEffect(MATCH_DEFAULTS)).toContain('nothing to detect again')
    expect(repairEffect({ ...MATCH_DEFAULTS, gapRedetect: false }, MATCH_TUNING, small)).toContain(
      'keep the features they were detected with',
    )
  })

  it('counts the SIFT images detected well under their size', () => {
    const im = (detectScale, detector = 'sift', kpStatus = 'done') => ({
      kpStatus,
      detector,
      detectScale,
      meta: { width: 10400, height: 10200 },
    })
    expect(smallDetection([im(0.385), im(0.4), im(0.39), im(1), im(0.3, 'disk'), im(0.3, 'sift', null)])).toEqual({
      images: 3,
      scale: 0.39,
      nativeMax: 10400,
    })
    expect(smallDetection([im(1)])).toEqual({ images: 0, scale: null, nativeMax: 0 })
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
