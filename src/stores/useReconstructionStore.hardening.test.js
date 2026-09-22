import { it, expect, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useProjectsStore } from './useProjectsStore.js'
import { useReconstructionStore } from './useReconstructionStore.js'
import * as workers from '../workers/computeClient.js'

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
