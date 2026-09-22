import { beforeEach, afterEach, it, expect } from 'vitest'
import * as opfs from './opfs.js'
import { retryPersistence } from './persistence.js'

function memoryDirectory(control) {
  const files = new Map(), dirs = new Map()
  const dir = { name: 'binary-test', files,
    async *keys() { yield* files.keys() },
    async getDirectoryHandle(name) {
      if (!dirs.has(name)) dirs.set(name, memoryDirectory(control))
      return dirs.get(name)
    },
    async getFileHandle(name, options) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException('Missing', 'NotFoundError')
        files.set(name, new Uint8Array())
      }
      return {
        getFile: async () => new Blob([files.get(name)]),
        createWritable: async () => {
          let staged
          return {
            write: async value => {
              if (control.fail?.test(name)) throw new Error('disk full')
              staged = new Uint8Array(await new Blob([value]).arrayBuffer())
            },
            close: async () => { files.set(name, staged) },
            abort: async () => { control.aborted++ },
          }
        },
      }
    },
    async removeEntry(name) { files.delete(name); dirs.delete(name) },
  }
  return dir
}
let control, dir
beforeEach(() => {
  control = { fail: null, aborted: 0 }
  dir = memoryDirectory(control)
  opfs.setProjectRoot('binary-test', dir)
})
afterEach(async () => {
  control.fail = null
  await retryPersistence()
  opfs.clearProjectRoot('binary-test')
})
const dem = n => ({ width: n, height: 1, data: Float32Array.from({ length: n }, (_, i) => i + n), mask: new Uint8Array(n).fill(1) })

it.each([/\.data\.bin$/, /^dem\.json$/])('keeps the previous DEM intact when writing %s fails', async fail => {
  await opfs.saveProduct('binary-test', 'dem', dem(1))
  control.fail = fail
  await expect(opfs.saveProduct('binary-test', 'dem', dem(2))).rejects.toThrow('disk full')
  expect(await opfs.loadProduct('binary-test', 'dem')).toEqual(dem(1))
  expect(control.aborted).toBe(1)
})
it('writes only the requested typed-array slice and rejects malformed raster dimensions', async () => {
  const product = { ...dem(1), data: new Float32Array([9, 8, 7]).subarray(1, 2) }
  await opfs.saveProduct('binary-test', 'dem', product)
  expect((await opfs.loadProduct('binary-test', 'dem')).data).toEqual(new Float32Array([8]))
  // An invalid write is intentionally not issued through the retry queue here;
  // use a corrupted on-disk header to exercise load validation.
  const products = await dir.getDirectoryHandle('products')
  const meta = JSON.parse(new TextDecoder().decode(products.files.get('dem.json')))
  meta.width = 2
  products.files.set('dem.json', new TextEncoder().encode(JSON.stringify(meta)))
  expect(await opfs.loadProduct('binary-test', 'dem')).toBeNull()
})
it('removes generation files on product deletion', async () => {
  await opfs.saveProduct('binary-test', 'dem', dem(1))
  await opfs.deleteProduct('binary-test', 'dem')
  expect((await dir.getDirectoryHandle('products')).files.size).toBe(0)
})
it('commits cloud buffers atomically when replacing an existing cloud id', async () => {
  const model = n => ({ clouds: [{ id: 'cloud', kind: 'dense', pointCount: n, buffers: { pos: new Float64Array(n * 3).fill(n).buffer } }] })
  await opfs.saveReconstruction('binary-test', model(1))
  control.fail = /\.pos\.bin$/
  await expect(opfs.saveReconstruction('binary-test', model(2))).rejects.toThrow('disk full')
  const saved = await opfs.loadReconstruction('binary-test')
  expect(saved.clouds[0].pointCount).toBe(1)
  expect(new Float64Array(saved.clouds[0].buffers.pos)).toEqual(new Float64Array([1, 1, 1]))
})
