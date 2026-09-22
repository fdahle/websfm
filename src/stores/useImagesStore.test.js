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
