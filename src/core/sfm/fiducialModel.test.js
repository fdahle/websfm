import { describe, expect, it } from 'vitest'
import { calibratedFiducialPairs, classifyDetectionSlot, deriveLegacyCalibration, migrateLegacyFiducialImage, slotsForPositions } from './fiducialModel.js'

describe('fiducial model split', () => {
  it('defines stable raster-relative corner and side slots', () => {
    expect(slotsForPositions('corners+sides')).toHaveLength(8)
    expect(classifyDetectionSlot(5, 5, 100, 100)).toBe('corner-tl')
    expect(classifyDetectionSlot(98, 50, 100, 100)).toBe('side-right')
  })
  it('joins detections to metric marks only through calibration', () => {
    const image = { fiducialDetections: [{ slot: 'corner-tl', px: 5, py: 6 }] }
    expect(calibratedFiducialPairs(image, {})).toEqual([])
    const sensor = { fiducialCalibration: { slotMap: { 'corner-tl': 'F1' }, marks: [{ id: 'F1', xMm: -10, yMm: -20 }] } }
    expect(calibratedFiducialPairs(image, sensor)[0]).toMatchObject({ fidId: 'F1', px: 5, xMm: -10 })
  })
  it('migrates legacy observations and preserves their metric identity mapping', () => {
    const sensor = { fiducials: { focalMm: 100, marks: [
      { id: 'A', xMm: -10, yMm: -10 }, { id: 'B', xMm: 10, yMm: -10 },
      { id: 'C', xMm: 10, yMm: 10 }, { id: 'D', xMm: -10, yMm: 10 },
    ] } }
    const image = { meta: { width: 100, height: 100 }, fiducialObs: [
      { fidId: 'A', px: 2, py: 2 }, { fidId: 'B', px: 98, py: 2 },
      { fidId: 'C', px: 98, py: 98 }, { fidId: 'D', px: 2, py: 98 },
    ] }
    const detections = migrateLegacyFiducialImage(image, sensor)
    const calibration = deriveLegacyCalibration(sensor, detections)
    expect(detections.map((d) => d.slot)).toEqual(['corner-tl', 'corner-tr', 'corner-br', 'corner-bl'])
    expect(calibration.slotMap['corner-tl']).toBe('A')
  })
})
