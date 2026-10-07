import exifr from 'exifr'

const normalizedTag = (key) => String(key).replace(/[^a-z0-9]/gi, '').toLowerCase()

// XMP properties are grouped under their namespace by exifr (for example
// `drone-dji.GimbalYawDegree`). Search those small nested objects by tag name so
// the normalised metadata does not depend on the namespace prefix a vendor chose.
function metadataValue(root, names) {
  for (const name of names) {
    const wanted = normalizedTag(name)
    const seen = new Set()
    function visit(value) {
      if (!value || typeof value !== 'object' || seen.has(value)) return null
      seen.add(value)
      for (const [key, child] of Object.entries(value)) {
        if (normalizedTag(key) === wanted) {
          const scalar = child && typeof child === 'object' && 'value' in child ? child.value : child
          if (scalar != null && scalar !== '') return scalar
        }
      }
      for (const child of Object.values(value)) {
        const found = visit(child)
        if (found != null) return found
      }
      return null
    }
    const found = visit(root)
    if (found != null) return found
  }
  return null
}

function metadataNumber(root, names) {
  const value = metadataValue(root, names)
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const deg = (value) => value * Math.PI / 180
const angle = (value) => value * 180 / Math.PI

function opkFromMatrix(R) {
  const phi = Math.asin(Math.max(-1, Math.min(1, R[0][2])))
  if (Math.abs(Math.cos(phi)) < 1e-9) return null
  return {
    omega: angle(Math.atan2(-R[1][2], R[2][2])),
    phi: angle(phi),
    kappa: angle(Math.atan2(-R[0][1], R[0][0])),
  }
}

// DJI and compatible drone XMP describe the gimbal as yaw clockwise from north,
// pitch from the horizon (-90 = nadir), and roll around the viewing axis. Build
// the camera basis in local east/north/up, then recover WebSfM's object→photo OPK
// angles (0/0/0 = nadir, image top north). This also handles oblique captures and
// avoids the common but destructive mistake of treating DJI -90 pitch as phi=-90.
export function droneYprToOpk(yawDeg, pitchDeg, rollDeg) {
  if (![yawDeg, pitchDeg, rollDeg].every(Number.isFinite)) return null
  const yaw = deg(yawDeg), tilt = deg(pitchDeg + 90), roll = deg(rollDeg)
  const heading = [Math.sin(yaw), Math.cos(yaw), 0]
  const right = [Math.cos(yaw), -Math.sin(yaw), 0]
  const photoZ = [-heading[0] * Math.sin(tilt), -heading[1] * Math.sin(tilt), Math.cos(tilt)]
  const photoY = [heading[0] * Math.cos(tilt), heading[1] * Math.cos(tilt), Math.sin(tilt)]
  const cr = Math.cos(roll), sr = Math.sin(roll)
  const photoX = right.map((v, i) => cr * v - sr * photoY[i])
  const rolledY = right.map((v, i) => sr * v + cr * photoY[i])
  return opkFromMatrix([photoX, rolledY, photoZ])
}

export function normalizeExifMetadata(e = {}, dims = null, fileSize = null) {
  const horizontalAccuracy = metadataNumber(e, [
    'GPSHPositioningError', 'HorizontalPositioningError', 'GPSXYAccuracy',
  ])
  // Longitude/easting and latitude/northing standard deviations. DJI RTK XMP
  // uses RtkStdLon/RtkStdLat/RtkStdHgt; other vendors use the longer aliases.
  const accuracyX = metadataNumber(e, [
    'RtkStdLon', 'GPSLongitudeAccuracy', 'LongitudeAccuracy', 'PositionAccuracyX',
  ])
  const accuracyY = metadataNumber(e, [
    'RtkStdLat', 'GPSLatitudeAccuracy', 'LatitudeAccuracy', 'PositionAccuracyY',
  ])
  const accuracyZ = metadataNumber(e, [
    'RtkStdHgt', 'RtkStdHeight', 'GPSZAccuracy', 'GPSVerticalAccuracy',
    'GPSAltitudeAccuracy', 'VerticalPositioningError',
  ])

  // Explicit photogrammetric angles win. Otherwise consume the well-defined
  // DJI-style gimbal convention. FlightYaw/Pitch/Roll describe the airframe, not
  // necessarily the camera, so they are deliberately not used as camera priors.
  const explicitOmega = metadataNumber(e, ['CameraOmega', 'OmegaDegree'])
  const explicitPhi = metadataNumber(e, ['CameraPhi', 'PhiDegree'])
  const explicitKappa = metadataNumber(e, ['CameraKappa', 'KappaDegree'])
  const gimbalYaw = metadataNumber(e, [
    'GimbalYawDegree', 'GimbalYaw', 'GPSImgDirection',
  ])
  const gimbalPitch = metadataNumber(e, [
    'GimbalPitchDegree', 'GimbalPitch',
  ])
  const gimbalRoll = metadataNumber(e, [
    'GimbalRollDegree', 'GimbalRoll',
  ])
  const explicitOpk = [explicitOmega, explicitPhi, explicitKappa].every(Number.isFinite)
    ? { omega: explicitOmega, phi: explicitPhi, kappa: explicitKappa }
    : null
  const opk = explicitOpk ?? droneYprToOpk(gimbalYaw, gimbalPitch, gimbalRoll)

  return {
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    make: e.Make ?? null,
    model: e.Model ?? null,
    lens: e.LensModel ?? null,
    focalLength: e.FocalLength ?? null,
    focalLength35: e.FocalLengthIn35mmFormat ?? null,
    // Lets us derive the physical sensor width when the 35mm-equivalent focal is
    // absent: sensorWidth_mm = imageWidth_px / FocalPlaneXResolution × unit.
    focalPlaneXRes: e.FocalPlaneXResolution ?? null,
    focalPlaneResUnit: e.FocalPlaneResolutionUnit ?? null,
    fNumber: e.FNumber ?? null,
    exposureTime: e.ExposureTime ?? null,
    iso: e.ISO ?? null,
    orientation: e.Orientation ?? null,
    dateTime: e.DateTimeOriginal ?? e.CreateDate ?? null,
    gpsLat: e.latitude ?? metadataNumber(e, ['GPSLatitude']) ?? null,
    gpsLon: e.longitude ?? metadataNumber(e, ['GPSLongitude']) ?? null,
    gpsAlt: e.GPSAltitude ?? metadataNumber(e, ['AbsoluteAltitude']) ?? null,
    // exifr hands this byte back as a 1-element Uint8Array view (see below).
    gpsAltRef: scalarTag(e.GPSAltitudeRef),
    gpsHorizontalAccuracy: horizontalAccuracy,
    gpsAccuracyX: accuracyX,
    gpsAccuracyY: accuracyY,
    gpsAccuracyZ: accuracyZ,
    gpsDop: e.GPSDOP ?? null,
    gpsDirection: e.GPSImgDirection ?? null,
    gpsDirectionRef: e.GPSImgDirectionRef ?? null,
    cameraOmega: opk?.omega ?? null,
    cameraPhi: opk?.phi ?? null,
    cameraKappa: opk?.kappa ?? null,
    // Only accept accuracies already expressed on the OPK axes. Gimbal Y/P/R
    // uncertainties do not map axis-for-axis once the camera is oblique.
    cameraAccuracyOmega: metadataNumber(e, ['CameraOmegaAccuracy']),
    cameraAccuracyPhi: metadataNumber(e, ['CameraPhiAccuracy']),
    cameraAccuracyKappa: metadataNumber(e, ['CameraKappaAccuracy']),
    cameraOrientationSource: explicitOpk ? 'exif-opk' : (opk ? 'xmp-gimbal' : null),
    fileSize,
    // No `raw: e`. For a TIFF, exifr reads the WHOLE file into one buffer and returns
    // some tags (GPSAltitudeRef, OpcodeList3, …) as small typed-array views into it,
    // so keeping the parse result kept every imported original alive: ~23 MB per
    // MicaSense frame, 12.7 GB on a 538-image set, which the sparse memory preflight
    // then refused. Nothing read `raw`. Keep only plain values here.
  }
}

// A tag value as a plain scalar: exifr returns some single-value tags as typed-array
// views into the file buffer, which must not be retained.
function scalarTag(v) {
  if (v == null) return null
  if (ArrayBuffer.isView(v)) return v.length ? Number(v[0]) : null
  return v
}

function loadDimensions(url) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/**
 * Parse EXIF + basic dimensions for an image file.
 * Returns a flat, normalized metadata object (null fields when absent).
 * `presetDims` skips the `<img>`-based probe (used for a TIFF whose `url` isn't
 * browser-decodable yet — the caller reads dimensions from the TIFF header
 * instead, which doesn't need to wait for the full transcode).
 */
export async function extractMetadata(file, url, presetDims = null) {
  const [dims, exif] = await Promise.all([
    presetDims ? Promise.resolve(presetDims) : loadDimensions(url),
    // XMP carries drone gimbal attitude and vendor GNSS/RTK uncertainties; TIFF,
    // EXIF and GPS remain enabled by default and merge into the same output.
    exifr.parse(file, { xmp: true }).catch(() => null),
  ])
  const e = exif || {}
  return normalizeExifMetadata(e, dims, file.size)
}

const round = (n, d = 1) => Number(n.toFixed(d))

function formatExposure(t) {
  if (t == null) return null
  return t >= 1 ? `${round(t)} s` : `1/${Math.round(1 / t)} s`
}

function formatDate(d) {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  return Number.isNaN(date.getTime()) ? String(d) : date.toLocaleString()
}

export function formatFileSize(bytes) {
  if (bytes == null) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${round(bytes / 1024)} KB`
  return `${round(bytes / (1024 * 1024))} MB`
}

/**
 * Field definitions shared by the detail panel and the table.
 * `important: true` fields are highlighted in red when missing,
 * because they directly affect SfM reconstruction.
 */
export const FIELD_DEFS = [
  { key: 'dimensions', label: 'Dimensions', format: (m) => (m.width && m.height ? `${m.width} × ${m.height}` : null) },
  { key: 'fileSize', label: 'File size', format: (m) => formatFileSize(m.fileSize) },
  { key: 'make', label: 'Make', format: (m) => m.make },
  { key: 'model', label: 'Camera', format: (m) => m.model },
  { key: 'lens', label: 'Lens', format: (m) => m.lens },
  { key: 'focalLength', label: 'Focal length', important: true, format: (m) => (m.focalLength != null ? `${round(m.focalLength)} mm` : null) },
  { key: 'focalLength35', label: 'Focal (35mm eq.)', format: (m) => (m.focalLength35 != null ? `${m.focalLength35} mm` : null) },
  { key: 'fNumber', label: 'Aperture', format: (m) => (m.fNumber != null ? `f/${round(m.fNumber)}` : null) },
  { key: 'exposureTime', label: 'Exposure', format: (m) => formatExposure(m.exposureTime) },
  { key: 'iso', label: 'ISO', format: (m) => m.iso },
  { key: 'orientation', label: 'Orientation', format: (m) => m.orientation },
  { key: 'dateTime', label: 'Taken', format: (m) => formatDate(m.dateTime) },
  {
    key: 'gps',
    label: 'GPS',
    important: true,
    format: (m) => (m.gpsLat != null && m.gpsLon != null ? `${m.gpsLat.toFixed(6)}, ${m.gpsLon.toFixed(6)}` : null),
  },
]
