import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSensorsStore } from './useSensorsStore.js'
import { useProjectsStore } from './useProjectsStore.js'
import { useImagesStore } from './useImagesStore.js'
import { estimateBatchFiducialLayout } from '../core/sfm/fiducialCalibration.js'

describe('film sensor fiducial record', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const projects = useProjectsStore()
    projects.persistenceAvailable = false
    projects.projects = [{ id: 'project-1', name: 'test', sceneType: 'aerial', crs: 'EPSG:32632' }]
    projects.currentProjectId = 'project-1'
  })

  function filmSensor(fiducialCalibration) {
    const store = useSensorsStore()
    store.sensors = [{ id: 's1', label: 'RC10', kind: 'film', fiducialCalibration }]
    return store
  }

  const calibrated = () => ({
    version: 1,
    method: 'certificate',
    transform: 'projective',
    allowReflection: false,
    slotMap: { 'corner-tl': 'F1', 'corner-tr': 'F2' },
    marks: [
      { id: 'F1', xMm: -106, yMm: -106 },
      { id: 'F2', xMm: 106, yMm: -106 },
    ],
    focalMm: 152.8,
    ppxMm: 0,
    ppyMm: 0,
    scanPitchMm: null,
    fit: { rmsUm: 2 },
  })

  // The sensor table's principal point used to land on a separate certificate
  // copy that reconstruction never read once the sensor was calibrated.
  it('writes sensor-table focal and principal point into the calibration reconstruction reads', () => {
    const store = filmSensor(calibrated())
    store.updateSensor('s1', 'ppxMm', '0.03')
    store.updateSensor('s1', 'focalMm', '153')
    expect(store.sensors[0].fiducialCalibration).toMatchObject({
      ppxMm: 0.03,
      focalMm: 153,
      transform: 'projective',
      slotMap: { 'corner-tl': 'F1', 'corner-tr': 'F2' },
    })
    expect(store.sensors[0]).toMatchObject({ focal: 153, focalUnit: 'mm' })
  })

  it('starts an uncalibrated record when a sensor becomes film', () => {
    const store = useSensorsStore()
    store.sensors = [{ id: 's1', label: 'Cam', focal: 150, focalUnit: 'mm' }]
    store.updateSensor('s1', 'kind', 'film')
    expect(store.sensors[0].fiducialCalibration).toMatchObject({ marks: [], slotMap: {}, focalMm: 150, fit: null })
  })

  it('keeps the slot map on a mark renamed in place and clears the fit', () => {
    const store = filmSensor(calibrated())
    store.setFiducialMarks('s1', [
      { id: 'A', xMm: -106, yMm: -106 },
      { id: 'F2', xMm: 106, yMm: -106 },
    ])
    expect(store.sensors[0].fiducialCalibration).toMatchObject({
      slotMap: { 'corner-tl': 'A', 'corner-tr': 'F2' },
      fit: null,
    })
  })

  it('drops the slot of a removed mark', () => {
    const store = filmSensor(calibrated())
    store.setFiducialMarks('s1', [{ id: 'F2', xMm: 106, yMm: -106 }])
    expect(store.sensors[0].fiducialCalibration.slotMap).toEqual({ 'corner-tr': 'F2' })
  })

  it('imports certificate marks into the same record', () => {
    const store = filmSensor(calibrated())
    store.importFiducialMarks([
      {
        sensor: 'RC10',
        focalMm: 151,
        ppxMm: null,
        ppyMm: null,
        marks: [
          { id: 'F1', xMm: -100, yMm: -100, slot: null },
          { id: 'F3', xMm: 100, yMm: 100, slot: null },
        ],
      },
    ])
    expect(store.sensors[0].fiducialCalibration).toMatchObject({
      focalMm: 151,
      transform: 'projective',
      slotMap: { 'corner-tl': 'F1' },
      fit: null,
      marks: [
        { id: 'F1', xMm: -100, yMm: -100 },
        { id: 'F3', xMm: 100, yMm: 100 },
      ],
    })
    expect(store.sensors[0].fiducials).toBeUndefined()
  })
})

describe('splitSensor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const projects = useProjectsStore()
    projects.persistenceAvailable = false
    projects.projects = [{ id: 'project-1', name: 'test', sceneType: 'aerial', crs: 'EPSG:32632' }]
    projects.currentProjectId = 'project-1'
  })

  // Four marks in scan pixels, 0.025 mm apart; `spread` sets how far apart they are.
  const scan = (id, spread) => ({
    id,
    name: `${id}.tif`,
    sensorId: 's1',
    fiducialDetections: [
      { slot: 'corner_top_left', px: 5000 - spread, py: 5000 - spread },
      { slot: 'corner_top_right', px: 5000 + spread, py: 5000 - spread },
      { slot: 'corner_bottom_right', px: 5000 + spread, py: 5000 + spread },
      { slot: 'corner_bottom_left', px: 5000 - spread, py: 5000 + spread },
    ],
  })

  function setup(method) {
    const images = useImagesStore()
    images.images = [scan('a1', 4000), scan('a2', 4000), scan('b1', 4400)]
    const store = useSensorsStore()
    const cal = estimateBatchFiducialLayout(images.images, 0.025, { focalMm: 153.5 })
    store.sensors = [
      { id: 's1', label: 'Camera L', kind: 'film', signature: 'sig', fiducialCalibration: { ...cal, method } },
    ]
    return { images, store }
  }

  it('moves each group to its own sensor and estimates a batch layout per group', () => {
    const { images, store } = setup('batch')
    const ids = store.splitSensor('s1', [
      { label: 'Camera L · A', imageIds: ['a1', 'a2'] },
      { label: 'Camera L · B', imageIds: ['b1'] },
    ])
    expect(ids[0]).toBe('s1')
    expect(store.sensors.map((s) => s.label)).toEqual(['Camera L · A', 'Camera L · B'])
    expect(images.images.map((i) => i.sensorId)).toEqual(['s1', 's1', ids[1]])
    expect(store.sensors[1]).toMatchObject({ kind: 'film', signature: null })
    // 4000 px × 0.025 mm = 100 mm from the centre, 4400 px = 110 mm.
    const corner = (s) => s.fiducialCalibration.marks.find((m) => m.id === 'corner_top_right').xMm
    expect(corner(store.sensors[0])).toBeCloseTo(100, 6)
    expect(corner(store.sensors[1])).toBeCloseTo(110, 6)
    expect(store.sensors[1].fiducialCalibration.focalMm).toBe(153.5)
  })

  it("keeps the sensor's own layout for a group it cannot be estimated from", () => {
    const { images, store } = setup('batch')
    const before = store.sensors[0].fiducialCalibration.marks
    // a1 and a2: no marks found; b1 alone gives another layout (110 mm, not 100).
    images.images[0].fiducialDetections = []
    images.images[1].fiducialDetections = []
    const ids = store.splitSensor('s1', [
      { label: 'Camera L · B', imageIds: ['b1'] },
      { label: 'Camera L · A', imageIds: ['a1', 'a2'] },
    ])
    expect(store.sensors.find((s) => s.id === ids[1]).fiducialCalibration.marks).toEqual(before)
  })

  it('copies a certificate layout to every group', () => {
    const { store } = setup('certificate')
    const before = store.sensors[0].fiducialCalibration.marks
    store.splitSensor('s1', [{ imageIds: ['a1', 'a2'] }, { label: 'Camera L · B', imageIds: ['b1'] }])
    expect(store.sensors.map((s) => s.label)).toEqual(['Camera L', 'Camera L · B'])
    expect(store.sensors[1].fiducialCalibration.marks).toEqual(before)
  })
})
