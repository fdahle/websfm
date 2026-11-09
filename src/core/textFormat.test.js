import { describe, it, expect } from 'vitest'
import { pluralize, nounFor, ordinal } from './textFormat.js'

describe('pluralize', () => {
  it('agrees with the count', () => {
    expect(pluralize(1, 'camera position')).toBe('1 camera position')
    expect(pluralize(2, 'camera position')).toBe('2 camera positions')
  })

  it('pluralizes zero', () => {
    expect(pluralize(0, 'pair')).toBe('0 pairs')
  })

  it('takes an explicit form for irregular plurals', () => {
    expect(pluralize(1, 'entry', 'entries')).toBe('1 entry')
    expect(pluralize(3, 'entry', 'entries')).toBe('3 entries')
  })
})

describe('nounFor', () => {
  it('returns the noun alone, for a separately rendered count', () => {
    expect(`7/1 ${nounFor(1, 'pair')}`).toBe('7/1 pair')
    expect(`7/12 ${nounFor(12, 'pair')}`).toBe('7/12 pairs')
  })
})

describe('ordinal', () => {
  it('takes st, nd, rd except in the teens', () => {
    const got = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 38, 101, 111, 112, 113, 121].map(ordinal)
    expect(got).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '38th',
      '101st',
      '111th',
      '112th',
      '113th',
      '121st',
    ])
  })
})
