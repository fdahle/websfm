// Sensor (shared camera intrinsics) parsing + EXIF grouping.
//
// A "sensor" is the calibration shared by many images: focal length, principal
// point, lens distortion, sensor/pixel size and the image dimensions it applies
// to. Several images normally share one sensor (same camera body + settings),
// but a project can contain more than one.
//
// This module is CRS-agnostic — intrinsics carry no geographic coordinates.
// Two entry points:
//   - parseRows/guessMapping/buildSensors: delimited-text import (one row = one
//     sensor), mirroring utils/gcp.js.
//   - exifSignature/sensorFromExif: derive/group sensors from image EXIF.

import { sniffDelimiter, parseRows } from './gcp.js'

export { sniffDelimiter, parseRows }

// ── Column-role guessing ──────────────────────────────────────────────────────

const PATTERNS = {
  label:     /^(label|name|id|sensor|camera|model)$/i,
  width:     /^(width|w|cols|columns|imgw|image_width|nx)$/i,
  height:    /^(height|h|rows|imgh|image_height|ny)$/i,
  focal:     /^(focal|f|focallength|focal_length|fl|focal_px|fpx)$/i,
  cx:        /^(cx|ppx|principal_x|c_x|u0|px)$/i,
  cy:        /^(cy|ppy|principal_y|c_y|v0|py)$/i,
  k1:        /^(k1|radial1)$/i,
  k2:        /^(k2|radial2)$/i,
  k3:        /^(k3|radial3)$/i,
  p1:        /^(p1|tangential1)$/i,
  p2:        /^(p2|tangential2)$/i,
  pixelSize: /^(pixelsize|pixel_size|pixel|psize|pitch|mm_per_px)$/i,
}

export const SENSOR_ROLES = ['label', 'width', 'height', 'focal', 'cx', 'cy', 'k1', 'k2', 'k3', 'p1', 'p2', 'pixelSize']

export const SENSOR_ROLE_LABELS = {
  ignore:    'Ignore',
  label:     'Label / ID',
  width:     'Width (px)',
  height:    'Height (px)',
  focal:     'Focal length',
  cx:        'Principal X',
  cy:        'Principal Y',
  k1:        'Distortion k1',
  k2:        'Distortion k2',
  k3:        'Distortion k3',
  p1:        'Distortion p1',
  p2:        'Distortion p2',
  pixelSize: 'Pixel size',
}

// Returns each role mapped to a column index (or null). Header text first, then
// a small positional fallback for label/width/height/focal.
export function guessMapping(headerCells, columnCount, hasHeader) {
  const mapping = Object.fromEntries(SENSOR_ROLES.map((r) => [r, null]))

  if (hasHeader) {
    headerCells.forEach((cell, i) => {
      for (const role of SENSOR_ROLES) {
        if (mapping[role] == null && PATTERNS[role].test(cell)) { mapping[role] = i; break }
      }
    })
  }

  const used = new Set(Object.values(mapping).filter((v) => v != null))
  const freeAt = (i) => i < columnCount && !used.has(i)
  if (mapping.label  == null && freeAt(0)) { mapping.label  = 0; used.add(0) }
  if (mapping.width  == null && freeAt(1)) { mapping.width  = 1; used.add(1) }
  if (mapping.height == null && freeAt(2)) { mapping.height = 2; used.add(2) }
  if (mapping.focal  == null && freeAt(3)) { mapping.focal  = 3; used.add(3) }
  return mapping
}

function num(cell) {
  if (cell == null || cell === '') return null
  const v = Number(cell)
  return Number.isFinite(v) ? v : null
}

// Build sensor objects (one per data row) from a role mapping.
// A row needs a label and at least one intrinsic value to be kept.
// Returns { sensors, skipped }.
export function buildSensors(dataRows, mapping) {
  const sensors = []
  let skipped = 0

  dataRows.forEach((row, ri) => {
    const label = mapping.label != null ? row[mapping.label]?.trim() : ''
    const s = {
      label: label || `Sensor ${ri + 1}`,
      width:  mapping.width  != null ? num(row[mapping.width])  : null,
      height: mapping.height != null ? num(row[mapping.height]) : null,
      focal:  mapping.focal  != null ? num(row[mapping.focal])  : null,
      cx:     mapping.cx     != null ? num(row[mapping.cx])     : null,
      cy:     mapping.cy     != null ? num(row[mapping.cy])     : null,
      k1:     mapping.k1     != null ? num(row[mapping.k1])     : null,
      k2:     mapping.k2     != null ? num(row[mapping.k2])     : null,
      k3:     mapping.k3     != null ? num(row[mapping.k3])     : null,
      p1:     mapping.p1     != null ? num(row[mapping.p1])     : null,
      p2:     mapping.p2     != null ? num(row[mapping.p2])     : null,
      pixelSize: mapping.pixelSize != null ? num(row[mapping.pixelSize]) : null,
    }
    const hasAny = ['width', 'height', 'focal', 'cx', 'cy', 'k1', 'k2', 'k3', 'p1', 'p2', 'pixelSize'].some((k) => s[k] != null)
    if (!hasAny) { skipped++; return }
    sensors.push(s)
  })

  return { sensors, skipped }
}

// ── EXIF-derived sensors ────────────────────────────────────────────────────────

// A stable key for "images that share the same physical camera + settings".
// Images with an identical signature collapse into one sensor automatically.
// Returns null when EXIF carries nothing usable (no auto-grouping then).
export function exifSignature(meta) {
  if (!meta) return null
  const parts = [
    meta.make || '',
    meta.model || '',
    meta.focalLength != null ? `f${meta.focalLength}` : '',
    meta.width != null && meta.height != null ? `${meta.width}x${meta.height}` : '',
  ]
  const sig = parts.filter(Boolean).join('|')
  return sig || null
}

// A human label for an EXIF-derived sensor.
export function exifLabel(meta) {
  const cam = [meta?.make, meta?.model].filter(Boolean).join(' ')
  const fl = meta?.focalLength != null ? `${meta.focalLength}mm` : null
  return [cam || 'Unknown camera', fl].filter(Boolean).join(' · ')
}

// Seed a sensor object from an image's EXIF. Focal length stays in millimetres
// (no pixel conversion without a known sensor/pixel size).
export function sensorFromExif(meta) {
  return {
    label:  exifLabel(meta),
    width:  meta?.width ?? null,
    height: meta?.height ?? null,
    focal:  meta?.focalLength ?? null,
    focalUnit: 'mm',
    cx: meta?.width != null ? meta.width / 2 : null,
    cy: meta?.height != null ? meta.height / 2 : null,
    k1: null, k2: null, k3: null, p1: null, p2: null,
    pixelSize: null,
  }
}
