import { expect, it } from 'vitest'
import { laterPassSpan, pairPassEnd, spanFraction } from './matchProgress.js'

it('leaves room after the pair pass only when a later pass can run', () => {
  expect(pairPassEnd({ rescue: false, bridgeRounds: 0, postShare: 0.1 })).toBe(1)
  expect(pairPassEnd({ rescue: true, bridgeRounds: 0, postShare: 0.1 })).toBeCloseTo(0.9)
  expect(pairPassEnd({ rescue: false, bridgeRounds: 3, postShare: 0.1 })).toBeCloseTo(0.9)
})

it('gives each later pass its share of what is left, and the last one all of it', () => {
  expect(laterPassSpan(0.9, false)).toEqual([0.9, 0.95])
  expect(laterPassSpan(0.9, false, 0.8)[1]).toBeCloseTo(0.98)
  expect(laterPassSpan(0.95, true)).toEqual([0.95, 1])
})

it('moves the bar through a pass span by its own item count', () => {
  expect(spanFraction([0, 0.9], 45, 90)).toBeCloseTo(0.45)
  expect(spanFraction([0.9, 1], 3, 4)).toBeCloseTo(0.975)
  expect(spanFraction([0.9, 0.95], 0, 0)).toBe(0.95)
  expect(spanFraction([0.9, 1], 5, 4)).toBe(1)
})
