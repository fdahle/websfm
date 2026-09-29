import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useImagesStore } from './useImagesStore.js'
import { useProjectsStore } from './useProjectsStore.js'
import { useModelsStore } from './useModelsStore.js'
import { detectKeypoints } from '../workers/computeClient.js'
vi.mock('../workers/computeClient.js', async importOriginal => ({ ...await importOriginal(), POOL_SIZE: 4, detectKeypoints: vi.fn() }))
beforeEach(() => { setActivePinia(createPinia()); vi.resetAllMocks(); useProjectsStore().persistenceAvailable = false })
const result = () => ({ keypoints: [{ x:1, y:2 }], descriptors: new Float32Array(128), ms:1 })
function setup(n = 6) {
  const store = useImagesStore()
  store.images = Array.from({ length:n }, (_, i) => ({ id:`i${i}`, uuid:`u${i}`, name:`${i}.png`, url:`blob:${i}`, meta:{ width:1200,height:1200 }, kpStatus:null }))
  return store
}
it('runs four SIFT jobs at once and reports each completion once', async () => {
  const store = setup(), progress = vi.fn(); let active = 0, peak = 0
  detectKeypoints.mockImplementation(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return result() })
  await store.detectAll({ maxDim:1200 }, undefined, progress)
  expect(peak).toBe(4)
  expect(progress.mock.calls.map(c => c[0])).toEqual([1,2,3,4,5,6])
  expect(store.images.every(i => i.kpStatus === 'done')).toBe(true)
})
it('cancels all in-flight jobs without counting them or pulling more work', async () => {
  const store = setup(), progress = vi.fn(); let cancelled = false
  const pending = []
  detectKeypoints.mockImplementation(() => new Promise(resolve => pending.push(resolve)))
  const run = store.detectAll({ maxDim:1200 }, undefined, progress, () => cancelled)
  await vi.waitFor(() => expect(pending).toHaveLength(4))
  cancelled = true; pending.forEach(resolve => resolve(result()))
  await run
  expect(detectKeypoints).toHaveBeenCalledTimes(4)
  expect(progress).not.toHaveBeenCalled()
  expect(store.images.every(i => i.kpStatus === null)).toBe(true)
})
it('keeps learned detection serial and continues past an individual SIFT failure', async () => {
  const store = setup(3)
  vi.spyOn(useModelsStore(), 'ensureReady').mockResolvedValue(true)
  let active = 0, peak = 0
  detectKeypoints.mockImplementation(async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return result() })
  await store.detectAll({ detector:'superpoint' })
  expect(peak).toBe(1)
  detectKeypoints.mockRejectedValueOnce(new Error('decode failed'))
  await store.detectAll({ overwrite:true, maxDim:1200 })
  expect(store.images[0].kpStatus).toBe('error')
  expect(store.images.slice(1).every(i => i.kpStatus === 'done')).toBe(true)
})
