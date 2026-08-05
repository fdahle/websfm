import exifr from 'exifr'

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
    // Default parse merges TIFF/EXIF/GPS and adds computed latitude/longitude.
    exifr.parse(file).catch(() => null),
  ])
  const e = exif || {}
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
    gpsLat: e.latitude ?? null,
    gpsLon: e.longitude ?? null,
    gpsAlt: e.GPSAltitude ?? null,
    gpsAltRef: e.GPSAltitudeRef ?? null,
    gpsHorizontalAccuracy: e.GPSHPositioningError ?? e.HorizontalPositioningError ?? null,
    gpsDop: e.GPSDOP ?? null,
    gpsDirection: e.GPSImgDirection ?? null,
    gpsDirectionRef: e.GPSImgDirectionRef ?? null,
    fileSize: file.size,
    raw: e,
  }
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
