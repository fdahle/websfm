import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { useSourcePick, cloudOptionLabel, meshOptionLabel, referenceOptionLabel } from './useSourcePick.js'

const A = { id: 'a', name: 'A', count: 1200 }
const B = { id: 'b', name: 'B', count: 3 }
const M = { id: 'm', name: 'M', count: 10, kind: 'mesh' }

describe('useSourcePick', () => {
  it('starts on initialId when it is offered, else the first item', () => {
    expect(useSourcePick([A, B], { initialId: 'b' }).id.value).toBe('b')
    expect(useSourcePick([A, B], { initialId: 'zzz' }).id.value).toBe('a')
    expect(useSourcePick([A, B]).id.value).toBe('a')
    expect(useSourcePick(() => [A, B], { initialId: () => 'b' }).item.value).toBe(B)
  })

  it('is null with nothing to pick', () => {
    const s = useSourcePick([])
    expect(s.id.value).toBeNull()
    expect(s.item.value).toBeNull()
  })

  it('reads initialId once', () => {
    const initial = ref('b')
    const s = useSourcePick([A, B], { initialId: initial })
    initial.value = 'a'
    expect(s.id.value).toBe('b')
  })

  it('writes the pick and falls back when the picked item disappears', () => {
    const items = ref([A, B])
    const s = useSourcePick(items)
    s.id.value = 'b'
    expect(s.item.value?.id).toBe('b')
    items.value = [A]
    expect(s.id.value).toBe('a')
    items.value = [A, B]
    expect(s.id.value).toBe('b')
  })

  it('a reference re-picks a different item when the source takes it', () => {
    const source = useSourcePick([A, B, M], { initialId: 'a' })
    const reference = useSourcePick([A, B, M], { exclude: () => source.id.value })
    expect(reference.id.value).toBe('b')
    expect(reference.options.value.map((c) => c.id)).toEqual(['b', 'm'])
    reference.id.value = 'm'
    source.id.value = 'm'
    expect(reference.id.value).toBe('a')
    source.id.value = 'b'
    expect(reference.id.value).toBe('m') // the user's own pick is allowed again
    // The bug this replaces: moving the reference into the source slot.
    reference.id.value = 'a'
    source.id.value = 'a'
    expect(reference.id.value).toBe('b')
    expect(reference.item.value).toBe(B)
  })

  it('a reference has nothing to offer when only the source exists', () => {
    const source = useSourcePick([A])
    const reference = useSourcePick([A], { exclude: () => source.id.value })
    expect(reference.options.value).toEqual([])
    expect(reference.id.value).toBeNull()
  })
})

describe('option labels', () => {
  it('reads as the dialogs always did', () => {
    expect(cloudOptionLabel(A)).toBe(`A — ${(1200).toLocaleString()} points`)
    expect(meshOptionLabel(M)).toBe('M — 10 triangles')
    expect(referenceOptionLabel(M)).toBe('M (mesh)')
    expect(referenceOptionLabel(A)).toBe('A')
  })
})
