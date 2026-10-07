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
    vi.spyOn(opfs, 'loadKeypoints').mockResolvedValue(null)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:restored-image')

    const store = useImagesStore()
    await store.restoreImages([{
      id: 'image-1', uuid: 'uuid-1', name: 'photo.jpg', meta: { width: 100, height: 80 },
      kpStatus: 'done', kpCount: 250,
    }], 'project-1')

    expect(store.images[0]).toMatchObject({ kpStatus: 'error', kpCount: 0, keypoints: [] })
    expect(store.keypointReadyImages).toEqual([])
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
    await store.sync('project-1')

    const doc = write.mock.calls.at(-1)[1]
    expect(doc.imageGroups.map((g) => g.name)).toEqual(['First', 'North'])
    expect(doc.images.map((i) => i.groupId)).toEqual([null, group.id, null])
  })
})
