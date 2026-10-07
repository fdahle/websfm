import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useModelsStore } from './useModelsStore.js'
import { modelUrl } from '../core/models/registry.js'

let store
beforeEach(() => {
  setActivePinia(createPinia())
  store = new Map()
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async (url) => store.get(url),
      put: async (url, resp) => { store.set(url, resp) },
      delete: async (url) => store.delete(url),
    }),
  })
})
afterEach(() => vi.unstubAllGlobals())

const onnxFile = (name = 'superpoint.onnx') => {
  const b = new Uint8Array(200_000); b[0] = 0x08; b[1] = 0x07
  return new File([b], name)
}

it('asks the user to supply a non-redistributable model and never downloads it', async () => {
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  const models = useModelsStore()
  const ready = models.ensureReady(['superpoint'])
  await vi.waitFor(() => expect(models.request).not.toBeNull())
  const [item] = models.request.items
  expect(item).toMatchObject({ id: 'superpoint', userSupplied: true, ready: false })
  expect(item.sourceUrl).toMatch(/^https:\/\/github\.com\/.*superpoint\.onnx$/)
  expect(models.request.totalBytes).toBe(0)

  // Approving without the file does nothing.
  models.approve()
  expect(models.request).not.toBeNull()

  // A saved error page is refused with a reason, and the request stays open.
  expect(await models.provideModelFile('superpoint', new File(['<!doctype html><html></html>'], 'superpoint.onnx'))).toBe(false)
  expect(models.request.items[0].fileError).toMatch(/not an ONNX model/)

  // The real file is cached under the model URL and the run continues by itself.
  expect(await models.provideModelFile('superpoint', onnxFile())).toBe(true)
  expect(await ready).toBe(true)
  expect(store.has(modelUrl('superpoint'))).toBe(true)
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('downloads redistributable models as before', async () => {
  const body = new Uint8Array(200_000); body[0] = 0x08
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } })))
  const models = useModelsStore()
  const ready = models.ensureReady(['disk'])
  await vi.waitFor(() => expect(models.request).not.toBeNull())
  expect(models.request.items[0].userSupplied).toBe(false)
  models.approve()
  expect(await ready).toBe(true)
  expect(store.has(modelUrl('disk'))).toBe(true)
})
