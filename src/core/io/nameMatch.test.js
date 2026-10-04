import { describe, expect, it } from 'vitest'
import { basename, makeNameResolver, stem, relinkImageRecord } from './nameMatch.js'

describe('basename / stem', () => {
  it('handles both separators and missing extensions', () => {
    expect(basename('images/sub/DSC_0001.JPG')).toBe('DSC_0001.JPG')
    expect(basename('images\\sub\\DSC_0001.JPG')).toBe('DSC_0001.JPG')
    expect(stem('images/DSC_0001.JPG')).toBe('DSC_0001')
    expect(stem('noext')).toBe('noext')
  })
})

describe('makeNameResolver', () => {
  const images = [
    { id: 'a', name: 'DSC_0001.JPG' },
    { id: 'b', name: 'DSC_0002.tif' },
    { id: 'c', name: 'flight/DSC_0003.JPG' },
  ]
  const resolve = makeNameResolver(images)

  it('matches exactly', () => {
    expect(resolve('DSC_0001.JPG')).toBe('a')
    expect(resolve('flight/DSC_0003.JPG')).toBe('c')
  })

  it('matches a foreign path against a bare stored name', () => {
    expect(resolve('images/DSC_0001.JPG')).toBe('a')
    expect(resolve('images\\DSC_0001.JPG')).toBe('a')
  })

  it('matches case-insensitively and across extensions', () => {
    expect(resolve('dsc_0001.jpg')).toBe('a')
    expect(resolve('DSC_0002.tiff')).toBe('b')  // transcoded extension
    expect(resolve('DSC_0003')).toBe('c')
  })

  it('returns null for unknown, empty and nullish names', () => {
    expect(resolve('nope.jpg')).toBe(null)
    expect(resolve('')).toBe(null)
    expect(resolve(null)).toBe(null)
    expect(resolve(undefined)).toBe(null)
  })

  // The tiering is the whole point: a linear "exact OR stem" scan would return
  // the earlier stem hit here, because it decides per candidate instead of per
  // tier. The three store copies this replaced all had that flaw.
  it('prefers an exact match over an earlier stem match', () => {
    const r = makeNameResolver([
      { id: 'stemhit', name: 'IMG_1.png' },
      { id: 'exact', name: 'IMG_1.jpg' },
    ])
    expect(r('IMG_1.jpg')).toBe('exact')
  })

  it('skips entries with no name or no id, and takes the first per tier', () => {
    const r = makeNameResolver([
      { id: null, name: 'x.jpg' },
      { name: 'x.jpg' },
      { id: 'first', name: 'x.jpg' },
      { id: 'second', name: 'x.jpg' },
    ])
    expect(r('x.jpg')).toBe('first')
  })

  it('reads a caller-chosen id key', () => {
    const r = makeNameResolver([{ uuid: 'u1', name: 'x.jpg' }], { key: 'uuid' })
    expect(r('x.jpg')).toBe('u1')
    expect(makeNameResolver([{ uuid: 'u1', name: 'x.jpg' }])('x.jpg')).toBe(null)
  })

  it('tolerates a missing entry list', () => {
    expect(makeNameResolver(undefined)('x.jpg')).toBe(null)
  })
})

describe('relinkImageRecord', () => {
  const images = [{ id: 'a', name: 'north-01' }, { id: 'b', name: 'DSC_0013.JPG' }]
  const byId = new Map(images.map((i) => [i.id, i]))
  const resolve = makeNameResolver(images)

  it('keeps a live link across a rename and adopts the new name', () => {
    const rec = { imageId: 'a', imageName: 'DSC_0012.JPG' }
    expect(relinkImageRecord(rec, byId, resolve)).toBe(true)
    expect(rec).toEqual({ imageId: 'a', imageName: 'north-01' })
    expect(relinkImageRecord(rec, byId, resolve)).toBe(false)
  })

  it('resolves by name when the record has no live link', () => {
    const late = { imageId: null, imageName: 'dsc_0013.jpg' }
    expect(relinkImageRecord(late, byId, resolve)).toBe(true)
    expect(late.imageId).toBe('b')
    const removed = { imageId: 'gone', imageName: 'nothing.jpg' }
    expect(relinkImageRecord(removed, byId, resolve)).toBe(true)
    expect(removed.imageId).toBeNull()
  })
})
