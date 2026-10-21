import { describe, expect, it } from 'vitest'
import {
  calibratedFiducialPairs,
  classifyDetectionSlot,
  emptyFiducialCalibration,
  isFiducialCalibrated,
  observationsToDetections,
  slotsForPositions,
} from './fiducialModel.js'

describe('fiducial model', () => {
  it('defines stable raster-relative corner and side slots', () => {
    expect(slotsForPositions('corners+sides')).toHaveLength(8)
    expect(classifyDetectionSlot(5, 5, 100, 100)).toBe('corner-tl')
    expect(classifyDetectionSlot(98, 50, 100, 100)).toBe('side-right')
  })
  it('joins detections to metric marks only through calibration', () => {
    const image = { fiducialDetections: [{ slot: 'corner-tl', px: 5, py: 6 }] }
    expect(calibratedFiducialPairs(image, {})).toEqual([])
    const sensor = {
      fiducialCalibration: { slotMap: { 'corner-tl': 'F1' }, marks: [{ id: 'F1', xMm: -10, yMm: -20 }] },
    }
    expect(calibratedFiducialPairs(image, sensor)[0]).toMatchObject({ fidId: 'F1', px: 5, xMm: -10 })
  })
  it('treats a certificate without a slot map as uncalibrated', () => {
    const marks = [{ id: 'F1', xMm: -10, yMm: -20 }]
    expect(isFiducialCalibrated(emptyFiducialCalibration())).toBe(false)
    expect(isFiducialCalibrated({ ...emptyFiducialCalibration(), marks })).toBe(false)
    expect(isFiducialCalibrated({ ...emptyFiducialCalibration(), marks, slotMap: { 'corner-tl': '' } })).toBe(false)
    expect(isFiducialCalibrated({ ...emptyFiducialCalibration(), marks, slotMap: { 'corner-tl': 'F1' } })).toBe(true)
  })
  it('keeps an imported slot id and places a mark id by position', () => {
    const d = observationsToDetections(
      [
        { fidId: 'side-left', px: 50, py: 50 },
        { fidId: 'F2', px: 98, py: 2 },
        { fidId: 'custom-x', px: 40, py: 40 },
      ],
      100,
      100,
      { family: 'generic', source: 'import' },
    )
    expect(d.map((x) => x.slot)).toEqual(['side-left', 'corner-tr', 'custom-x'])
    expect(d[0]).toEqual({
      slot: 'side-left',
      px: 50,
      py: 50,
      family: 'generic',
      source: 'import',
      confidence: 1,
      reviewed: true,
    })
    expect(d[1].markId).toBe('F2')
  })
})
