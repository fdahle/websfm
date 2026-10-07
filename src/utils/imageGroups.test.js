import { describe, expect, it } from 'vitest'
import { groupImageSections, moveListEntry, nextGroupName, normalizeImageGroups } from './imageGroups.js'

describe('normalizeImageGroups', () => {
  it('treats an absent list as no groups', () => {
    expect(normalizeImageGroups(undefined)).toEqual([])
    expect(normalizeImageGroups(null)).toEqual([])
  })

  it('drops malformed and duplicate entries and defaults the rest', () => {
    expect(normalizeImageGroups([
      { id: 'a', name: '  North  ', collapsed: 1 },
      { id: 'a', name: 'dup' },
      { name: 'no id' },
      null,
      { id: 'b', name: '   ' },
    ])).toEqual([
      { id: 'a', name: 'North', collapsed: true },
      { id: 'b', name: 'Group', collapsed: false },
    ])
  })
})

describe('groupImageSections', () => {
  const groups = [{ id: 'g1', name: 'A' }, { id: 'g2', name: 'B' }]
  const images = [
    { id: 1, groupId: 'g2' },
    { id: 2, groupId: null },
    { id: 3, groupId: 'g1' },
    { id: 4, groupId: 'gone' },
    { id: 5, groupId: 'g2' },
  ]

  it('keeps group order, list order within a group, and ungrouped last', () => {
    const sections = groupImageSections(images, groups)
    expect(sections.map((s) => [s.group?.id ?? null, s.images.map((i) => i.id)])).toEqual([
      ['g1', [3]],
      ['g2', [1, 5]],
      [null, [2, 4]],
    ])
  })

  it('shows an image whose group no longer exists as ungrouped', () => {
    const last = groupImageSections(images, groups).at(-1)
    expect(last.images.map((i) => i.id)).toContain(4)
  })

  it('keeps empty groups as sections', () => {
    const sections = groupImageSections([], groups)
    expect(sections.map((s) => s.images.length)).toEqual([0, 0, 0])
  })
})

describe('nextGroupName', () => {
  it('takes the first unused number', () => {
    expect(nextGroupName([])).toBe('Group 1')
    expect(nextGroupName([{ name: 'Group 1' }, { name: 'Group 3' }])).toBe('Group 2')
  })
})

describe('moveListEntry', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('moves by delta without mutating the input', () => {
    expect(moveListEntry(list, 'a', 1).map((g) => g.id)).toEqual(['b', 'a', 'c'])
    expect(moveListEntry(list, 'c', -2).map((g) => g.id)).toEqual(['c', 'a', 'b'])
    expect(list.map((g) => g.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns null when nothing moves', () => {
    expect(moveListEntry(list, 'a', -1)).toBeNull()
    expect(moveListEntry(list, 'missing', 1)).toBeNull()
  })
})
