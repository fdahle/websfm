import { describe, expect, it } from 'vitest'
import { buildPosesCsv, buildSensorsCsv, buildFiducialObsCsv, buildFiducialMarksCsv } from './exportCsv.js'
import { sniffDelimiter, parseRows, guessMapping, buildSensors } from '../core/io/sensor.js'
import { parseFiducialObs } from '../core/io/fiducialObs.js'
import { parseFiducialMarks } from '../core/io/fiducialMarks.js'
import { detectFileKind } from '../core/io/importKind.js'

describe('buildPosesCsv', () => {
  it('exports per-axis position and orientation accuracies', () => {
    const csv = buildPosesCsv(
      [
        {
          imageName: 'survey.jpg',
          x: 1,
          y: 2,
          z: 3,
          omega: 4,
          phi: 5,
          kappa: 6,
          accuracyX: 0.01,
          accuracyY: 0.02,
          accuracyZ: 0.03,
          accuracyOmega: 0.1,
          accuracyPhi: 0.2,
          accuracyKappa: 0.3,
        },
      ],
      'EPSG:32632',
    )

    expect(csv).toBe(
      'image,X,Y,Z,omega,phi,kappa,accuracy_x,accuracy_y,accuracy_z,' +
        'accuracy_omega,accuracy_phi,accuracy_kappa,crs\r\n' +
        'survey.jpg,1,2,3,4,5,6,0.01,0.02,0.03,0.1,0.2,0.3,EPSG:32632\r\n',
    )
  })

  it('exports legacy scalar accuracies as axis fallbacks', () => {
    const csv = buildPosesCsv(
      [
        {
          imageName: 'legacy.jpg',
          x: 1,
          y: 2,
          z: 3,
          omega: null,
          phi: null,
          kappa: null,
          accXYZ: 5,
          accAngle: 2,
        },
      ],
      'EPSG:32632',
    )

    expect(csv).toContain('legacy.jpg,1,2,3,,,,5,5,5,2,2,2,EPSG:32632')
  })
})

describe('fiducial CSVs round-trip through their importers', () => {
  it('image fiducials: one row per slot detection', () => {
    const csv = buildFiducialObsCsv([
      {
        name: 'scan1.tif',
        fiducialDetections: [{ slot: 'corner-tl', px: 10.5, py: 20, source: 'template', confidence: 0.9 }],
      },
      { name: 'scan2.tif', fiducialDetections: [{ slot: 'side-left', px: 3, py: 4, source: 'manual', confidence: 1 }] },
      { name: 'scan3.tif' },
    ])
    expect(detectFileKind(csv, 'x.csv').kind).toBe('fiducialObs')
    expect(parseFiducialObs(csv).rows).toEqual([
      { imageName: 'scan1.tif', fidId: 'corner-tl', px: 10.5, py: 20 },
      { imageName: 'scan2.tif', fidId: 'side-left', px: 3, py: 4 },
    ])
  })

  it('camera fiducials: the marks, with slots where calibrated', () => {
    const csv = buildFiducialMarksCsv([
      {
        label: 'RC10',
        fiducialCalibration: {
          marks: [
            { id: 'F1', xMm: -106, yMm: -106 },
            { id: 'F2', xMm: 106, yMm: -106 },
          ],
          slotMap: { 'corner-tl': 'F1', 'corner-tr': 'F2', 'corner-br': '' },
          focalMm: 152.8,
          ppxMm: 0.01,
          ppyMm: -0.02,
        },
      },
      {
        label: 'RC20',
        fiducialCalibration: {
          marks: [{ id: '1', xMm: -110, yMm: 110 }],
          slotMap: {},
          focalMm: 153.1,
          ppxMm: 0,
          ppyMm: 0,
        },
      },
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

describe('export options', () => {
  const pose = { imageName: 'a b.jpg', x: 1, y: 2, z: 3, omega: 4, phi: 5, kappa: 6, accXYZ: 0.5, accAngle: 1 }

  it('drops the angle and accuracy columns that are turned off', () => {
    expect(buildPosesCsv([pose], 'EPSG:32632', { orientation: false })).toBe(
      'image,X,Y,Z,accuracy_x,accuracy_y,accuracy_z,crs\r\na b.jpg,1,2,3,0.5,0.5,0.5,EPSG:32632\r\n',
    )
    expect(buildPosesCsv([pose], '', { accuracy: false })).toBe(
      'image,X,Y,Z,omega,phi,kappa,crs\r\na b.jpg,1,2,3,4,5,6,\r\n',
    )
  })

  it('writes tab-separated text that sniffs back as tabs', () => {
    const txt = buildPosesCsv([{ ...pose, imageName: 'with\ttab.jpg' }], 'EPSG:32632', { delimiter: '\t' })
    expect(txt.split('\r\n')[0]).toBe(
      'image\tX\tY\tZ\tomega\tphi\tkappa\t' +
        'accuracy_x\taccuracy_y\taccuracy_z\taccuracy_omega\taccuracy_phi\taccuracy_kappa\tcrs',
    )
    expect(txt).toContain('"with\ttab.jpg"\t1\t2')
    expect(sniffDelimiter(txt)).toBe('tab')
  })

  it('writes an estimated calibration the sensor import reads back, per image', () => {
    const csv = buildSensorsCsv([
      {
        image: 'a.jpg',
        label: 'Body',
        width: 4000,
        height: 3000,
        focal: 3005.5,
        focalY: 3006,
        focalUnit: 'px',
        cx: 2001,
        cy: 1499,
        distortionModel: 'brown',
        k1: -0.1,
        source: 'estimated',
        cameras: 1,
        selfcalK1: 0.002,
      },
    ])
    const [header, ...rows] = parseRows(csv, sniffDelimiter(csv))
    expect(header.slice(0, 2)).toEqual(['image', 'label'])
    expect(header.slice(-5)).toEqual(['focal_y', 'cameras', 'selfcal_k1', 'selfcal_k2', 'selfcal_k3'])
    const mapping = guessMapping(header, header.length, true)
    expect(mapping.image).toBe(0)
    // The self-calibrated terms are not read as the lens's own k1.
    expect(header[mapping.k1]).toBe('k1')
    const { sensors } = buildSensors(rows, mapping)
    expect(sensors[0]).toMatchObject({ focal: 3005.5, cx: 2001, cy: 1499, k1: -0.1 })
  })
})
