import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'
import { useImagesStore } from './useImagesStore.js'
import { usePosesStore } from './usePosesStore.js'
import { useProjectsStore } from './useProjectsStore.js'
import { useLog } from '../composables/useLog.js'

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
    images.images = [
      {
        id: 'image-1',
        uuid: 'uuid-1',
        name: 'drone.jpg',
        meta: { gpsLat: 48, gpsLon: 9, gpsAlt: 120, gpsHorizontalAccuracy: 0.7 },
      },
    ]
    await vi.waitFor(() => expect(poses.poses).toHaveLength(1))
    expect(poses.poses[0]).toMatchObject({
      imageId: 'image-1',
      source: 'exif',
      enabled: true,
      z: 120,
      altitudeMeters: 120,
      accuracyX: 0.7,
      accuracyY: 0.7,
      accuracyZ: 20,
    })
    expect(poses.poses[0].x).toBeCloseTo(500000, 3)
  })

  it('materializes EXIF orientation and per-axis GNSS accuracies', async () => {
    openTransientProject()
    const images = useImagesStore()
    const poses = usePosesStore()
    images.images = [
      {
        id: 'image-1',
        uuid: 'uuid-1',
        name: 'drone.jpg',
        meta: {
          gpsLat: 48,
          gpsLon: 9,
          gpsAlt: 120,
          gpsAccuracyX: 0.02,
          gpsAccuracyY: 0.03,
          gpsAccuracyZ: 0.06,
          cameraOmega: 1,
          cameraPhi: 2,
          cameraKappa: 3,
          cameraAccuracyOmega: 0.2,
          cameraAccuracyPhi: 0.3,
          cameraAccuracyKappa: 0.4,
          cameraOrientationSource: 'xmp-gimbal',
        },
      },
    ]
    await vi.waitFor(() => expect(poses.poses).toHaveLength(1))
    expect(poses.poses[0]).toMatchObject({
      source: 'exif',
      accuracyZ: 0.06,
      accuracyOmega: 0.2,
      accuracyPhi: 0.3,
      accuracyKappa: 0.4,
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
    images.images = [
      {
        id: 'image-1',
        uuid: 'uuid-1',
        name: 'drone.jpg',
        meta: {
          gpsLat: 48,
          gpsLon: 12,
          gpsAlt: 120,
          gpsAccuracyX: 1,
          gpsAccuracyY: 4,
          gpsAccuracyZ: 2,
          cameraOmega: 0,
          cameraPhi: 0,
          cameraKappa: 0,
        },
      },
    ]
    await vi.waitFor(() => expect(poses.poses).toHaveLength(1))
    const firstKappa = poses.poses[0].kappa
    await poses.reprojectPoses('EPSG:32632', 'EPSG:32633')

    expect(poses.poses[0].kappa).not.toBeCloseTo(firstKappa, 2)
    expect(poses.poses[0]).toMatchObject({
      lon: 12,
      lat: 48,
      accuracyMetersEast: 1,
      accuracyMetersNorth: 4,
      accuracyMetersUp: 2,
      omegaEnu: 0,
      phiEnu: 0,
      kappaEnu: 0,
    })
  })

  it('reports a batch of EXIF positions once, after the import goes idle', async () => {
    openTransientProject('EPSG:4326')
    const images = useImagesStore()
    const poses = usePosesStore()
    const { entries } = useLog()
    const exifLines = () => entries.value.map((e) => e.message).filter((m) => m.startsWith('EXIF GPS'))
    const before = exifLines().length
    images.pendingWorkCount = 1 // an import is running
    // Metadata lands one image at a time, each triggering its own sync.
    for (let i = 0; i < 3; i++) {
      images.images = [
        ...images.images,
        {
          id: `image-${i}`,
          uuid: `uuid-${i}`,
          name: `drone-${i}.jpg`,
          meta: { gpsLat: 48 + i * 1e-4, gpsLon: 9, gpsAlt: 120 },
        },
      ]
      await vi.waitFor(() => expect(poses.poses).toHaveLength(i + 1))
    }
    expect(exifLines().length).toBe(before)
    images.pendingWorkCount = 0
    await vi.waitFor(() => expect(exifLines().length).toBe(before + 2))
    const lines = exifLines().slice(before)
    expect(lines[0]).toContain('3 camera positions added in EPSG:4326')
    expect(lines[1]).toContain('EPSG:4326 is geographic')
    expect(lines[1]).toContain('EPSG:32632')
  })

  it('an EXIF pose synced again keeps the angle accuracies a reopened project gives it', async () => {
    // The georeference's evidence includes the poses: a pose that differs after a reopen
    // (null here, the default on load) retired every pose-fitted georeference.
    openTransientProject()
    const images = useImagesStore()
    const poses = usePosesStore()
    const photo = (n) => ({
      id: `image-${n}`,
      uuid: `uuid-${n}`,
      name: `p${n}.jpg`,
      meta: { gpsLat: 48, gpsLon: 9 + n * 1e-4, gpsAlt: 120 },
    })
    images.images = [photo(1)]
    await vi.waitFor(() => expect(poses.poses).toHaveLength(1))
    // Every write is seen (the georeference's check runs synchronously): not even for a
    // moment may a pose hold a null angle accuracy.
    let sawNull = false
    watch(
      () => poses.poses.map((p) => [p.accuracyOmega, p.accuracyPhi, p.accuracyKappa]),
      (v) => (sawNull ||= v.flat().some((x) => x == null)),
      { flush: 'sync' },
    )
    images.images = [photo(1), photo(2)] // the sync runs again over the first photo
    await vi.waitFor(() => expect(poses.poses).toHaveLength(2))
    expect(sawNull).toBe(false)
    for (const p of poses.poses) {
      expect([p.accuracyOmega, p.accuracyPhi, p.accuracyKappa]).toEqual([p.accAngle, p.accAngle, p.accAngle])
      expect(p.accAngle).toBeGreaterThan(0)
    }
  })

  it('gives every pose its own id, kept through a re-import and a CRS change', async () => {
    openTransientProject()
    const poses = usePosesStore()
    await poses.addPoses(
      [
        { imageName: 'a.jpg', x: 500000, y: 5316000 },
        { imageName: 'b.jpg', x: 500010, y: 5316000 },
      ],
      'EPSG:32632',
    )
    const [a, b] = poses.poses.map((p) => p.id)
    expect(a).toBeTruthy()
    expect(a).not.toBe(b)
    await poses.addPoses([{ imageName: 'a.jpg', x: 500001, y: 5316001 }], 'EPSG:32632') // re-import updates in place
    await poses.reprojectPoses('EPSG:32632', 'EPSG:4326')
    expect(poses.poses.map((p) => p.id)).toEqual([a, b])
  })

  it('updates in place on a re-import whose names differ from the photos only by extension or case', async () => {
    // A linked pose takes its photo's own name; the next import of the same file still
    // keys the row on the name as written ("DRONE"). Matched by the photo it resolves to,
    // it replaces the pose — a second copy would count that position twice in the solve.
    openTransientProject()
    const images = useImagesStore()
    images.images = [{ id: 'image-1', uuid: 'uuid-1', name: 'drone.jpg', meta: {} }]
    const poses = usePosesStore()
    await poses.addPoses([{ imageName: 'DRONE', x: 500100, y: 5316400, z: 125 }], 'EPSG:32632')
    // Any change to the photo list relinks the poses (so does reopening the project).
    images.images = [...images.images, { id: 'image-2', uuid: 'uuid-2', name: 'other.jpg', meta: {} }]
    await vi.waitFor(() => expect(poses.poses[0]?.imageName).toBe('drone.jpg'))
    const id = poses.poses[0].id
    await poses.addPoses([{ imageName: 'DRONE', x: 500101, y: 5316401, z: 126, accuracyZ: 0.02 }], 'EPSG:32632')
    expect(poses.poses).toHaveLength(1)
    expect(poses.poses[0]).toMatchObject({ id, imageId: 'image-1', x: 500101, z: 126, accuracyZ: 0.02 })
  })

  it('lets an imported pose override EXIF for the same image', async () => {
    openTransientProject()
    const images = useImagesStore()
    images.images = [
      {
        id: 'image-1',
        uuid: 'uuid-1',
        name: 'drone.jpg',
        meta: { gpsLat: 48, gpsLon: 9, gpsAlt: 120 },
      },
    ]
    const poses = usePosesStore()
    await poses.addPoses([{ imageName: 'drone.jpg', x: 500100, y: 5316400, z: 125 }], 'EPSG:32632')
    await poses.syncExifPoses()

    expect(poses.poses).toHaveLength(1)
    expect(poses.poses[0]).toMatchObject({ source: 'imported', x: 500100, z: 125 })
  })

  it('preserves per-axis imported position and orientation accuracies', async () => {
    openTransientProject()
    const poses = usePosesStore()
    await poses.addPoses(
      [
        {
          imageName: 'survey.jpg',
          x: 500100,
          y: 5316400,
          z: 125,
          omega: 1,
          phi: 2,
          kappa: 3,
          accuracyX: 0.02,
          accuracyY: 0.03,
          accuracyZ: 0.08,
          accuracyOmega: 0.1,
          accuracyPhi: 0.2,
          accuracyKappa: 0.4,
        },
      ],
      'EPSG:32632',
    )

    expect(poses.poses[0]).toMatchObject({
      accuracyX: 0.02,
      accuracyY: 0.03,
      accuracyZ: 0.08,
      accuracyOmega: 0.1,
      accuracyPhi: 0.2,
      accuracyKappa: 0.4,
    })
  })

  it('expands legacy scalar accuracies as per-axis fallbacks', async () => {
    openTransientProject()
    const poses = usePosesStore()
    await poses.addPoses(
      [
        {
          imageName: 'legacy.jpg',
          x: 500100,
          y: 5316400,
          z: 125,
          accXYZ: 0.5,
          accAngle: 1.5,
        },
      ],
      'EPSG:32632',
    )

    expect(poses.poses[0]).toMatchObject({
      accuracyX: 0.5,
      accuracyY: 0.5,
      accuracyZ: 0.5,
      accuracyOmega: 1.5,
      accuracyPhi: 1.5,
      accuracyKappa: 1.5,
    })
  })
})
