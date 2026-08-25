import { describe, it, expect } from 'vitest'
import { pluralize, nounFor } from './textFormat.js'

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
