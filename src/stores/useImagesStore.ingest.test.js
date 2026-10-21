import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as opfs from '../utils/opfs.js'
import { useImagesStore } from './useImagesStore.js'
import { useProjectsStore } from './useProjectsStore.js'

// The thumbnail worker does not exist in Node; the ingest only queues a request.
vi.mock('../workers/thumbnailClient.js', () => ({ makeThumbnail: vi.fn(async () => ({ blob: new Blob(['t']) })) }))

// addImages' options for files made in the browser (Import ▸ Video's frames):
// metadata merged over EXIF, the known size, and — once stored — the record reads
// the project's copy instead of holding the encoded frame.
describe('addImages with extras and fromStorage', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('merges frame metadata, keeps the given size and reads the stored copy back', async () => {
    const projects = useProjectsStore()
    projects.persistenceAvailable = true
    projects.projects = [{ id: 'p1', name: 'test', sceneType: 'object' }]
    projects.currentProjectId = 'p1'
    const saved = new Map()
    vi.spyOn(opfs, 'saveImage').mockImplementation(async (_pid, uuid, file) => {
      saved.set(uuid, file)
    })
    vi.spyOn(opfs, 'saveImageDerived').mockResolvedValue()
    vi.spyOn(opfs, 'writeProject').mockResolvedValue()
    const storedCopy = (uuid) => new File([saved.get(uuid)], uuid, { type: 'image/jpeg' })
    vi.spyOn(opfs, 'loadImageBlob').mockImplementation(async (_pid, uuid) => storedCopy(uuid))
    let n = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++n}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const frame = new File([new Uint8Array(2000)], 'walk_00m01.500s.jpg', { type: 'image/jpeg', lastModified: 5 })
    const photo = new File([new Uint8Array(1000)], 'photo.jpg', { type: 'image/jpeg', lastModified: 5 })
    const store = useImagesStore()
    await store.addImages([frame], null, {
      extras: new Map([
        [
          frame,
          {
            meta: { videoSource: 'walk.mp4', videoTime: 1.5 },
            dims: { width: 640, height: 360 },
            thumb: new Blob(['t']),
          },
        ],
      ]),
      fromStorage: true,
    })

    const img = store.images[0]
    expect(img.meta).toMatchObject({ width: 640, height: 360, videoSource: 'walk.mp4', videoTime: 1.5 })
    expect(saved.get(img.uuid)).toBe(frame)
    // The record now reads the project's copy, under the frame's name, and the
    // in-memory frame's URL is revoked so it can be freed.
    expect(opfs.loadImageBlob).toHaveBeenCalledWith('p1', img.uuid)
    expect(img.file).not.toBe(frame)
    expect(img.file.name).toBe('walk_00m01.500s.jpg')
    expect(img.url).not.toBe('blob:1')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1')

    // A picked file (IS-1) is read back from its copy too, so a moved original no
    // longer matters; its URL stays registered for any job queued with it.
    await store.addImages([photo])
    const picked = store.images[1]
    const pickedUrl = vi
      .mocked(URL.createObjectURL)
      .mock.results.find((r, k) => vi.mocked(URL.createObjectURL).mock.calls[k][0] === photo)?.value
    expect(picked.file).not.toBe(photo)
    expect(picked.file.name).toBe('photo.jpg')
    expect(picked.url).not.toBe(pickedUrl)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(pickedUrl)
    expect(picked.meta?.videoSource).toBeUndefined()
  })

  it('leaves a non-persisting session on the picked files', async () => {
    const projects = useProjectsStore()
    projects.persistenceAvailable = false
    projects.currentProjectId = null
    const load = vi.spyOn(opfs, 'loadImageBlob')
    const photo = new File([new Uint8Array(1000)], 'photo.jpg', { type: 'image/jpeg' })
    const store = useImagesStore()
    await store.addImages([photo])
    expect(store.images[0].file).toBe(photo)
    expect(load).not.toHaveBeenCalled()
  })

  it('skips the same file again, or adds it with its own id and label when allowed', async () => {
    const projects = useProjectsStore()
    projects.persistenceAvailable = false
    projects.currentProjectId = null
    const photo = new File([new Uint8Array(1000)], 'photo.jpg', { type: 'image/jpeg' })
    const store = useImagesStore()
    await store.addImages([photo])
    await store.addImages([photo])
    expect(store.images).toHaveLength(1)
    await store.addImages([photo, photo], null, { allowDuplicates: true })
    expect(store.images.map((img) => img.name)).toEqual(['photo.jpg', 'photo (2).jpg', 'photo (3).jpg'])
    expect(new Set(store.images.map((img) => img.id)).size).toBe(3)
    expect(store.images.every((img) => img.sourceName === 'photo.jpg')).toBe(true)
  })
})
