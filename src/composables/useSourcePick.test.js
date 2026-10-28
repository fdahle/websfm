import { beforeEach, describe, it, expect } from 'vitest'
import { markRaw, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useSourcePick, cloudOptionLabel, meshOptionLabel, referenceOptionLabel } from './useSourcePick.js'

// The labels and the default pick read the reconstruction store (main / outdated).
beforeEach(() => {
  setActivePinia(createPinia())
  useProjectsStore().persistenceAvailable = false
})

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

describe('main and outdated products', () => {
  const dense = (id, name, extra = {}) => ({
    id,
    name,
    kind: 'dense',
    count: 5,
    createdAt: 1,
    cameras: markRaw(new Map()),
    pos: new Float32Array(15),
    ...extra,
  })

  it('starts on the main one and names it, and an outdated one', () => {
    const recon = useReconstructionStore()
    const sparse = { id: 's', name: 'Sparse', kind: 'sparse', createdAt: 9, cameras: new Map(), points: [] }
    // Built on an earlier version of the model (createdAt 1, now 9).
    const old = dense('d1', 'Dense cloud', { basedOn: [{ id: 's', kind: 'sparse', createdAt: 1 }] })
    const fresh = dense('d2', 'Dense cloud 2', { basedOn: [{ id: 's', kind: 'sparse', createdAt: 9 }] })
    recon.clouds = [sparse, old, fresh]
    recon.mainSparseId = 's'
    recon.mainProductIds = { dense: 'd2' }
    const pick = useSourcePick(() => recon.clouds.filter((c) => c.kind === 'dense'))
    expect(pick.id.value).toBe('d2')
    expect(cloudOptionLabel(recon.clouds[2])).toBe('Dense cloud 2 — 5 points · main')
    expect(cloudOptionLabel(recon.clouds[1])).toBe('Dense cloud — 5 points · outdated')
    // Set as main moves the default; the user's own pick stays.
    recon.setMainProduct('d1')
    expect(pick.id.value).toBe('d1')
    pick.id.value = 'd2'
    recon.setMainProduct('d2')
    recon.setMainProduct('d1')
    expect(pick.id.value).toBe('d2')
  })
})
