import { describe, expect, it } from 'vitest'
import proj4 from 'proj4'
import { exifPoseFromMetadata, projectExifPose } from './exifPose.js'

describe('exifPoseFromMetadata', () => {
  it('normalizes a valid GPS position with conservative defaults', () => {
    expect(exifPoseFromMetadata({ gpsLat: -75, gpsLon: 10, gpsAlt: 120 })).toMatchObject({
      lat: -75, lon: 10, altitude: 120,
      accuracyX: 10, accuracyY: 10, accuracyZ: 20,
      accuracySource: 'default', verticalDatum: 'unknown',
    })
  })

  it('applies the below-sea-level altitude reference', () => {
    expect(exifPoseFromMetadata({ gpsLat: 1, gpsLon: 2, gpsAlt: 12, gpsAltRef: 1 }).altitude).toBe(-12)
  })

  it('keeps XY-only positions and rejects invalid coordinates', () => {
    expect(exifPoseFromMetadata({ gpsLat: 1, gpsLon: 2 }).altitude).toBeNull()
    expect(exifPoseFromMetadata({ gpsLat: 91, gpsLon: 2 })).toBeNull()
    expect(exifPoseFromMetadata({ gpsLat: null, gpsLon: 2 })).toBeNull()
  })

  it('uses declared horizontal positioning error', () => {
    expect(exifPoseFromMetadata({ gpsLat: 1, gpsLon: 2, gpsHorizontalAccuracy: 0.7 }))
      .toMatchObject({ accuracyX: 0.7, accuracyY: 0.7, accuracySource: 'exif' })
  })

  it('preserves per-axis GNSS accuracy and camera orientation', () => {
    expect(exifPoseFromMetadata({
      gpsLat: 1, gpsLon: 2, gpsAlt: 3,
      gpsAccuracyX: 0.02, gpsAccuracyY: 0.03, gpsAccuracyZ: 0.06,
      cameraOmega: 1, cameraPhi: 2, cameraKappa: 3,
      cameraAccuracyOmega: 0.2, cameraAccuracyPhi: 0.3, cameraAccuracyKappa: 0.4,
      cameraOrientationSource: 'xmp-gimbal',
    })).toMatchObject({
      accuracyX: 0.02, accuracyY: 0.03, accuracyZ: 0.06,
      omega: 1, phi: 2, kappa: 3,
      accuracyOmega: 0.2, accuracyPhi: 0.3, accuracyKappa: 0.4,
      accuracySource: 'exif', orientationSource: 'xmp-gimbal',
    })
  })

  it('requires a complete orientation and uses conservative angle defaults', () => {
    expect(exifPoseFromMetadata({
      gpsLat: 1, gpsLon: 2, cameraOmega: 1, cameraPhi: 2, cameraKappa: 3,
    })).toMatchObject({ accuracyOmega: 5, accuracyPhi: 5, accuracyKappa: 5 })
    expect(exifPoseFromMetadata({
      gpsLat: 1, gpsLon: 2, cameraOmega: 1, cameraPhi: 2,
    })).toMatchObject({ omega: null, phi: null, kappa: null })
  })
})

describe('projectExifPose', () => {
  it('projects XY and keeps metre-based altitude/accuracy coherent in a metre CRS', () => {
    const out = projectExifPose(exifPoseFromMetadata({
      gpsLat: 48, gpsLon: 9, gpsAlt: 120, gpsHorizontalAccuracy: 0.7,
    }), 'EPSG:32632')
    expect(out.x).toBeCloseTo(500000, 3)
    expect(out.z).toBe(120)
    expect(out.accuracyX).toBe(0.7)
    expect(out).toMatchObject({ altitudeMeters: 120, accuracyMetersX: 0.7, accuracyMetersZ: 20 })
  })

  it('converts altitude and accuracy into a feet-based project CRS', () => {
    proj4.defs('TEST:POSE_USFT', '+proj=tmerc +lat_0=0 +lon_0=9 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=us-ft +no_defs')
    const out = projectExifPose(exifPoseFromMetadata({
      gpsLat: 48, gpsLon: 9, gpsAlt: 30.48006096, gpsHorizontalAccuracy: 3.048006096,
    }), 'TEST:POSE_USFT')
    expect(out.z).toBeCloseTo(100, 6)
    expect(out.accuracyX).toBeCloseTo(10, 6)
    expect(out.accuracyZ).toBeCloseTo(65.6166667, 5)
  })

  it('rotates true-north orientation and anisotropic accuracy into the project grid', () => {
    const raw = exifPoseFromMetadata({
      gpsLat: 48, gpsLon: 12, gpsAlt: 120,
      gpsAccuracyX: 1, gpsAccuracyY: 4, gpsAccuracyZ: 2,
      cameraOmega: 0, cameraPhi: 0, cameraKappa: 0,
    })
    const out = projectExifPose(raw, 'EPSG:32632')
    expect(Math.abs(out.kappa)).toBeGreaterThan(1)
    expect(out.accuracyX).toBeGreaterThan(1)
    expect(out.accuracyY).toBeLessThan(4)
    expect(out).toMatchObject({
      accuracyMetersEast: 1, accuracyMetersNorth: 4, accuracyMetersUp: 2,
      omegaEnu: 0, phiEnu: 0, kappaEnu: 0,
    })
  })
})
