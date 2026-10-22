import { describe, it, expect } from 'vitest'
import { repairEffect } from './match.js'
import { MATCH_DEFAULTS } from '../defaults.user.js'
import { MATCH_TUNING } from '../tuning.js'

describe('repairEffect', () => {
  it('names the pair budget when on, and what happens to the pieces when off', () => {
    expect(repairEffect(MATCH_DEFAULTS)).toContain(`up to ${MATCH_TUNING.bridgePerComponent} pairs`)
    expect(repairEffect(MATCH_DEFAULTS)).toContain(`(${MATCH_TUNING.bridgeMaxPairs} in all)`)
    expect(repairEffect({ ...MATCH_DEFAULTS, repairSplits: false })).toMatch(/^Off: .* stays in pieces/)
  })
})
