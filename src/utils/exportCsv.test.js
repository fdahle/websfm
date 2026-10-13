import { describe, expect, it } from 'vitest'
import { buildPosesCsv, buildFiducialObsCsv, buildFiducialMarksCsv } from './exportCsv.js'
import { parseFiducialObs } from '../core/io/fiducialObs.js'
import { parseFiducialMarks } from '../core/io/fiducialMarks.js'
import { detectFileKind } from '../core/io/importKind.js'

describe('buildPosesCsv', () => {
  it('exports per-axis position and orientation accuracies', () => {
    const csv = buildPosesCsv([{
      imageName: 'survey.jpg', x: 1, y: 2, z: 3,
      omega: 4, phi: 5, kappa: 6,
      accuracyX: 0.01, accuracyY: 0.02, accuracyZ: 0.03,
      accuracyOmega: 0.1, accuracyPhi: 0.2, accuracyKappa: 0.3,
    }], 'EPSG:32632')

    expect(csv).toBe(
      'image,X,Y,Z,omega,phi,kappa,accuracy_x,accuracy_y,accuracy_z,'
      + 'accuracy_omega,accuracy_phi,accuracy_kappa,crs\r\n'
      + 'survey.jpg,1,2,3,4,5,6,0.01,0.02,0.03,0.1,0.2,0.3,EPSG:32632\r\n',
    )
  })

  it('exports legacy scalar accuracies as axis fallbacks', () => {
    const csv = buildPosesCsv([{
      imageName: 'legacy.jpg', x: 1, y: 2, z: 3,
      omega: null, phi: null, kappa: null, accXYZ: 5, accAngle: 2,
    }], 'EPSG:32632')

    expect(csv).toContain('legacy.jpg,1,2,3,,,,5,5,5,2,2,2,EPSG:32632')
  })
})

describe('fiducial CSVs round-trip through their importers', () => {
  it('image fiducials: slot detections, else legacy mark-id clicks', () => {
    const csv = buildFiducialObsCsv([
      { name: 'scan1.tif', fiducialDetections: [{ slot: 'corner-tl', px: 10.5, py: 20, source: 'template', confidence: 0.9 }],
        fiducialObs: [{ fidId: 'F1', px: 1, py: 2 }] },
      { name: 'scan2.tif', fiducialObs: [{ fidId: 'F3', px: 3, py: 4 }] },
    ])
    expect(detectFileKind(csv, 'x.csv').kind).toBe('fiducialObs')
    expect(parseFiducialObs(csv).rows).toEqual([
      { imageName: 'scan1.tif', fidId: 'corner-tl', px: 10.5, py: 20 },
      { imageName: 'scan2.tif', fidId: 'F3', px: 3, py: 4 },
    ])
  })

  it('camera fiducials: the calibration with its slots, else the certificate', () => {
    const csv = buildFiducialMarksCsv([
      { label: 'RC10', fiducialCalibration: {
        marks: [{ id: 'F1', xMm: -106, yMm: -106 }, { id: 'F2', xMm: 106, yMm: -106 }],
        slotMap: { 'corner-tl': 'F1', 'corner-tr': 'F2', 'corner-br': '' }, focalMm: 152.8, ppxMm: 0.01, ppyMm: -0.02 } },
      { label: 'RC20', fiducials: { marks: [{ id: '1', xMm: -110, yMm: 110 }], focalMm: 153.1, ppxMm: 0, ppyMm: 0 } },
    ])
    expect(detectFileKind(csv, 'x.csv').kind).toBe('fiducialMarks')
    const { groups } = parseFiducialMarks(csv)
    expect(groups.map((g) => g.sensor)).toEqual(['RC10', 'RC20'])
    expect(groups[0]).toMatchObject({ focalMm: 152.8, ppxMm: 0.01, ppyMm: -0.02 })
    expect(groups[0].marks).toEqual([
      { id: 'F1', xMm: -106, yMm: -106, slot: 'corner-tl' },
      { id: 'F2', xMm: 106, yMm: -106, slot: 'corner-tr' },
    ])
    expect(groups[1].marks).toEqual([{ id: '1', xMm: -110, yMm: 110, slot: null }])
  })
})
