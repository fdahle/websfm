import { computed, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as opfs from '../utils/opfs.js'
import { useImagesStore } from './useImagesStore.js'
import { useProjectsStore } from './useProjectsStore.js'

describe('image project restore readiness', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('invalidates reactive loading guards when restored assets become ready', async () => {
    const projects = useProjectsStore()
    projects.persistenceAvailable = false
    projects.projects = [{ id: 'project-1', name: 'test', sceneType: 'object' }]
    projects.currentProjectId = 'project-1'

    let finishLoad
    vi.spyOn(opfs, 'loadImageBlob').mockReturnValue(new Promise((resolve) => { finishLoad = resolve }))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:restored-image')

    const store = useImagesStore()
    const imagesLoading = computed(() =>
      store.images.some((image) => image.loading || image.previewPending))
    const restoring = store.restoreImages([{
      id: 'image-1', uuid: 'uuid-1', name: 'photo.jpg', meta: { width: 100, height: 80 },
      kpStatus: 'idle', kpCount: 0,
    }], 'project-1')

    await nextTick()
    expect(imagesLoading.value).toBe(true)

    finishLoad(new Blob(['pixels'], { type: 'image/jpeg' }))
    await restoring
    await nextTick()

    expect(store.images[0]).toMatchObject({
      url: 'blob:restored-image', computeUrl: 'blob:restored-image',
      loading: false, previewPending: false,
    })
    expect(imagesLoading.value).toBe(false)
  })

  it('does not advertise restored keypoints when their sidecar is missing', async () => {
    const projects = useProjectsStore()
    projects.persistenceAvailable = false
    projects.projects = [{ id: 'project-1', name: 'test', sceneType: 'object' }]
    projects.currentProjectId = 'project-1'
    vi.spyOn(opfs, 'loadImageBlob').mockResolvedValue(new Blob(['pixels'], { type: 'image/jpeg' }))
    vi.spyOn(opfs, 'listKeypointFiles').mockResolvedValue(new Set())
    const load = vi.spyOn(opfs, 'loadKeypoints').mockResolvedValue(null)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:restored-image')

    const store = useImagesStore()
    await store.restoreImages([{
      id: 'image-1', uuid: 'uuid-1', name: 'photo.jpg', meta: { width: 100, height: 80 },
      kpStatus: 'done', kpCount: 250,
    }], 'project-1')

    // One directory listing decides it; no keypoint file is opened at restore.
    expect(load).not.toHaveBeenCalled()
    expect(store.images[0]).toMatchObject({ kpStatus: 'error', kpCount: 0 })
    expect(store.images[0].keypoints).toBeUndefined()
    expect(store.keypointReadyImages).toEqual([])
    expect(await store.ensureKeypoints('image-1')).toBeNull()
  })
})

describe('keypoints on demand', () => {
  const records = [
    { id: 'image-1', uuid: 'uuid-1', name: 'a.jpg', meta: { width: 100, height: 80 }, kpStatus: 'done', kpCount: 2 },
    { id: 'image-2', uuid: 'uuid-2', name: 'b.jpg', meta: { width: 100, height: 80 }, kpStatus: 'done', kpCount: 3 },
    { id: 'image-3', uuid: 'uuid-3', name: 'c.jpg', meta: { width: 100, height: 80 }, kpStatus: 'idle', kpCount: 0 },
  ]
  // On-disk layout (core/features/keypoints.js): 6 floats per keypoint.
  const files = { 'uuid-1': new Float32Array(12).fill(1), 'uuid-2': new Float32Array(18).fill(2) }
  let load
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    const projects = useProjectsStore()
    projects.persistenceAvailable = false
    projects.projects = [{ id: 'project-1', name: 'test', sceneType: 'object' }]
    projects.currentProjectId = 'project-1'
    vi.spyOn(opfs, 'loadImageBlob').mockResolvedValue(new Blob(['pixels'], { type: 'image/jpeg' }))
    vi.spyOn(opfs, 'listKeypointFiles').mockResolvedValue(new Set(Object.keys(files)))
    load = vi.spyOn(opfs, 'loadKeypoints').mockImplementation(async (_p, uuid) => files[uuid]?.slice() ?? null)
    vi.spyOn(opfs, 'loadColors').mockResolvedValue(null)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:restored-image')
  })

  it('restores counts without reading a keypoint file, then loads one image once', async () => {
    const store = useImagesStore()
    await store.restoreImages(records, 'project-1')
    expect(load).not.toHaveBeenCalled()
    expect(store.keypointReadyImages.map((im) => im.id)).toEqual(['image-1', 'image-2'])
    expect(store.keypointCacheStats().entries).toBe(0)
    expect(store.residentKeypoints('image-1')).toBeNull()

    const kps = await store.ensureKeypoints('image-1')
    expect(kps.length).toBe(2)
    expect(await store.ensureKeypoints(store.images[0])).toBe(kps) // cached
    expect(store.residentKeypoints('image-1')).toBe(kps)
    expect(load).toHaveBeenCalledTimes(1)
    // A bulk read goes past the cache.
    expect((await store.readKeypoints('image-2')).length).toBe(3)
    expect(store.residentKeypoints('image-2')).toBeNull()
    expect(store.keypointCacheStats().entries).toBe(1)
    // Nothing detected ⇒ nothing read.
    expect(await store.ensureKeypoints('image-3')).toBeNull()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shares one read between concurrent requests and trusts the file over a stale count', async () => {
    const store = useImagesStore()
    await store.restoreImages([{ ...records[0], kpCount: 5 }], 'project-1')
    const [a, b] = await Promise.all([store.ensureKeypoints('image-1'), store.ensureKeypoints('image-1')])
    expect(a).toBe(b)
    expect(load).toHaveBeenCalledTimes(1)
    expect(store.images[0].kpCount).toBe(2)
  })

  it('drops a read that a re-detection or a clear overtook', async () => {
    const store = useImagesStore()
    await store.restoreImages(records, 'project-1')
    const pending = store.ensureKeypoints('image-1')
    store.clearKeypoints('image-1')
    expect(await pending).toBeNull()
    expect(store.keypointCacheStats().entries).toBe(0)
  })
})

describe('image groups', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.spyOn(opfs, 'loadImageBlob').mockResolvedValue(new Blob(['pixels'], { type: 'image/jpeg' }))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:restored-image')
  })

  function openProject() {
    const projects = useProjectsStore()
    projects.persistenceAvailable = false
    projects.projects = [{ id: 'project-1', name: 'test', sceneType: 'object' }]
    projects.currentProjectId = 'project-1'
    return projects
  }
  const records = [
    { id: 'a', uuid: 'ua', name: 'a.jpg', kpStatus: 'idle', groupId: 'g1' },
    { id: 'b', uuid: 'ub', name: 'b.jpg', kpStatus: 'idle', groupId: 'missing' },
    { id: 'c', uuid: 'uc', name: 'c.jpg', kpStatus: 'idle' },
  ]

  it('restores groups and drops membership of a group that no longer exists', async () => {
    openProject()
    const store = useImagesStore()
    await store.restoreImages(records, 'project-1', undefined, {
      groups: [{ id: 'g1', name: 'North', collapsed: true }],
    })
    expect(store.imageGroups).toEqual([{ id: 'g1', name: 'North', collapsed: true }])
    expect(store.images.map((i) => i.groupId)).toEqual(['g1', null, null])
  })

  it('a project saved before groups existed restores with none', async () => {
    openProject()
    const store = useImagesStore()
    await store.restoreImages(records, 'project-1')
    expect(store.imageGroups).toEqual([])
    expect(store.images.every((i) => i.groupId === null)).toBe(true)
  })

  it('creates, fills, renames and removes a group without touching image order', async () => {
    openProject()
    const store = useImagesStore()
    await store.restoreImages(records, 'project-1')

    const group = store.createImageGroup({ imageIds: ['c', 'a'] })
    expect(group.name).toBe('Group 1')
    expect(store.images.map((i) => i.groupId)).toEqual([group.id, null, group.id])

    expect(store.renameImageGroup(group.id, '  South strip ')).toBe(true)
    expect(store.imageGroups[0].name).toBe('South strip')

    expect(store.setImagesGroup(['a'], null)).toBe(1)
    expect(store.setImagesGroup(['b'], 'no-such-group')).toBe(0)

    expect(store.removeImageGroup(group.id)).toBe(true)
    expect(store.imageGroups).toEqual([])
    expect(store.images.map((i) => [i.id, i.groupId])).toEqual([['a', null], ['b', null], ['c', null]])
  })

  it('persists the group list and each image\'s groupId', async () => {
    const projects = openProject()
    const store = useImagesStore()
    await store.restoreImages(records, 'project-1')
    const group = store.createImageGroup({ name: 'North', imageIds: ['b'] })
    store.moveImageGroup(store.createImageGroup({ name: 'First' }).id, -1)

    projects.persistenceAvailable = true
    const write = vi.spyOn(opfs, 'writeProject').mockResolvedValue(undefined)
    await store.save('project-1')

    const doc = write.mock.calls.at(-1)[1]
    expect(doc.imageGroups.map((g) => g.name)).toEqual(['First', 'North'])
    expect(doc.images.map((i) => i.groupId)).toEqual([null, group.id, null])
  })
})
