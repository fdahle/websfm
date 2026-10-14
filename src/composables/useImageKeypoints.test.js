import { describe, it, expect, vi } from 'vitest'
import { ref, reactive, nextTick } from 'vue'
import { useImageKeypoints } from './useImageKeypoints.js'

const kpSet = (responses) => ({ length: responses.length, response: (i) => responses[i] })

// The images store, with ensureKeypoints resolved by hand so a slow read can be
// overtaken by an image switch.
function fakeStore() {
  const pending = []
  return {
    pending,
    resident: new Map(),
    residentKeypoints(img) { return this.resident.get(img.id) ?? null },
    ensureKeypoints: vi.fn((img) => new Promise((resolve) => pending.push({ id: img.id, resolve }))),
  }
}

describe('useImageKeypoints', () => {
  it('reads the set on demand only while shown and detected', async () => {
    const store = fakeStore()
    const image = reactive({ id: 'a', kpStatus: 'done', kpRev: 0 })
    const show = ref(false)
    const k = useImageKeypoints({ image: () => image, show: () => show.value, store })
    expect(store.ensureKeypoints).not.toHaveBeenCalled()
    show.value = true
    await nextTick()
    expect(store.ensureKeypoints).toHaveBeenCalledTimes(1)
    store.pending[0].resolve(kpSet([2, 6]))
    await Promise.resolve(); await Promise.resolve()
    expect(k.keypoints.value.length).toBe(2)
    expect(k.keypointRange.value).toEqual({ minR: 2, range: 4 })
  })

  it('drops a read that resolves after the image was switched', async () => {
    const store = fakeStore()
    const image = reactive({ id: 'a', kpStatus: 'done', kpRev: 0 })
    const k = useImageKeypoints({ image: () => image, show: () => true, store })
    image.id = 'b'
    await nextTick()
    store.pending[0].resolve(kpSet([1])) // image a's set, now stale
    await Promise.resolve(); await Promise.resolve()
    expect(k.keypoints.value).toBeNull()
    store.pending[1].resolve(kpSet([1, 2, 3]))
    await Promise.resolve(); await Promise.resolve()
    expect(k.keypoints.value.length).toBe(3)
  })

  it('uses a resident set at once, and never shows the replaced one while re-reading', async () => {
    const store = fakeStore()
    store.resident.set('a', kpSet([5]))
    const image = reactive({ id: 'a', kpStatus: 'done', kpRev: 0 })
    const k = useImageKeypoints({ image: () => image, show: () => true, store })
    expect(k.keypoints.value.length).toBe(1)
    expect(store.ensureKeypoints).not.toHaveBeenCalled()
    store.resident.delete('a') // re-detected: the old set is evicted
    image.kpRev = 1
    await nextTick()
    expect(k.keypoints.value).toBeNull()
    expect(k.keypointRange.value).toBeNull()
  })
})
