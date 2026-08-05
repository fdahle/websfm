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
})
