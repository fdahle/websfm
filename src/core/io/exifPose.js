// Turn normalized EXIF GPS metadata into a conservative camera-position record,
// then project it on request. Pure: persistence belongs to usePosesStore.

import { metresToCrsUnits, transform } from '../crs.js'

export const EXIF_GPS_DEFAULT_HORIZONTAL_ACCURACY = 10 // metres
export const EXIF_GPS_DEFAULT_VERTICAL_ACCURACY = 20   // metres

const finite = (v) => v != null && v !== '' && Number.isFinite(Number(v))

export function exifPoseFromMetadata(meta = {}) {
  if (!finite(meta.gpsLat) || !finite(meta.gpsLon)) return null
  const lat = Number(meta.gpsLat), lon = Number(meta.gpsLon)
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null

  let altitude = finite(meta.gpsAlt) ? Number(meta.gpsAlt) : null
  // EXIF GPSAltitudeRef: 0 = above sea level, 1 = below. Some decoders already
  // return a negative number, so abs() makes the operation idempotent.
  if (altitude != null && Number(meta.gpsAltRef) === 1) altitude = -Math.abs(altitude)

  const declared = finite(meta.gpsHorizontalAccuracy) && Number(meta.gpsHorizontalAccuracy) > 0
    ? Number(meta.gpsHorizontalAccuracy) : null
  return {
    lon, lat, altitude,
    accuracyX: declared ?? EXIF_GPS_DEFAULT_HORIZONTAL_ACCURACY,
    accuracyY: declared ?? EXIF_GPS_DEFAULT_HORIZONTAL_ACCURACY,
    accuracyZ: EXIF_GPS_DEFAULT_VERTICAL_ACCURACY,
    accuracySource: declared ? 'exif' : 'default',
    verticalDatum: 'unknown',
    direction: finite(meta.gpsDirection) ? Number(meta.gpsDirection) : null,
    directionRef: meta.gpsDirectionRef ?? null,
  }
}

// Convert a normalized EXIF record into the project's horizontal CRS. EXIF
// altitude and positioning errors are physical metres; projected CRSs may use
// another linear unit (notably feet), while geographic projects deliberately
// retain metres only as canonical sidecars because their XY is angular.
export function projectExifPose(raw, projectCrs) {
  if (!raw) return null
  const [x, y] = transform([raw.lon, raw.lat], 'EPSG:4326', projectCrs)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return {
    ...raw,
    x,
    y,
    z: raw.altitude == null ? null : metresToCrsUnits(raw.altitude, projectCrs),
    accuracyX: metresToCrsUnits(raw.accuracyX, projectCrs),
    accuracyY: metresToCrsUnits(raw.accuracyY, projectCrs),
    accuracyZ: metresToCrsUnits(raw.accuracyZ, projectCrs),
    altitudeMeters: raw.altitude,
    accuracyMetersX: raw.accuracyX,
    accuracyMetersY: raw.accuracyY,
    accuracyMetersZ: raw.accuracyZ,
  }
}
