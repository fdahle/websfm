import { describe, it, expect } from 'vitest'
import { nextMarkId, duplicateMarkIds } from './fiducialMarks.js'

describe('nextMarkId', () => {
  it('counts on from the list length', () => {
    expect(nextMarkId([])).toBe('F1')
    expect(nextMarkId([{ id: 'F1' }, { id: 'F2' }])).toBe('F3')
  })

  // The old `F${length + 1}` handed out F3 again here.
  it('skips an id already in use', () => {
    expect(nextMarkId([{ id: 'F3' }, { id: 'A' }])).toBe('F4')
    expect(nextMarkId([{ id: 'F2' }, { id: 'F3' }, { id: 'F4' }])).toBe('F5')
    expect(nextMarkId([{ id: 'F3' }, { id: 'F4' }, { id: 'X' }])).toBe('F5')
  })
})

describe('duplicateMarkIds', () => {
  it('lists each repeated id once', () => {
    expect(duplicateMarkIds([{ id: 'F1' }, { id: 'F2' }])).toEqual([])
    expect(duplicateMarkIds([{ id: 'F1' }, { id: 'F1' }, { id: 'F2' }, { id: 'F1' }, { id: 'F2' }])).toEqual([
      'F1',
      'F2',
    ])
  })

  it('ignores blank ids', () => {
    expect(duplicateMarkIds([{ id: '' }, { id: '' }, { id: null }])).toEqual([])
  })
})
