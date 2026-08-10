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

  it('materializes EXIF orientation and per-axis GNSS accuracies', async () => {
    openTransientProject()
    const images = useImagesStore()
    const poses = usePosesStore()
    images.images = [{
      id: 'image-1', uuid: 'uuid-1', name: 'drone.jpg',
      meta: {
        gpsLat: 48, gpsLon: 9, gpsAlt: 120,
        gpsAccuracyX: 0.02, gpsAccuracyY: 0.03, gpsAccuracyZ: 0.06,
        cameraOmega: 1, cameraPhi: 2, cameraKappa: 3,
        cameraAccuracyOmega: 0.2, cameraAccuracyPhi: 0.3, cameraAccuracyKappa: 0.4,
        cameraOrientationSource: 'xmp-gimbal',
      },
    }]
    await vi.waitFor(() => expect(poses.poses).toHaveLength(1))
    expect(poses.poses[0]).toMatchObject({
      source: 'exif',
      accuracyZ: 0.06,
      accuracyOmega: 0.2, accuracyPhi: 0.3, accuracyKappa: 0.4,
      orientationSource: 'xmp-gimbal',
    })
    expect(poses.poses[0].omega).toBeCloseTo(1, 5)
    expect(poses.poses[0].phi).toBeCloseTo(2, 5)
    expect(poses.poses[0].kappa).toBeCloseTo(3, 5)
    expect(poses.poses[0].accuracyX).toBeCloseTo(0.02, 12)
    expect(poses.poses[0].accuracyY).toBeCloseTo(0.03, 12)
  })

  it('recomputes EXIF grid attitude and anisotropic accuracy after a CRS change', async () => {
    openTransientProject('EPSG:32632')
    const images = useImagesStore()
    const poses = usePosesStore()
    images.images = [{
      id: 'image-1', uuid: 'uuid-1', name: 'drone.jpg',
      meta: {
        gpsLat: 48, gpsLon: 12, gpsAlt: 120,
        gpsAccuracyX: 1, gpsAccuracyY: 4, gpsAccuracyZ: 2,
        cameraOmega: 0, cameraPhi: 0, cameraKappa: 0,
      },
    }]
    await vi.waitFor(() => expect(poses.poses).toHaveLength(1))
    const firstKappa = poses.poses[0].kappa
    await poses.reprojectPoses('EPSG:32632', 'EPSG:32633')

    expect(poses.poses[0].kappa).not.toBeCloseTo(firstKappa, 2)
    expect(poses.poses[0]).toMatchObject({
      lon: 12, lat: 48,
      accuracyMetersEast: 1, accuracyMetersNorth: 4, accuracyMetersUp: 2,
      omegaEnu: 0, phiEnu: 0, kappaEnu: 0,
    })
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

  it('preserves per-axis imported position and orientation accuracies', async () => {
    openTransientProject()
    const poses = usePosesStore()
    await poses.addPoses([{
      imageName: 'survey.jpg', x: 500100, y: 5316400, z: 125,
      omega: 1, phi: 2, kappa: 3,
      accuracyX: 0.02, accuracyY: 0.03, accuracyZ: 0.08,
      accuracyOmega: 0.1, accuracyPhi: 0.2, accuracyKappa: 0.4,
    }], 'EPSG:32632')

    expect(poses.poses[0]).toMatchObject({
      accuracyX: 0.02, accuracyY: 0.03, accuracyZ: 0.08,
      accuracyOmega: 0.1, accuracyPhi: 0.2, accuracyKappa: 0.4,
    })
  })

  it('expands legacy scalar accuracies as per-axis fallbacks', async () => {
    openTransientProject()
    const poses = usePosesStore()
    await poses.addPoses([{
      imageName: 'legacy.jpg', x: 500100, y: 5316400, z: 125,
      accXYZ: 0.5, accAngle: 1.5,
    }], 'EPSG:32632')

    expect(poses.poses[0]).toMatchObject({
      accuracyX: 0.5, accuracyY: 0.5, accuracyZ: 0.5,
      accuracyOmega: 1.5, accuracyPhi: 1.5, accuracyKappa: 1.5,
    })
  })
})
