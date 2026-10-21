import { describe, expect, it } from 'vitest'
import { findDuplicateFiles, imageFileSize, uniqueImageLabel } from './imageDuplicates.js'

const file = (name, size, lastModified = 1) => ({ name, size, lastModified })

describe('imageFileSize', () => {
  it('reads the File, else the id of a restored image', () => {
    expect(imageFileSize({ id: 'x', name: 'a.JPG', file: { size: 7 } })).toBe(7)
    expect(
      imageFileSize({ id: 'DSC-01.JPG-8694528-1551254774', name: 'renamed', sourceName: 'DSC-01.JPG', file: null }),
    ).toBe(8694528)
    expect(imageFileSize({ id: 'a.JPG-12-3#2', name: 'a (2).JPG', sourceName: 'a.JPG' })).toBe(12)
    expect(imageFileSize({ id: 'other', name: 'a.JPG' })).toBeNull()
  })
})

describe('findDuplicateFiles', () => {
  it('matches a copy with a new modification time, not a same-named different file', () => {
    const images = [{ id: 'a.JPG-100-1', name: 'a.JPG', sourceName: 'a.JPG' }]
    const copy = file('a.JPG', 100, 999)
    const other = file('a.JPG', 101)
    const fresh = file('b.JPG', 100)
    expect([...findDuplicateFiles([copy, other, fresh], images)]).toEqual([copy])
  })

  it('flags the second of two identical files in one pick', () => {
    const one = file('c.JPG', 5, 1)
    const two = file('c.JPG', 5, 2)
    expect([...findDuplicateFiles([one, two], [])]).toEqual([two])
  })
})

describe('uniqueImageLabel', () => {
  it('numbers before the extension', () => {
    expect(uniqueImageLabel('a.JPG', new Set())).toBe('a.JPG')
    expect(uniqueImageLabel('a.JPG', new Set(['a.JPG']))).toBe('a (2).JPG')
    expect(uniqueImageLabel('a.JPG', new Set(['a.JPG', 'a (2).JPG']))).toBe('a (3).JPG')
    expect(uniqueImageLabel('noext', new Set(['noext']))).toBe('noext (2)')
  })
})
