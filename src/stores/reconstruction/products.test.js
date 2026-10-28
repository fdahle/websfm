import { beforeEach, expect, it, vi } from 'vitest'
import { createProducts } from './products.js'
import { demPreview } from '../../workers/computeClient.js'

// The DEM preview re-bake is faked with promises the test settles by hand, so the
// two Applies can finish in either order.
vi.mock('../../workers/computeClient.js', () => ({ demPreview: vi.fn() }))

function setup() {
  const rasterProducts = {
    value: [
      {
        id: 'd1',
        kind: 'dem',
        name: 'DEM',
        createdAt: 1,
        width: 1,
        height: 1,
        data: new Float32Array([1]),
        mask: new Uint8Array([1]),
        gsd: 1,
        zMin: 0,
        zMax: 10,
        previewUrl: 'blob:old',
      },
    ],
  }
  // The store's main DEM is a computed over the list; the first record here.
  const dem = {
    get value() {
      return rasterProducts.value.find((p) => p.kind === 'dem') ?? null
    },
  }
  const log = vi.fn()
  const api = createProducts({
    rasterProducts,
    mainProductIds: { value: { dem: 'd1' } },
    dem,
    ortho: { value: null },
    isPersisting: () => false,
    log,
    save: vi.fn(),
    productLayers: { value: {} },
    projects: { currentProjectId: 'p' },
    withPreviewUrl: (record) => ({ ...record, previewUrl: `blob:${record.style.ramp}` }),
  })
  return { dem, rasterProducts, log, api }
}
const deferredBakes = () => {
  const pending = []
  demPreview.mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })))
  return pending
}

beforeEach(() => vi.resetAllMocks())

it('keeps the newer DEM style when an older re-bake finishes last', async () => {
  const { dem, api } = setup()
  const bakes = deferredBakes()
  const older = api.setProductStyle('d1', { ramp: 'viridis' })
  const newer = api.setProductStyle('d1', { ramp: 'gray' })
  bakes[1].resolve({ previewBlob: new Blob(['gray']) })
  expect(await newer).toBe(true)
  bakes[0].resolve({ previewBlob: new Blob(['viridis']) })
  expect(await older).toBe(false)
  expect(dem.value.style.ramp).toBe('gray')
  expect(dem.value.previewUrl).toBe('blob:gray')
})

it('applies a lone re-bake, and both in order when they finish in order', async () => {
  const { dem, api } = setup()
  const bakes = deferredBakes()
  const first = api.setProductStyle('d1', { ramp: 'viridis' })
  bakes[0].resolve({ previewBlob: new Blob(['a']) })
  expect(await first).toBe(true)
  expect(dem.value.style.ramp).toBe('viridis')
  const second = api.setProductStyle('d1', { ramp: 'gray' })
  bakes[1].resolve({ previewBlob: new Blob(['b']) })
  expect(await second).toBe(true)
  expect(dem.value.style.ramp).toBe('gray')
})

it('still drops a re-bake for a DEM that was rebuilt meanwhile', async () => {
  const { dem, rasterProducts, api } = setup()
  const bakes = deferredBakes()
  const run = api.setProductStyle('d1', { ramp: 'viridis' })
  rasterProducts.value = [{ ...dem.value, createdAt: 2 }]
  bakes[0].resolve({ previewBlob: new Blob(['a']) })
  expect(await run).toBe(false)
  expect(dem.value.style).toBeUndefined()
})

it('reports only the failure of the newest Apply', async () => {
  const { log, api } = setup()
  const bakes = deferredBakes()
  const older = api.setProductStyle('d1', { ramp: 'viridis' })
  const newer = api.setProductStyle('d1', { ramp: 'gray' })
  bakes[0].reject(new Error('stale'))
  bakes[1].reject(new Error('fresh'))
  expect(await older).toBe(false)
  expect(await newer).toBe(false)
  const errors = log.mock.calls.filter(([, level]) => level === 'error').map(([msg]) => msg)
  expect(errors).toEqual(['DEM symbology failed: fresh'])
})

it('makes the newest one left the main one when the main is removed', async () => {
  const { rasterProducts, api } = setup()
  const second = { ...rasterProducts.value[0], id: 'd2', name: 'DEM 2', createdAt: 2 }
  rasterProducts.value = [...rasterProducts.value, second]
  expect(api.setMainProduct('d2')).toBe(true)
  expect(api.setMainProduct('d2')).toBe(false)
  expect(await api.removeProduct('d1')).toBe(true)
  expect(rasterProducts.value.map((p) => p.id)).toEqual(['d2'])
  expect(api.renameProduct('d2', ' Lidar DEM ')).toBe(true)
  expect(api.productById('d2').name).toBe('Lidar DEM')
})
