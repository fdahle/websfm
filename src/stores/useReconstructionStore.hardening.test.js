import { it, expect, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useProjectsStore } from './useProjectsStore.js'
import { useReconstructionStore } from './useReconstructionStore.js'
import * as workers from '../workers/computeClient.js'
import * as opfs from '../utils/opfs.js'

it('stages DEM points as a disposable transferable buffer without detaching the source', async () => {
  setActivePinia(createPinia())
  useProjectsStore().persistenceAvailable = false
  const store = useReconstructionStore()
  const pos = new Float64Array([7000000.01, 500000.01, 10, 7000000.02, 500000.02, 11])
  store.importCloud({ count: 2, pos }, 'survey.las')
  const generate = vi.spyOn(workers, 'generateDem').mockImplementation(async (input, options) => {
    expect(input.points.pos).toBeInstanceOf(Float64Array)
    expect(input.points.pos).toEqual(pos)
    expect(input.points.pos.buffer).not.toBe(pos.buffer)
    expect(options.transfer).toEqual([input.points.pos.buffer])
    // Exercise actual transfer semantics, as postMessage would in the browser.
    structuredClone(input, { transfer: options.transfer })
    return { width: 1, height: 1, data: new Float32Array([10]), mask: new Uint8Array([1]) }
  })
  await store.generateDem({ crs: 'local' })
  expect(generate).toHaveBeenCalledOnce()
  expect(store.reconStatus).toBe('done')
  expect(pos.byteLength).toBe(48)
  expect(store.clouds[0].pos[0]).toBe(7000000.01)
  generate.mockRestore()
})

it('puts a computed product on the map unless it has no preview, whatever its frame', async () => {
  setActivePinia(createPinia())
  useProjectsStore().persistenceAvailable = false
  const store = useReconstructionStore()
  const base = {
    id: 'd1',
    kind: 'dem',
    width: 2,
    height: 2,
    gsd: 1,
    originX: 0,
    originY: 2,
    data: new Float32Array(4),
    previewUrl: 'data:x',
  }
  store.rasterProducts = [{ ...base, crs: 'local', previewUrl: null }]
  expect(store.setProductVisible('d1', true)).toBe(false)
  expect(store.productLayers.d1).toBeUndefined()
  // A local-frame product may be requested: the model-frame map can place it.
  store.rasterProducts = [{ ...base, crs: 'local' }]
  expect(store.setProductVisible('d1', true)).toBe(true)
  store.setProductOpacity('d1', 0.3)
  expect(store.productLayers.d1).toEqual({ visible: true, opacity: 0.3 })
  // Hiding is always allowed, even once the product could no longer be placed.
  store.rasterProducts = [{ ...base, crs: 'local', previewUrl: null }]
  expect(store.setProductVisible('d1', false)).toBe(true)
  expect(store.productLayers.d1.visible).toBe(false)
})

it('puts a first-built product on the map, and a rebuild after removal again', async () => {
  setActivePinia(createPinia())
  useProjectsStore().persistenceAvailable = false
  const store = useReconstructionStore()
  const dem = {
    id: 'd1',
    kind: 'dem',
    width: 2,
    height: 2,
    gsd: 1,
    originX: 0,
    originY: 2,
    data: new Float32Array(4),
    previewUrl: 'data:x',
    crs: 'local',
  }
  store.rasterProducts = [dem]
  await nextTick()
  expect(store.productLayers.d1).toEqual({ visible: true, opacity: 1 })
  // Taken off the map, a rebuild in place keeps it off.
  store.setProductVisible('d1', false)
  store.rasterProducts = [{ ...dem }]
  await nextTick()
  expect(store.productLayers.d1.visible).toBe(false)
  // Removed, its layer state goes with it, and the next build is on the map again.
  expect(await store.removeProduct('d1')).toBe(true)
  expect(store.productLayers.d1).toBeUndefined()
  store.rasterProducts = [{ ...dem }]
  await nextTick()
  expect(store.productLayers.d1).toEqual({ visible: true, opacity: 1 })
})

it('a new main DEM takes the map place of the one before, which stays listed', async () => {
  setActivePinia(createPinia())
  useProjectsStore().persistenceAvailable = false
  const store = useReconstructionStore()
  const dem = {
    id: 'd1',
    kind: 'dem',
    width: 2,
    height: 2,
    gsd: 1,
    originX: 0,
    originY: 2,
    data: new Float32Array(4),
    previewUrl: 'data:x',
    crs: 'local',
    createdAt: 1,
  }
  store.rasterProducts = [dem]
  await nextTick()
  store.setProductOpacity('d1', 0.4)
  // A second build is the main one: it goes on at the first one's opacity, which leaves.
  store.rasterProducts = [dem, { ...dem, id: 'd2', createdAt: 2 }]
  await nextTick()
  expect(store.dem.id).toBe('d2')
  expect(store.productLayers.d2).toEqual({ visible: true, opacity: 0.4 })
  expect(store.productLayers.d1.visible).toBe(false)
  // Either one can be on the map, main or not.
  expect(store.setProductVisible('d1', true)).toBe(true)
  expect(store.productLayers.d1.visible).toBe(true)
  expect(store.productLayers.d2.visible).toBe(true)
})

it('adds a rebuilt DEM beside the old one as the main one, or replaces the main one', async () => {
  setActivePinia(createPinia())
  useProjectsStore().persistenceAvailable = false
  const store = useReconstructionStore()
  store.importCloud({ count: 2, pos: new Float64Array([0, 0, 1, 1, 1, 2]) }, 'survey.las')
  const generate = vi
    .spyOn(workers, 'generateDem')
    .mockResolvedValue({ width: 1, height: 1, data: new Float32Array([1]), mask: new Uint8Array([1]) })
  await store.generateDem({ crs: 'local' })
  await store.generateDem({ crs: 'local' })
  expect(store.rasterProducts.map((p) => p.name)).toEqual(['DEM', 'DEM 2'])
  expect(store.dem.name).toBe('DEM 2')
  // Built on the imported cloud, which has not changed: neither is outdated.
  expect(store.productStatus(store.rasterProducts[0]).outdated).toBe(false)
  store.setMainProduct(store.rasterProducts[0].id)
  expect(store.dem.name).toBe('DEM')
  // Replace puts the new one in the main one's place, under its name and id.
  const id = store.dem.id
  await store.generateDem({ crs: 'local', replaceMain: true })
  expect(store.rasterProducts.map((p) => p.name)).toEqual(['DEM', 'DEM 2'])
  expect(store.dem.id).toBe(id)
  // Removing the main one hands the role to the newest one left.
  await store.removeProduct(id)
  expect(store.dem.name).toBe('DEM 2')
  generate.mockRestore()
})

it('remembers which listed layers the Layers panel hides', () => {
  setActivePinia(createPinia())
  useProjectsStore().persistenceAvailable = false
  const store = useReconstructionStore()
  store.setMapLayerHidden('product:dem', true)
  store.setMapLayerHidden('vector:a', true)
  store.setMapLayerHidden('product:dem', true)
  expect(store.mapHidden).toEqual(['product:dem', 'vector:a'])
  store.setMapLayerHidden('product:dem', false)
  expect(store.mapHidden).toEqual(['vector:a'])
})

it('keeps an unreadable saved model on disk instead of saving an empty one over it', async () => {
  setActivePinia(createPinia())
  const projects = useProjectsStore()
  projects.persistenceAvailable = true
  projects.currentProjectId = 'unreadable'
  const store = useReconstructionStore()
  const spies = [
    vi.spyOn(opfs, 'loadReconstruction').mockRejectedValue(new Error('Incomplete saved reconstruction')),
    vi.spyOn(opfs, 'loadProducts').mockResolvedValue([]),
    vi.spyOn(opfs, 'loadDepthIndex').mockResolvedValue(null),
  ]
  const save = vi.spyOn(opfs, 'saveReconstruction').mockResolvedValue({ ok: true, files: {} })
  await store.restore({ projectId: 'unreadable' })
  expect(store.clouds).toEqual([])
  // A metadata change on the empty session must not reach the writer…
  store.setProductOpacity('dem', 0.5)
  await Promise.resolve()
  expect(save).not.toHaveBeenCalled()
  // …but real content does replace the unreadable document.
  store.importCloud({ count: 1, pos: new Float64Array([1, 2, 3]) }, 'survey.las')
  await vi.waitFor(() => expect(save).toHaveBeenCalled())
  for (const spy of [...spies, save]) spy.mockRestore()
})
