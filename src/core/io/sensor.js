// Sensor (shared camera intrinsics) parsing + EXIF grouping.
//
// A "sensor" is the calibration shared by many images: focal length, principal
// point, lens distortion, sensor/pixel size and the image dimensions it applies
// to. Several images normally share one sensor (same camera body + settings),
// but a project can contain more than one.
//
// This module is CRS-agnostic — intrinsics carry no geographic coordinates.
// Two entry points:
//   - parseRows/guessMapping/buildSensors/planSensorImport: delimited-text import
//     (one row per sensor, or per image with an image column), mirroring gcp.js.
//   - exifSignature/sensorFromExif: derive/group sensors from image EXIF.

import { sniffDelimiter, parseRows } from './gcp.js'
import { IMAGE_COLUMN, makeNameResolver } from './nameMatch.js'
import { FIDUCIAL_POSITIONS, fiducialColumnPattern } from './fiducialColumns.js'
import { parseDistortionModelName } from '../sfm/distortion.js'

export { sniffDelimiter, parseRows }

// ── Column-role guessing ──────────────────────────────────────────────────────

const PATTERNS = {
  image: IMAGE_COLUMN,
  label: /^(label|name|id|sensor|camera|model|(sensor|camera)_?(label|name|id))$/i,
  width: /^(width|w|cols|columns|imgw|image_?width|width_?px|image_?width_?px|nx)$/i,
  height: /^(height|h|rows|imgh|image_?height|height_?px|image_?height_?px|ny)$/i,
  focal:
    /^(focal|f|focallength|focal_?length|fl|focal_?(px|mm)|focal_?length_?(px|mm)|fpx|calibrated_?focal(_?length)?(_?mm)?)$/i,
  cx: /^(cx|ppx|principal_x|c_x|u0|px|cx_?px|principal_?point_?x(_?px)?)$/i,
  cy: /^(cy|ppy|principal_y|c_y|v0|py|cy_?px|principal_?point_?y(_?px)?)$/i,
  ppxMm: /^(ppx_?mm|pp_?x_?mm|xp_?mm|cx_?mm|principal_?(point_?)?x_?mm)$/i,
  ppyMm: /^(ppy_?mm|pp_?y_?mm|yp_?mm|cy_?mm|principal_?(point_?)?y_?mm)$/i,
  k1: /^(k1|radial1)$/i,
  k2: /^(k2|radial2)$/i,
  k3: /^(k3|radial3)$/i,
  k4: /^(k4|radial4)$/i,
  k5: /^(k5|radial5)$/i,
  k6: /^(k6|radial6)$/i,
  // Text, not a number: the lens model by name (distortion.js parseDistortionModelName).
  distortionModel: /^(distortion_?model|lens_?model|camera_?model|projection(_?type)?|model_?type)$/i,
  p1: /^(p1|tangential1)$/i,
  p2: /^(p2|tangential2)$/i,
  pixelSize: /^(pixelsize|pixel|psize|pitch|mm_per_px|pixel_?(size|pitch)(_?mm)?|scan_?(pitch|resolution)_?mm)$/i,
}

// A film camera's certificate marks written as one row: an x and a y column in mm
// per mark position (`corner_top_left_x_mm`, …; core/io/fiducialColumns.js). Each
// column is its own role, keyed to the fiducial slot it names.
const fiducialRole = (slot, axis) => `fid:${slot}:${axis}`
for (const p of FIDUCIAL_POSITIONS) {
  for (const axis of ['x', 'y']) {
    PATTERNS[fiducialRole(p.slot, axis)] = fiducialColumnPattern(p, axis, 'mm')
  }
}
export const FIDUCIAL_ROLES = FIDUCIAL_POSITIONS.flatMap((p) => [fiducialRole(p.slot, 'x'), fiducialRole(p.slot, 'y')])

// `image` first: per-image rows (`image_id`) must not read as a sensor label (`id`).
export const SENSOR_ROLES = [
  'image',
  'label',
  'width',
  'height',
  'focal',
  'cx',
  'cy',
  'ppxMm',
  'ppyMm',
  'k1',
  'k2',
  'k3',
  'k4',
  'k5',
  'k6',
  'p1',
  'p2',
  'distortionModel',
  'pixelSize',
  ...FIDUCIAL_ROLES,
]

export const SENSOR_ROLE_LABELS = {
  ignore: 'Ignore',
  image: 'Image name',
  label: 'Label / ID',
  width: 'Width (px)',
  height: 'Height (px)',
  focal: 'Focal length',
  cx: 'Principal X (px)',
  cy: 'Principal Y (px)',
  ppxMm: 'Principal X (mm)',
  ppyMm: 'Principal Y (mm)',
  k1: 'Distortion k1',
  k2: 'Distortion k2',
  k3: 'Distortion k3',
  k4: 'Distortion k4',
  k5: 'Distortion k5',
  k6: 'Distortion k6',
  distortionModel: 'Lens model',
  p1: 'Distortion p1',
  p2: 'Distortion p2',
  pixelSize: 'Pixel size (mm)',
  ...Object.fromEntries(
    FIDUCIAL_POSITIONS.flatMap((p) =>
      ['x', 'y'].map((axis) => [fiducialRole(p.slot, axis), `Fiducial ${p.label} ${axis.toUpperCase()} (mm)`]),
    ),
  ),
}

// Returns each role mapped to a column index (or null). Header text when there is
// a header; only a headerless file falls back to position (label, width, height,
// focal) — with a header, an unrecognised column stays unassigned rather than
// becoming, say, the width because it happens to be the second column.
export function guessMapping(headerCells, columnCount, hasHeader, { positional = true } = {}) {
  const mapping = Object.fromEntries(SENSOR_ROLES.map((r) => [r, null]))

  if (hasHeader) {
    headerCells.forEach((cell, i) => {
      const text = String(cell ?? '').trim()
      for (const role of SENSOR_ROLES) {
        if (mapping[role] == null && PATTERNS[role].test(text)) {
          mapping[role] = i
          break
        }
      }
    })
    return mapping
  }

  if (!positional) return mapping

  const used = new Set(Object.values(mapping).filter((v) => v != null))
  const freeAt = (i) => i < columnCount && !used.has(i)
  if (mapping.label == null && freeAt(0)) {
    mapping.label = 0
    used.add(0)
  }
  if (mapping.width == null && freeAt(1)) {
    mapping.width = 1
    used.add(1)
  }
  if (mapping.height == null && freeAt(2)) {
    mapping.height = 2
    used.add(2)
  }
  if (mapping.focal == null && freeAt(3)) {
    mapping.focal = 3
    used.add(3)
  }
  return mapping
}

function num(cell) {
  if (cell == null || cell === '') return null
  const v = Number(cell)
  return Number.isFinite(v) ? v : null
}

const hasFiducialColumns = (mapping) => FIDUCIAL_ROLES.some((r) => mapping[r] != null)

// The unit of the focal column: its header says so (`focal_mm`, `fpx`), else film
// columns (marks or a principal point in mm) mean mm, else the values decide — a
// focal in pixels is rarely below a few hundred, one in mm rarely above (an aerial
// film camera is 88–610 mm, a drone 4–35 mm).
export function guessFocalUnit(headerCells, mapping, dataRows) {
  if (mapping.focal == null) return 'px'
  const head = String(headerCells?.[mapping.focal] ?? '').trim()
  if (/mm$/i.test(head)) return 'mm'
  if (/px$/i.test(head)) return 'px'
  if (hasFiducialColumns(mapping) || mapping.ppxMm != null || mapping.ppyMm != null) return 'mm'
  const values = dataRows
    .map((r) => num(r[mapping.focal]))
    .filter((v) => v > 0)
    .sort((a, b) => a - b)
  if (!values.length) return 'px'
  return values[Math.floor(values.length / 2)] < 400 ? 'mm' : 'px'
}

const VALUE_FIELDS = [
  'width',
  'height',
  'focal',
  'cx',
  'cy',
  'ppxMm',
  'ppyMm',
  'k1',
  'k2',
  'k3',
  'k4',
  'k5',
  'k6',
  'p1',
  'p2',
  'pixelSize',
]

// Build sensors from a role mapping. Without an image column every data row is one
// sensor. With one, rows are images: rows carrying the same values collapse into one
// sensor that lists their image names. A row needs at least one value to be kept.
// Returns { sensors, skipped }; each sensor is
//   { label: string | null (none in the file), images: string[] | null (no image
//     column), focalUnit, width … pixelSize (null when absent),
//     distortionModel: a model id named by a lens-model column, or null (the
//       store then infers one from the coefficients),
//     marks: [{ id, slot, xMm, yMm }] | null (certificate marks from the file) }.
export function buildSensors(dataRows, mapping, { focalUnit = 'px' } = {}) {
  const byKey = new Map()
  const sensors = []
  let skipped = 0
  const cell = (row, role) => (mapping[role] != null ? num(row[mapping[role]]) : null)

  for (const row of dataRows) {
    const values = Object.fromEntries(VALUE_FIELDS.map((k) => [k, cell(row, k)]))
    const marks = FIDUCIAL_POSITIONS.flatMap(({ slot }) => {
      const xMm = cell(row, fiducialRole(slot, 'x')),
        yMm = cell(row, fiducialRole(slot, 'y'))
      return xMm != null && yMm != null ? [{ id: slot, slot, xMm, yMm }] : []
    })
    if (!marks.length && VALUE_FIELDS.every((k) => values[k] == null)) {
      skipped++
      continue
    }
    const label = mapping.label != null ? String(row[mapping.label] ?? '').trim() || null : null
    const image = mapping.image != null ? String(row[mapping.image] ?? '').trim() : ''
    const distortionModel =
      mapping.distortionModel != null ? parseDistortionModelName(row[mapping.distortionModel]) : null

    const sensor = {
      label,
      images: mapping.image != null ? [] : null,
      focalUnit,
      ...values,
      distortionModel,
      marks: marks.length ? marks : null,
    }
    if (mapping.image == null) {
      sensors.push(sensor)
      continue
    }
    const key = JSON.stringify([label, values, distortionModel, marks])
    if (!byKey.has(key)) {
      byKey.set(key, sensor)
      sensors.push(sensor)
    }
    if (image) byKey.get(key).images.push(image)
  }

  return { sensors, skipped }
}

// ── Where imported sensors go ─────────────────────────────────────────────────

// Decide, per imported sensor, which project sensor it updates (`target`: a sensor
// id) or that it becomes a new one (`target: null`), and which images it names.
//   - a label in the file that matches a project sensor → that sensor;
//   - with an image column: the images' sensor, when they all share one and that
//     sensor has no other images (so a shared sensor is never edited for a subset);
//     otherwise a new sensor the images move to;
//   - without one: a lone row updates the project's only sensor (or the only one
//     any image uses); otherwise a new, unassigned sensor.
// `reason` says which rule fired: 'label' | 'images' | 'sole' | 'new'.
// Returns [{ target, reason, imageIds, unmatched }] in `parsed` order.
export function planSensorImport(parsed, sensors, images) {
  const resolve = makeNameResolver(images)
  const sensorOf = new Map(images.map((img) => [img.id, img.sensorId ?? null]))
  const imagesBySensor = new Map()
  for (const img of images) {
    if (!img.sensorId) continue
    if (!imagesBySensor.has(img.sensorId)) imagesBySensor.set(img.sensorId, [])
    imagesBySensor.get(img.sensorId).push(img.id)
  }
  const byLabel = new Map()
  for (const s of sensors) if (s.label && !byLabel.has(s.label.toLowerCase())) byLabel.set(s.label.toLowerCase(), s)
  const used = sensors.filter((s) => imagesBySensor.has(s.id))
  const sole = sensors.length === 1 ? sensors[0] : used.length === 1 ? used[0] : null

  return parsed.map((p) => {
    const ids = new Set(),
      unmatched = []
    for (const name of p.images ?? []) {
      const id = resolve(name)
      if (id == null) unmatched.push(name)
      else ids.add(id)
    }
    const imageIds = [...ids]
    const named = p.label ? byLabel.get(p.label.toLowerCase()) : null
    if (named) return { target: named.id, reason: 'label', imageIds, unmatched }
    if (p.images) {
      const current = new Set(imageIds.map((id) => sensorOf.get(id)).filter(Boolean))
      const only = current.size === 1 ? [...current][0] : null
      if (only && sensors.some((s) => s.id === only) && imagesBySensor.get(only).every((id) => ids.has(id))) {
        return { target: only, reason: 'images', imageIds, unmatched }
      }
      return { target: null, reason: 'new', imageIds, unmatched }
    }
    if (parsed.length === 1 && sole) return { target: sole.id, reason: 'sole', imageIds, unmatched }
    return { target: null, reason: 'new', imageIds, unmatched }
  })
}

// The images an imported sensor ends up with for a chosen target: the ones its rows
// name; without an image column, a lone new sensor also takes the images no sensor
// has yet (a project of scans without EXIF), and an update keeps the target's own.
export function sensorImportImageIds(planned, parsed, target, parsedCount, images) {
  if (parsed.images) return planned.imageIds
  if (target == null && parsedCount === 1) return images.filter((img) => !img.sensorId).map((img) => img.id)
  return []
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
    // Frames of one video share one camera, and only that camera: another video of
    // the same size may come from a different phone or zoom setting.
    meta.videoSource ? `video:${meta.videoSource}` : '',
  ]
  const sig = parts.filter(Boolean).join('|')
  return sig || null
}

// A human label for an EXIF-derived sensor.
export function exifLabel(meta) {
  const cam = [meta?.make, meta?.model].filter(Boolean).join(' ')
  const fl = meta?.focalLength != null ? `${meta.focalLength}mm` : null
  return [cam || (meta?.videoSource ? `Video ${meta.videoSource}` : 'Unknown camera'), fl].filter(Boolean).join(' · ')
}

// Seed a sensor object from an image's EXIF. Focal length stays in millimetres
// (no pixel conversion without a known sensor/pixel size).
export function sensorFromExif(meta) {
  return {
    label: exifLabel(meta),
    width: meta?.width ?? null,
    height: meta?.height ?? null,
    focal: meta?.focalLength ?? null,
    focalUnit: 'mm',
    cx: meta?.width != null ? meta.width / 2 : null,
    cy: meta?.height != null ? meta.height / 2 : null,
    k1: null,
    k2: null,
    k3: null,
    k4: null,
    k5: null,
    k6: null,
    p1: null,
    p2: null,
    pixelSize: null,
  }
}
