// Turn normalized EXIF GPS metadata into a conservative camera-position record,
// then project it on request. Pure: persistence belongs to usePosesStore.

import { isGeographic, metresToCrsUnits, transform } from '../crs.js'
import { opkMatrix } from '../footprint.js'

export const EXIF_GPS_DEFAULT_HORIZONTAL_ACCURACY = 10 // metres
export const EXIF_GPS_DEFAULT_VERTICAL_ACCURACY = 20   // metres
export const EXIF_ORIENTATION_DEFAULT_ACCURACY = 5     // degrees

const finite = (v) => v != null && v !== '' && Number.isFinite(Number(v))

function matrixToOpk(R) {
  const phi = Math.asin(Math.max(-1, Math.min(1, R[0][2])))
  if (Math.abs(Math.cos(phi)) < 1e-9) return null
  const d = 180 / Math.PI
  return {
    omega: Math.atan2(-R[1][2], R[2][2]) * d,
    phi: phi * d,
    kappa: Math.atan2(-R[0][1], R[0][0]) * d,
  }
}

// Angle from local east to the projected CRS +X axis representation. EXIF/XMP
// drone attitudes are referenced to true north; BA and footprint OPK live in the
// project's grid axes. At a UTM edge these differ by meridian convergence, so a
// raw yaw must not be treated as grid kappa unchanged.
function localGridRotation(lon, lat, projectCrs) {
  if (isGeographic(projectCrs)) return { c: 1, s: 0 }
  const dLon = 1e-5 / Math.max(Math.abs(Math.cos(lat * Math.PI / 180)), 0.01)
  const west = transform([lon - dLon, lat], 'EPSG:4326', projectCrs)
  const east = transform([lon + dLon, lat], 'EPSG:4326', projectCrs)
  const dx = east[0] - west[0], dy = east[1] - west[1]
  const norm = Math.hypot(dx, dy)
  return norm > 0 && Number.isFinite(norm) ? { c: dx / norm, s: dy / norm } : { c: 1, s: 0 }
}

function orientationInProject(raw, grid) {
  if (![raw.omega, raw.phi, raw.kappa].every(Number.isFinite))
    return { omega: null, phi: null, kappa: null }
  const M = opkMatrix(raw.omega, raw.phi, raw.kappa)
  // Rotate each physical photo-axis direction from ENU components into project
  // grid components. The resulting rows remain an object→photo rotation matrix.
  const projected = M.map(([east, north, up]) => [
    grid.c * east - grid.s * north,
    grid.s * east + grid.c * north,
    up,
  ])
  return matrixToOpk(projected) ?? { omega: null, phi: null, kappa: null }
}

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
  const positive = (v) => finite(v) && Number(v) > 0 ? Number(v) : null
  const accuracyX = positive(meta.gpsAccuracyX) ?? declared ?? EXIF_GPS_DEFAULT_HORIZONTAL_ACCURACY
  const accuracyY = positive(meta.gpsAccuracyY) ?? declared ?? EXIF_GPS_DEFAULT_HORIZONTAL_ACCURACY
  const accuracyZ = positive(meta.gpsAccuracyZ) ?? EXIF_GPS_DEFAULT_VERTICAL_ACCURACY
  const hasOrientation = [meta.cameraOmega, meta.cameraPhi, meta.cameraKappa].every(finite)
  return {
    lon, lat, altitude,
    accuracyX, accuracyY, accuracyZ,
    accuracySource: declared || positive(meta.gpsAccuracyX) || positive(meta.gpsAccuracyY)
      || positive(meta.gpsAccuracyZ) ? 'exif' : 'default',
    verticalDatum: 'unknown',
    direction: finite(meta.gpsDirection) ? Number(meta.gpsDirection) : null,
    directionRef: meta.gpsDirectionRef ?? null,
    omega: hasOrientation ? Number(meta.cameraOmega) : null,
    phi: hasOrientation ? Number(meta.cameraPhi) : null,
    kappa: hasOrientation ? Number(meta.cameraKappa) : null,
    accuracyOmega: hasOrientation
      ? positive(meta.cameraAccuracyOmega) ?? EXIF_ORIENTATION_DEFAULT_ACCURACY : null,
    accuracyPhi: hasOrientation
      ? positive(meta.cameraAccuracyPhi) ?? EXIF_ORIENTATION_DEFAULT_ACCURACY : null,
    accuracyKappa: hasOrientation
      ? positive(meta.cameraAccuracyKappa) ?? EXIF_ORIENTATION_DEFAULT_ACCURACY : null,
    orientationSource: hasOrientation ? meta.cameraOrientationSource ?? 'exif' : null,
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
  const grid = localGridRotation(raw.lon, raw.lat, projectCrs)
  const orientation = orientationInProject(raw, grid)
  // Rotate an independent east/north covariance into grid X/Y, retaining its
  // diagonal because the current camera-prior API accepts per-axis sigmas.
  const accuracyGridX = Math.hypot(grid.c * raw.accuracyX, grid.s * raw.accuracyY)
  const accuracyGridY = Math.hypot(grid.s * raw.accuracyX, grid.c * raw.accuracyY)
  return {
    ...raw,
    ...orientation,
    x,
    y,
    z: raw.altitude == null ? null : metresToCrsUnits(raw.altitude, projectCrs),
    accuracyX: metresToCrsUnits(accuracyGridX, projectCrs),
    accuracyY: metresToCrsUnits(accuracyGridY, projectCrs),
    accuracyZ: metresToCrsUnits(raw.accuracyZ, projectCrs),
    altitudeMeters: raw.altitude,
    accuracyMetersX: accuracyGridX,
    accuracyMetersY: accuracyGridY,
    accuracyMetersZ: raw.accuracyZ,
    accuracyMetersEast: raw.accuracyX,
    accuracyMetersNorth: raw.accuracyY,
    accuracyMetersUp: raw.accuracyZ,
    omegaEnu: raw.omega,
    phiEnu: raw.phi,
    kappaEnu: raw.kappa,
  }
}
