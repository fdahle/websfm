import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useImagesStore } from './useImagesStore.js'
import { usePosesStore } from './usePosesStore.js'
import { useProjectsStore } from './useProjectsStore.js'

describe('EXIF pose synchronization', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function openTransientProject(crs = 'EPSG:32632') {
    const projects = useProjectsStore()
    projects.persistenceAvailable = false
    projects.projects = [{ id: 'project-1', name: 'test', sceneType: 'aerial', crs }]
    projects.currentProjectId = 'project-1'
    return projects
  }

  it('materializes EXIF GPS in the project CRS with altitude and accuracy', async () => {
    openTransientProject()
    const images = useImagesStore()
    const poses = usePosesStore()
    images.images = [{
      id: 'image-1', uuid: 'uuid-1', name: 'drone.jpg',
      meta: { gpsLat: 48, gpsLon: 9, gpsAlt: 120, gpsHorizontalAccuracy: 0.7 },
    }]
    await vi.waitFor(() => expect(poses.poses).toHaveLength(1))
    expect(poses.poses[0]).toMatchObject({
      imageId: 'image-1', source: 'exif', enabled: true,
      z: 120, altitudeMeters: 120,
      accuracyX: 0.7, accuracyY: 0.7, accuracyZ: 20,
    })
    expect(poses.poses[0].x).toBeCloseTo(500000, 3)
  })

  it('lets an imported pose override EXIF for the same image', async () => {
    openTransientProject()
    const images = useImagesStore()
    images.images = [{
      id: 'image-1', uuid: 'uuid-1', name: 'drone.jpg',
      meta: { gpsLat: 48, gpsLon: 9, gpsAlt: 120 },
    }]
    const poses = usePosesStore()
    await poses.addPoses([{ imageName: 'drone.jpg', x: 500100, y: 5316400, z: 125 }], 'EPSG:32632')
    await poses.syncExifPoses()

    expect(poses.poses).toHaveLength(1)
    expect(poses.poses[0]).toMatchObject({ source: 'imported', x: 500100, z: 125 })
  })
})
