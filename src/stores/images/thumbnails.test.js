import { describe, it, expect, vi } from 'vitest'
import { reactive } from 'vue'
import { createImageThumbnails } from './thumbnails.js'
import { SOURCE_UNREADABLE } from '../../utils/thumbnail.js'

const flush = () => new Promise((r) => setTimeout(r, 0))

function setup({ stored = null, make, persisting = true, healImage = vi.fn(async () => false) } = {}) {
  const images = reactive([
    { id: 'a', uuid: 'ua', name: 'a.jpg', url: 'blob:a', thumb: null, meta: { width: 4000, height: 3000 } },
    { id: 'b', uuid: 'ub', name: 'b.tif', url: 'blob:b', thumb: null, previewPending: true },
  ])
  const storage = {
    loadImageDerivedBlob: vi.fn(async () => stored),
    saveImageDerived: vi.fn(async () => {}),
  }
  const writes = []
  const t = createImageThumbnails({
    imageById: (id) => images.find((i) => i.id === id) ?? null,
    currentProjectId: () => 'p1',
    isPersisting: () => persisting,
    trackWrite: (p) => {
      writes.push(p)
      return p
    },
    log: vi.fn(),
    healImage,
    make: make ?? vi.fn(async () => ({ blob: new Blob(['jpg'], { type: 'image/jpeg' }), width: 256, height: 192 })),
    storage,
  })
  return { images, storage, t, writes }
}

describe('image thumbnails', () => {
  it('uses the persisted copy when there is one, without decoding', async () => {
    const stored = new Blob(['stored'], { type: 'image/jpeg' })
    const make = vi.fn()
    const { images, t, storage } = setup({ stored, make })
    const thumb = await t.requestThumbnail(images[0])
    expect(thumb.blob).toBe(stored)
    expect(images[0].thumb.url).toMatch(/^blob:/)
    expect(make).not.toHaveBeenCalled()
    expect(storage.saveImageDerived).not.toHaveBeenCalled()
    expect(t.version.value).toBe(1)
  })

  it('generates from the display URL and persists when nothing is stored', async () => {
    const { images, t, storage, writes } = setup()
    await t.requestThumbnail(images[0])
    expect(images[0].thumb).not.toBeNull()
    expect(writes).toHaveLength(1)
    expect(storage.saveImageDerived).toHaveBeenCalledWith('p1', 'ua', 'thumb', images[0].thumb.blob)
  })

  it('passes an explicit ingest source and the metadata hint to the decoder', async () => {
    const make = vi.fn(async () => ({ blob: new Blob(['x']) }))
    const { images, t, storage } = setup({ make })
    const file = new Blob(['original'])
    await t.requestThumbnail(images[0], { source: file })
    expect(make).toHaveBeenCalledWith(file, { maxDim: 256, hint: { width: 4000, height: 3000 } })
    expect(storage.loadImageDerivedBlob).not.toHaveBeenCalled()
  })

  it('never decodes a TIFF that is still transcoding', async () => {
    const make = vi.fn()
    const { images, t } = setup({ make })
    expect(await t.requestThumbnail(images[1])).toBeNull()
    expect(make).not.toHaveBeenCalled()
  })

  it('a failed decode is not retried in a loop', async () => {
    const make = vi.fn(async () => {
      throw new Error('bad pixels')
    })
    const { images, t } = setup({ make })
    expect(await t.requestThumbnail(images[0])).toBeNull()
    expect(await t.requestThumbnail(images[0])).toBeNull()
    expect(make).toHaveBeenCalledTimes(1)
  })

  it('heals the image when its display URL is unreadable, then retries once', async () => {
    let calls = 0
    const make = vi.fn(async () => {
      if (calls++ === 0) throw new Error(`${SOURCE_UNREADABLE} Failed to fetch`)
      return { blob: new Blob(['ok']) }
    })
    const healImage = vi.fn(async () => true)
    const { images, t } = setup({ make, healImage })
    expect(await t.requestThumbnail(images[0])).not.toBeNull()
    expect(healImage).toHaveBeenCalledWith('a')
    expect(make).toHaveBeenCalledTimes(2)
  })

  it('a broken thumbnail regenerates once, then gives up', async () => {
    const stored = new Blob(['truncated'])
    const make = vi.fn(async () => ({ blob: new Blob(['fresh']) }))
    const { images, t } = setup({ stored, make })
    await t.requestThumbnail(images[0])
    t.reportThumbnailError('a')
    expect(images[0].thumb).toBeNull()
    await flush()
    await flush()
    expect(make).toHaveBeenCalledTimes(1) // regenerated, not re-read from storage
    expect(images[0].thumb.blob).not.toBe(stored)
    t.reportThumbnailError('a')
    await flush()
    expect(images[0].thumb).toBeNull()
    expect(await t.requestThumbnail(images[0])).toBeNull()
    expect(make).toHaveBeenCalledTimes(1)
  })

  it('reset drops queued work and discards results of running jobs', async () => {
    let release
    const gate = new Promise((r) => {
      release = r
    })
    const make = vi.fn(async () => {
      await gate
      return { blob: new Blob(['late']) }
    })
    const { images, t } = setup({ make })
    const running = t.requestThumbnail(images[0])
    await flush()
    t.reset()
    release()
    expect(await running).toBeNull()
    expect(images[0].thumb).toBeNull()
  })
})
