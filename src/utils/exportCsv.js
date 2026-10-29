// Small CSV writers for camera parameters. Each builds a CSV string. Numbers keep
// full precision; empty/unknown fields are written as blank cells. `delimiter` ','
// writes CSV, '\t' tab-separated text; the imports sniff either (core/io/gcp.js
// sniffDelimiter).

function cell(v, delimiter = ',') {
  if (v == null || v === '') return ''
  // Only text fields are escaped: negative numeric coordinates remain numbers.
  // The apostrophe is intentional spreadsheet-safe text, including on reimport.
  const text = String(v)
  const s = typeof v === 'string' && /^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/.test(text) ? `'${text}` : text
  return /["\r\n]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(header, rows, delimiter = ',') {
  return [header, ...rows].map((r) => r.map((v) => cell(v, delimiter)).join(delimiter)).join('\r\n') + '\r\n'
}

// Camera poses (extrinsics) in `crs` (blank for a frame without one). Each pose
// already carries its own `imageName`, so no image lookup is needed. `orientation`
// and `accuracy` keep or drop the angle and accuracy columns.
export function buildPosesCsv(poses, crs, { orientation = true, accuracy = true, delimiter = ',' } = {}) {
  const angles = orientation ? ['omega', 'phi', 'kappa'] : []
  const accuracies = accuracy
    ? [
        'accuracy_x',
        'accuracy_y',
        'accuracy_z',
        ...(orientation ? ['accuracy_omega', 'accuracy_phi', 'accuracy_kappa'] : []),
      ]
    : []
  const header = ['image', 'X', 'Y', 'Z', ...angles, ...accuracies, 'crs']
  const rows = poses.map((p) => [
    p.imageName,
    p.x,
    p.y,
    p.z,
    ...(orientation ? [p.omega, p.phi, p.kappa] : []),
    ...(accuracy
      ? [
          p.accuracyX ?? p.accXYZ,
          p.accuracyY ?? p.accXYZ,
          p.accuracyZ ?? p.accXYZ,
          ...(orientation
            ? [p.accuracyOmega ?? p.accAngle, p.accuracyPhi ?? p.accAngle, p.accuracyKappa ?? p.accAngle]
            : []),
        ]
      : []),
    crs,
  ])
  return toCsv(header, rows, delimiter)
}

// Shared sensor intrinsics. Records from core/sfm/cameraEstimated.js
// estimatedCalibration (`source: 'estimated'`) add what bundle adjustment ended
// with: an `image` column when they are per image, then focal_y, the number of
// cameras and the self-calibrated radial terms (columns the import leaves alone).
export function buildSensorsCsv(sensors, { delimiter = ',' } = {}) {
  // `distortion_model` names which coefficients are live (and whether k1…k4 are
  // fisheye terms); core/io/sensor.js reads every column back.
  const header = [
    'label',
    'width',
    'height',
    'focal',
    'focal_unit',
    'cx',
    'cy',
    'distortion_model',
    'k1',
    'k2',
    'k3',
    'k4',
    'k5',
    'k6',
    'p1',
    'p2',
    'pixel_size',
    'source',
  ]
  const perImage = sensors.some((s) => s.image != null)
  const estimated = sensors.some((s) => s.source === 'estimated')
  const extra = estimated ? ['focal_y', 'cameras', 'selfcal_k1', 'selfcal_k2', 'selfcal_k3'] : []
  const rows = sensors.map((s) => [
    ...(perImage ? [s.image] : []),
    s.label,
    s.width,
    s.height,
    s.focal,
    s.focalUnit,
    s.cx,
    s.cy,
    s.distortionModel,
    s.k1,
    s.k2,
    s.k3,
    s.k4,
    s.k5,
    s.k6,
    s.p1,
    s.p2,
    s.pixelSize,
    s.source,
    ...(estimated ? [s.focalY, s.cameras, s.selfcalK1, s.selfcalK2, s.selfcalK3] : []),
  ])
  return toCsv([...(perImage ? ['image'] : []), ...header, ...extra], rows, delimiter)
}

// Image fiducials: one row per (image, mark) in scan pixels, readable back by
// core/io/fiducialObs.js: the image's slot detections.
export function buildFiducialObsCsv(images, { delimiter = ',' } = {}) {
  const header = ['image', 'fiducial', 'px', 'py', 'source', 'confidence']
  const rows = images.flatMap((img) =>
    (img.fiducialDetections || []).map((d) => [img.name, d.slot, d.px, d.py, d.source, d.confidence]),
  )
  return toCsv(header, rows, delimiter)
}

// Camera fiducials: one row per (film sensor, calibrated mark) in millimetres,
// readable back by core/io/fiducialMarks.js: the sensor's fiducial record, each
// mark with its raster slot once calibrated.
export function buildFiducialMarksCsv(sensors, { delimiter = ',' } = {}) {
  const header = ['sensor', 'fiducial', 'x_mm', 'y_mm', 'slot', 'focal_mm', 'ppx_mm', 'ppy_mm']
  const rows = sensors.flatMap((s) => {
    const cal = s.fiducialCalibration
    const slotOf = new Map(
      Object.entries(cal?.slotMap || {})
        .filter(([, id]) => id)
        .map(([slot, id]) => [id, slot]),
    )
    return (cal?.marks || []).map((m) => [
      s.label,
      m.id,
      m.xMm,
      m.yMm,
      slotOf.get(m.id),
      cal.focalMm,
      cal.ppxMm,
      cal.ppyMm,
    ])
  })
  return toCsv(header, rows, delimiter)
}
