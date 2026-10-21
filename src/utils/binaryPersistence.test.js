import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import * as opfs from './opfs.js'
import { retryPersistence } from './persistence.js'

function memoryDirectory(control) {
  const files = new Map(),
    dirs = new Map()
  const dir = {
    name: 'binary-test',
    files,
    async *keys() {
      yield* files.keys()
    },
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
            write: async (value) => {
              if (control.fail?.test(name)) throw new Error('disk full')
              control.written?.push(name)
              staged = new Uint8Array(await new Blob([value]).arrayBuffer())
            },
            close: async () => {
              files.set(name, staged)
            },
            abort: async () => {
              control.aborted++
            },
          }
        },
      }
    },
    async removeEntry(name) {
      files.delete(name)
      dirs.delete(name)
    },
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
const dem = (n) => ({
  width: n,
  height: 1,
  data: Float32Array.from({ length: n }, (_, i) => i + n),
  mask: new Uint8Array(n).fill(1),
})

it.each([/\.data\.bin$/, /^dem\.json$/])('keeps the previous DEM intact when writing %s fails', async (fail) => {
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
  const model = (n) => ({
    clouds: [{ id: 'cloud', kind: 'dense', pointCount: n, buffers: { pos: new Float64Array(n * 3).fill(n).buffer } }],
  })
  await opfs.saveReconstruction('binary-test', model(1))
  control.fail = /\.pos\.bin$/
  await expect(opfs.saveReconstruction('binary-test', model(2))).rejects.toThrow('disk full')
  const saved = await opfs.loadReconstruction('binary-test')
  expect(saved.clouds[0].pointCount).toBe(1)
  expect(new Float64Array(saved.clouds[0].buffers.pos)).toEqual(new Float64Array([1, 1, 1]))
})

describe('cloud buffer reuse', () => {
  const pos = (n, v) => new Float64Array(n * 3).fill(v).buffer
  const cloud = (id, n, v) => ({ id, kind: 'dense', pointCount: n, buffers: { pos: pos(n, v) } })

  it('points an unchanged cloud at its committed file instead of rewriting it', async () => {
    const first = await opfs.saveReconstruction('binary-test', { clouds: [cloud('a', 1, 1), cloud('b', 1, 2)] })
    expect(first.ok).toBe(true)
    const aFile = first.files.a.pos
    control.written = []
    const second = await opfs.saveReconstruction('binary-test', {
      clouds: [{ id: 'a', kind: 'dense', pointCount: 1, buffers: null, reuse: first.files.a }, cloud('b', 2, 3)],
    })
    expect(second.ok).toBe(true)
    // Only b's new buffer and the metadata were written; a kept its file through GC.
    expect(control.written.filter((n) => n.endsWith('.bin'))).toEqual([second.files.b.pos.name])
    expect(second.files.a.pos).toEqual(aFile)
    expect(dir.files.has(aFile.name)).toBe(true)
    expect(dir.files.has(first.files.b.pos.name)).toBe(false) // b's old generation collected
    const saved = await opfs.loadReconstruction('binary-test')
    expect(new Float64Array(saved.clouds[0].buffers.pos)).toEqual(new Float64Array([1, 1, 1]))
    expect(new Float64Array(saved.clouds[1].buffers.pos)).toEqual(new Float64Array(6).fill(3))
    // The load reports the committed files so the next save can reuse them too.
    expect(saved.clouds[0].savedFiles.pos).toEqual(aFile)
    control.written = null
  })

  it('writes nothing and names the cloud when a reused file has gone', async () => {
    const first = await opfs.saveReconstruction('binary-test', { clouds: [cloud('a', 1, 1)] })
    dir.files.delete(first.files.a.pos.name) // e.g. another tab's save collected it
    const before = dir.files.get('reconstruction.json')
    const res = await opfs.saveReconstruction('binary-test', {
      clouds: [{ id: 'a', kind: 'dense', pointCount: 1, buffers: null, reuse: first.files.a }],
    })
    expect(res).toEqual({ ok: false, stale: ['a'] })
    expect(dir.files.get('reconstruction.json')).toBe(before)
    // A size mismatch is stale too.
    const again = await opfs.saveReconstruction('binary-test', { clouds: [cloud('a', 1, 1)] })
    const res2 = await opfs.saveReconstruction('binary-test', {
      clouds: [
        { id: 'a', kind: 'dense', pointCount: 1, buffers: null, reuse: { pos: { ...again.files.a.pos, bytes: 1 } } },
      ],
    })
    expect(res2.ok).toBe(false)
  })
})

it('stores a product preview as a PNG sidecar, never inline in the JSON', async () => {
  const previewBlob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
  await opfs.saveProduct('binary-test', 'dem', { ...dem(1), previewBlob, previewUrl: 'blob:x' })
  const products = await dir.getDirectoryHandle('products')
  const meta = JSON.parse(new TextDecoder().decode(products.files.get('dem.json')))
  expect(meta.previewUrl).toBeUndefined()
  expect(meta.binaryFiles.preview.bytes).toBe(4)
  const back = await opfs.loadProduct('binary-test', 'dem')
  expect(back.previewBlob.type).toBe('image/png')
  expect([...new Uint8Array(await back.previewBlob.arrayBuffer())]).toEqual([137, 80, 78, 71])
})

describe('orthophoto (a COG file, never a plane)', () => {
  const cogBytes = Uint8Array.from({ length: 300 }, (_, i) => i % 251)
  const ortho = (extra = {}) => ({
    width: 3000,
    height: 2000,
    gsd: 0.1,
    originX: 0,
    originY: 0,
    covered: 5,
    name: 'Orthophoto',
    cog: new Blob([cogBytes], { type: 'image/tiff' }),
    previewBlob: new Blob([new Uint8Array([137, 80])], { type: 'image/png' }),
    previewUrl: 'blob:x',
    ...extra,
  })

  it('saves the COG as a generation file and loads it back as a handle, with nothing read', async () => {
    const saved = await opfs.saveProduct('binary-test', 'ortho', ortho())
    expect(saved.cogSaved.bytes).toBe(300)
    expect(new Uint8Array(await saved.cog.arrayBuffer())).toEqual(cogBytes)
    const products = await dir.getDirectoryHandle('products')
    const meta = JSON.parse(new TextDecoder().decode(products.files.get('ortho.json')))
    expect(meta.cog).toBeUndefined()
    expect(meta.cogSaved).toBeUndefined()
    expect(meta.rgba).toBeUndefined()
    const back = await opfs.loadProduct('binary-test', 'ortho')
    expect(back.width).toBe(3000)
    expect(back.cogSaved).toEqual(saved.cogSaved)
    expect(new Uint8Array(await back.cog.arrayBuffer())).toEqual(cogBytes)
    expect([...new Uint8Array(await back.previewBlob.arrayBuffer())]).toEqual([137, 80])
  })

  it('a rename reuses the committed COG instead of rewriting it', async () => {
    const saved = await opfs.saveProduct('binary-test', 'ortho', ortho())
    control.written = []
    const again = await opfs.saveProduct('binary-test', 'ortho', { ...ortho(saved), name: 'Renamed' })
    expect(control.written.some((n) => n.endsWith('.cog.bin'))).toBe(false)
    expect(again.cogSaved).toEqual(saved.cogSaved)
    expect((await opfs.loadProduct('binary-test', 'ortho')).name).toBe('Renamed')
    control.written = null
  })

  it('reports an ortho saved in the old whole-plane shape as outdated', async () => {
    const products = await dir.getDirectoryHandle('products')
    products.files.set('ortho.json', new TextEncoder().encode(JSON.stringify({ width: 1, height: 1, binaryFiles: {} })))
    expect(await opfs.loadProduct('binary-test', 'ortho')).toEqual({ outdated: true })
  })
})

describe('loading a reconstruction', () => {
  it('returns null when no model was ever saved', async () => {
    expect(await opfs.loadReconstruction('binary-test')).toBeNull()
  })
  it('throws, rather than reporting no model, when the document is unreadable', async () => {
    dir.files.set('reconstruction.json', new TextEncoder().encode('{"version":3,"clo'))
    await expect(opfs.loadReconstruction('binary-test')).rejects.toThrow()
  })
  it('throws when a cloud buffer the document names is missing', async () => {
    const res = await opfs.saveReconstruction('binary-test', {
      clouds: [{ id: 'a', kind: 'dense', pointCount: 1, buffers: { pos: new Float64Array(3).buffer } }],
    })
    dir.files.delete(res.files.a.pos.name)
    await expect(opfs.loadReconstruction('binary-test')).rejects.toThrow()
  })
})

it('a project.json update starts from a whole-document write already queued', async () => {
  await opfs.writeProject('binary-test', { name: 'a', images: [] })
  const write = opfs.writeProject('binary-test', { name: 'a', images: [{ id: 1 }] })
  const rename = opfs.updateProject('binary-test', (data) => ({ ...data, name: 'b' }))
  await Promise.all([write, rename])
  expect(await opfs.readProject('binary-test')).toEqual({ name: 'b', images: [{ id: 1 }] })
})
