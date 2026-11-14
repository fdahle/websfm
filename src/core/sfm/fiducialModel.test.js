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
    // A stored detection is a mark (pixel-edge); the fit gets the pixel centre.
    expect(calibratedFiducialPairs(image, sensor)[0]).toMatchObject({ fidId: 'F1', px: 4.5, py: 5.5, xMm: -10 })
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

// The review's P12 check: a fiducial clicked or detected on a pixel and a keypoint on that
// pixel are the same scan point, so they reach the same film position.
describe('fiducial marks and keypoints share one film frame', () => {
  it("puts a keypoint on a mark's pixel at the mark's film position", async () => {
    const { fitFiducialTransform, applyFiducialTransform } = await import('./fiducialCalibration.js')
    const pitch = 0.015 // mm per scan px
    const marks = [
      { id: 'F1', xMm: -100, yMm: 100 },
      { id: 'F2', xMm: 100, yMm: 100 },
      { id: 'F3', xMm: 100, yMm: -100 },
      { id: 'F4', xMm: -100, yMm: -100 },
    ]
    // Film mm → the scan pixel (index) it lands on: 7,000 px square scan, y down.
    const pixelOf = (m) => ({ x: 3500 + m.xMm / pitch, y: 3500 - m.yMm / pitch })
    const slots = ['corner-tl', 'corner-tr', 'corner-br', 'corner-bl']
    const sensor = {
      fiducialCalibration: { marks, slotMap: Object.fromEntries(slots.map((s, i) => [s, marks[i].id])) },
    }
    // Stored as the viewer stores a click on that pixel: its centre, pixel-edge (i + ½).
    const image = {
      fiducialDetections: marks.map((m, i) => ({
        slot: slots[i],
        px: pixelOf(m).x + 0.5,
        py: pixelOf(m).y + 0.5,
        source: 'manual',
      })),
    }
    const fit = fitFiducialTransform(calibratedFiducialPairs(image, sensor), 'affine')
    // A keypoint is a pixel index: the keypoint on the pixel of a point 30 mm right and
    // 40 mm up of the centre.
    const p = { xMm: 30, yMm: 40 }
    const mm = applyFiducialTransform(pixelOf(p), fit)
    expect(Math.abs(mm.x - p.xMm) / pitch).toBeLessThan(0.05)
    expect(Math.abs(mm.y - p.yMm) / pitch).toBeLessThan(0.05)
  })
})
