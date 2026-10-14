import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSensorsStore } from './useSensorsStore.js'
import { useProjectsStore } from './useProjectsStore.js'

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
    version: 1, method: 'certificate', transform: 'projective', allowReflection: false,
    slotMap: { 'corner-tl': 'F1', 'corner-tr': 'F2' },
    marks: [{ id: 'F1', xMm: -106, yMm: -106 }, { id: 'F2', xMm: 106, yMm: -106 }],
    focalMm: 152.8, ppxMm: 0, ppyMm: 0, scanPitchMm: null, fit: { rmsUm: 2 },
  })

  // The sensor table's principal point used to land on a separate certificate
  // copy that reconstruction never read once the sensor was calibrated.
  it('writes sensor-table focal and principal point into the calibration reconstruction reads', () => {
    const store = filmSensor(calibrated())
    store.updateSensor('s1', 'ppxMm', '0.03')
    store.updateSensor('s1', 'focalMm', '153')
    expect(store.sensors[0].fiducialCalibration).toMatchObject({
      ppxMm: 0.03, focalMm: 153, transform: 'projective', slotMap: { 'corner-tl': 'F1', 'corner-tr': 'F2' },
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
    store.setFiducialMarks('s1', [{ id: 'A', xMm: -106, yMm: -106 }, { id: 'F2', xMm: 106, yMm: -106 }])
    expect(store.sensors[0].fiducialCalibration).toMatchObject({
      slotMap: { 'corner-tl': 'A', 'corner-tr': 'F2' }, fit: null,
    })
  })

  it('drops the slot of a removed mark', () => {
    const store = filmSensor(calibrated())
    store.setFiducialMarks('s1', [{ id: 'F2', xMm: 106, yMm: -106 }])
    expect(store.sensors[0].fiducialCalibration.slotMap).toEqual({ 'corner-tr': 'F2' })
  })

  it('imports certificate marks into the same record', () => {
    const store = filmSensor(calibrated())
    store.importFiducialMarks([{ sensor: 'RC10', focalMm: 151, ppxMm: null, ppyMm: null, marks: [
      { id: 'F1', xMm: -100, yMm: -100, slot: null }, { id: 'F3', xMm: 100, yMm: 100, slot: null },
    ] }])
    expect(store.sensors[0].fiducialCalibration).toMatchObject({
      focalMm: 151, transform: 'projective', slotMap: { 'corner-tl': 'F1' }, fit: null,
      marks: [{ id: 'F1', xMm: -100, yMm: -100 }, { id: 'F3', xMm: 100, yMm: 100 }],
    })
    expect(store.sensors[0].fiducials).toBeUndefined()
  })
})
