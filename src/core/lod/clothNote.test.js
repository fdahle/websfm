import { describe, it, expect } from 'vitest'
import { clothNote } from './clothNote.js'

describe('clothNote', () => {
  it('names the tiles whose cloth was coarser than asked', () => {
    expect(clothNote([1, 1, null], 1)).toBe(null)
    expect(clothNote([1, 1.7, 2.4], 1)).toMatch(/^Ground filter: 2 of 3 tiles .* at 1 m .*up to 2\.4 m/)
    // Cloud units in feet: 3.28 ft is 1 m, as asked.
    expect(clothNote([1 / 0.3048], 1, 0.3048)).toBe(null)
  })
})
