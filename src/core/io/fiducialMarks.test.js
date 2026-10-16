import { describe, it, expect } from 'vitest'
import { parseFiducialMarks, looksLikeFiducialMarks, applyFiducialMarks, planFiducialMarkTargets } from './fiducialMarks.js'

describe('parseFiducialMarks', () => {
  it('groups a headered file by sensor, with per-sensor focal and principal point', () => {
    const text = [
      'sensor,fiducial,x_mm,y_mm,slot,focal_mm,ppx_mm,ppy_mm',
      'RC10,F1,-106,-106,corner-tl,152.8,0.01,-0.02',
      'RC10,F2,106,-106,corner-tr,152.8,0.01,-0.02',
      'RC20,1,-110,110,,153.1,,',
    ].join('\n')
    const { groups } = parseFiducialMarks(text)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({
      sensor: 'RC10', focalMm: 152.8, ppxMm: 0.01, ppyMm: -0.02,
      marks: [
        { id: 'F1', xMm: -106, yMm: -106, slot: 'corner-tl' },
        { id: 'F2', xMm: 106, yMm: -106, slot: 'corner-tr' },
      ],
    })
    expect(groups[1]).toMatchObject({ sensor: 'RC20', focalMm: 153.1, ppxMm: null, ppyMm: null })
    expect(groups[1].marks[0].slot).toBeNull()
  })

  it('reads a headerless `id, xMm, yMm` block like the paste box', () => {
    const { groups } = parseFiducialMarks('F1\t-106\t-106\nF2\t106\t-106\nbad\tx\ty')
    expect(groups).toEqual([{ sensor: '', focalMm: null, ppxMm: null, ppyMm: null, marks: [
      { id: 'F1', xMm: -106, yMm: -106, slot: null },
      { id: 'F2', xMm: 106, yMm: -106, slot: null },
    ] }])
  })

  it('recognises a marks header but not an image-fiducial or GCP one', () => {
    expect(looksLikeFiducialMarks(['fiducial', 'x_mm', 'y_mm'])).toBe(true)
    expect(looksLikeFiducialMarks(['image', 'fiducial', 'px', 'py'])).toBe(false)
    expect(looksLikeFiducialMarks(['id', 'x', 'y', 'z'])).toBe(false)
  })
})

describe('applyFiducialMarks', () => {
  const group = (slots) => ({
    sensor: 'RC10', focalMm: 152.8, ppxMm: null, ppyMm: null,
    marks: [
      { id: 'F1', xMm: -106, yMm: -106, slot: slots ? 'corner-tl' : null },
      { id: 'F2', xMm: 106, yMm: -106, slot: slots ? 'corner-tr' : null },
    ],
  })

  it('records an uncalibrated certificate when the file has no slots and nothing is calibrated', () => {
    const r = applyFiducialMarks({ fiducialCalibration: { marks: [], slotMap: {}, ppxMm: 0.5, ppyMm: 0, focalMm: 0 } }, group(false))
    expect(r).toMatchObject({
      marks: [{ id: 'F1', xMm: -106, yMm: -106 }, { id: 'F2', xMm: 106, yMm: -106 }],
      ppxMm: 0.5, ppyMm: 0, focalMm: 152.8, slotMap: {}, fit: null,
    })
  })

  it('builds a certificate calibration from slotted marks', () => {
    const r = applyFiducialMarks({}, group(true))
    expect(r).toMatchObject({
      method: 'certificate', transform: 'affine', focalMm: 152.8, fit: null,
      slotMap: { 'corner-tl': 'F1', 'corner-tr': 'F2' },
    })
  })

  it('updates an existing calibration, keeping its transform and surviving slot entries', () => {
    const old = {
      method: 'batch', transform: 'projective', scanPitchMm: 0.021, fit: { rmsUm: 3 },
      slotMap: { 'corner-tl': 'F1', 'corner-br': 'F9' }, marks: [], focalMm: 150, ppxMm: 0.1, ppyMm: 0.2,
    }
    const r = applyFiducialMarks({ fiducialCalibration: old }, group(false))
    expect(r).toMatchObject({
      method: 'certificate', transform: 'projective', scanPitchMm: 0.021, fit: null,
      slotMap: { 'corner-tl': 'F1' }, focalMm: 152.8, ppxMm: 0.1, ppyMm: 0.2,
    })
  })
})

describe('planFiducialMarkTargets', () => {
  const sensors = [{ id: 'a', label: 'RC10', kind: 'film' }, { id: 'b', label: 'Drone' }]
  it('matches by label, else a lone group goes to the only film sensor', () => {
    expect(planFiducialMarkTargets([{ sensor: 'drone' }], sensors)).toEqual(['b'])
    expect(planFiducialMarkTargets([{ sensor: '' }], sensors)).toEqual(['a'])
    expect(planFiducialMarkTargets([{ sensor: '' }, { sensor: 'x' }], sensors)).toEqual([null, null])
  })
})
