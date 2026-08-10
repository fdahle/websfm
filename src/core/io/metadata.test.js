import { describe, expect, it } from 'vitest'
import { droneYprToOpk, normalizeExifMetadata } from './metadata.js'

describe('droneYprToOpk', () => {
  it('maps DJI nadir and heading into photogrammetric OPK', () => {
    expect(droneYprToOpk(0, -90, 0)).toMatchObject({ omega: -0, phi: 0, kappa: 0 })
    const east = droneYprToOpk(90, -90, 0)
    expect(east.omega).toBeCloseTo(0, 10)
    expect(east.phi).toBeCloseTo(0, 10)
    expect(east.kappa).toBeCloseTo(90, 10)
  })

  it('converts DJI pitch-from-horizon instead of passing -90 through', () => {
    const oblique = droneYprToOpk(0, -80, 0)
    expect(oblique.omega).toBeCloseTo(-10, 10)
    expect(oblique.phi).toBeCloseTo(0, 10)
    expect(oblique.kappa).toBeCloseTo(0, 10)
  })
})

describe('normalizeExifMetadata', () => {
  it('reads namespaced DJI gimbal and per-axis RTK metadata', () => {
    const out = normalizeExifMetadata({
      latitude: 48, longitude: 9, GPSAltitude: 120,
      'drone-dji': {
        GimbalYawDegree: '32.5', GimbalPitchDegree: '-90', GimbalRollDegree: '0',
        RtkStdLon: '0.018', RtkStdLat: '0.024', RtkStdHgt: '0.041',
      },
    }, { width: 4000, height: 3000 }, 1234)

    expect(out).toMatchObject({
      gpsLat: 48, gpsLon: 9, gpsAlt: 120,
      gpsAccuracyX: 0.018, gpsAccuracyY: 0.024, gpsAccuracyZ: 0.041,
      cameraOrientationSource: 'xmp-gimbal', width: 4000, height: 3000, fileSize: 1234,
    })
    expect(out.cameraOmega).toBeCloseTo(0, 10)
    expect(out.cameraPhi).toBeCloseTo(0, 10)
    expect(out.cameraKappa).toBeCloseTo(32.5, 10)
  })

  it('does not mistake airframe attitude for camera attitude', () => {
    const out = normalizeExifMetadata({
      latitude: 48, longitude: 9,
      'drone-dji': { FlightYawDegree: 20, FlightPitchDegree: 3, FlightRollDegree: 2 },
    })
    expect(out).toMatchObject({ cameraOmega: null, cameraPhi: null, cameraKappa: null })
  })

  it('accepts explicit photogrammetric angles without drone conversion', () => {
    const out = normalizeExifMetadata({
      custom: { CameraOmega: 1, CameraPhi: 2, CameraKappa: 3 },
    })
    expect(out).toMatchObject({
      cameraOmega: 1, cameraPhi: 2, cameraKappa: 3,
      cameraOrientationSource: 'exif-opk',
    })
  })
})
