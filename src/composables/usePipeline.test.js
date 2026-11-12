import { it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePipeline } from './usePipeline.js'

const stub = () => vi.fn(async () => {})

it('closes the progress modal when a store run rejects before its own try', async () => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  const generateDem = vi.fn(async () => {
    throw new Error('frame spec unavailable')
  })
  const p = usePipeline({
    images: ref([]),
    detectAll: stub(),
    matchAll: stub(),
    reconstruct: stub(),
    computeDepthMaps: stub(),
    densify: stub(),
    generateDem,
    generateOrtho: stub(),
    generateMesh: stub(),
    editClouds: stub(),
    textureMesh: stub(),
  })
  const run = p.runGenerateDem({})
  await vi.runAllTimersAsync()
  const result = await run
  expect(generateDem).toHaveBeenCalledOnce()
  expect(p.progressOpen.value).toBe(false)
  expect(result).toMatchObject({ ok: false, reason: 'frame spec unavailable' })
  expect(p.lastRun.value).toMatchObject({ title: 'Building DEM', ok: false })
  vi.useRealTimers()
})
