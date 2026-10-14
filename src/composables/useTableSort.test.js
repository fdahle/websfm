import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { useTableSort, sortRows, compareValues, compareRaw } from './useTableSort.js'

const get = (row, key) => row[key]
const ids = (rows) => rows.map((r) => r.id)

describe('sortRows', () => {
  const rows = [
    { id: 'a', n: 3, s: 'img10' },
    { id: 'b', n: null, s: 'img2' },
    { id: 'c', n: 1, s: '' },
    { id: 'd', n: 3, s: 'Img1' },
  ]

  it('returns the list itself when no key is given', () => {
    expect(sortRows(rows, null, 1, get)).toBe(rows)
  })

  it('sorts numbers numerically, keeping ties in input order', () => {
    expect(ids(sortRows(rows, 'n', 1, get))).toEqual(['c', 'a', 'd', 'b'])
    expect(ids(sortRows(rows, 'n', -1, get))).toEqual(['a', 'd', 'c', 'b'])
  })

  it('puts null and empty-string values last in both directions', () => {
    expect(ids(sortRows(rows, 's', 1, get)).at(-1)).toBe('c')
    expect(ids(sortRows(rows, 's', -1, get)).at(-1)).toBe('c')
    expect(ids(sortRows(rows, 'n', -1, get)).at(-1)).toBe('b')
  })

  it('collates text numerically by default', () => {
    expect(ids(sortRows(rows, 's', 1, get))).toEqual(['d', 'b', 'a', 'c'])
  })

  it('does not mutate the input', () => {
    const copy = [...rows]
    sortRows(rows, 'n', 1, get)
    expect(rows).toEqual(copy)
  })

  it('uses a custom comparison', () => {
    // Code-unit order: 'img10' < 'img2'.
    expect(ids(sortRows(rows, 's', 1, get, compareRaw))).toEqual(['d', 'a', 'b', 'c'])
  })
})

describe('compareValues / compareRaw', () => {
  it('compares numbers numerically and anything else as text', () => {
    expect(compareValues(2, 10)).toBeLessThan(0)
    expect(compareValues('2', '10')).toBeLessThan(0)
    expect(compareValues('b', 'a')).toBeGreaterThan(0)
  })
  it('compareRaw is plain < / > ordering', () => {
    expect(compareRaw('a', 'b')).toBe(-1)
    expect(compareRaw('b', 'a')).toBe(1)
    expect(compareRaw('a', 'a')).toBe(0)
    expect(compareRaw('10', '2')).toBe(-1)
  })
})

describe('useTableSort', () => {
  const rows = ref([{ id: 'x', v: 2 }, { id: 'y', v: 1 }, { id: 'z', v: 3 }])

  it('keeps the original order until a column is clicked, then toggles', () => {
    const t = useTableSort(() => rows.value, get)
    expect(t.sorted.value).toBe(rows.value)
    expect(t.sortArrow('v')).toBe('')
    t.toggleSort('v')
    expect(ids(t.sorted.value)).toEqual(['y', 'x', 'z'])
    expect(t.sortArrow('v')).toBe('▲')
    t.toggleSort('v')
    expect(ids(t.sorted.value)).toEqual(['z', 'x', 'y'])
    expect(t.sortArrow('v')).toBe('▼')
    t.toggleSort('id')
    expect(t.sortDir.value).toBe(1)
    t.resetSort()
    expect(t.sortKey.value).toBeNull()
    expect(t.sorted.value).toBe(rows.value)
  })

  it('starts on initialKey / initialDir and resets back to them', () => {
    const t = useTableSort(() => rows.value, get, { initialKey: 'v', initialDir: -1 })
    expect(ids(t.sorted.value)).toEqual(['z', 'x', 'y'])
    t.toggleSort('id')
    t.resetSort()
    expect(t.sortKey.value).toBe('v')
    expect(t.sortDir.value).toBe(-1)
  })

  it('starts a newly clicked column in firstDir (DataTable: descending)', () => {
    const t = useTableSort(() => rows.value, get, { firstDir: -1 })
    t.toggleSort('v')
    expect(ids(t.sorted.value)).toEqual(['z', 'x', 'y'])
    t.toggleSort('v')
    expect(ids(t.sorted.value)).toEqual(['y', 'x', 'z'])
  })

  it('re-sorts when the rows change', () => {
    const list = ref([{ id: 'a', v: 2 }])
    const t = useTableSort(() => list.value, get, { initialKey: 'v' })
    list.value = [...list.value, { id: 'b', v: 1 }]
    expect(ids(t.sorted.value)).toEqual(['b', 'a'])
  })

  it('treats a missing rows array as empty', () => {
    const t = useTableSort(() => null, get, { initialKey: 'v' })
    expect(t.sorted.value).toEqual([])
  })
})
