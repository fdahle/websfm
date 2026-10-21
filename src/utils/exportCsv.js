// Small CSV writers for camera parameters. Each builds a CSV string and triggers
// a browser download. Numbers keep full precision; empty/unknown fields are
// written as blank cells.

function cell(v) {
  if (v == null || v === '') return ''
  // Only text fields are escaped: negative numeric coordinates remain numbers.
  // The apostrophe is intentional spreadsheet-safe text, including on reimport.
  const text = String(v)
  const s = typeof v === 'string' && /^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

export function downloadCsv(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Camera poses (extrinsics) in the project CRS. Each pose already carries its
// own `imageName`, so no image lookup is needed.
export function buildPosesCsv(poses, crs) {
  const header = [
    'image',
    'X',
    'Y',
    'Z',
    'omega',
    'phi',
    'kappa',
    'accuracy_x',
    'accuracy_y',
    'accuracy_z',
    'accuracy_omega',
    'accuracy_phi',
    'accuracy_kappa',
    'crs',
  ]
  const rows = poses.map((p) => [
    p.imageName,
    p.x,
    p.y,
    p.z,
    p.omega,
    p.phi,
    p.kappa,
    p.accuracyX ?? p.accXYZ,
    p.accuracyY ?? p.accXYZ,
    p.accuracyZ ?? p.accXYZ,
    p.accuracyOmega ?? p.accAngle,
    p.accuracyPhi ?? p.accAngle,
    p.accuracyKappa ?? p.accAngle,
    crs,
  ])
  return toCsv(header, rows)
}

// Shared sensor intrinsics.
export function buildSensorsCsv(sensors) {
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
  const rows = sensors.map((s) => [
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
  ])
  return toCsv(header, rows)
}

// Image fiducials: one row per (image, mark) in scan pixels, readable back by
// core/io/fiducialObs.js: the image's slot detections.
export function buildFiducialObsCsv(images) {
  const header = ['image', 'fiducial', 'px', 'py', 'source', 'confidence']
  const rows = images.flatMap((img) =>
    (img.fiducialDetections || []).map((d) => [img.name, d.slot, d.px, d.py, d.source, d.confidence]),
  )
  return toCsv(header, rows)
}

// Camera fiducials: one row per (film sensor, calibrated mark) in millimetres,
// readable back by core/io/fiducialMarks.js: the sensor's fiducial record, each
// mark with its raster slot once calibrated.
export function buildFiducialMarksCsv(sensors) {
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
  return toCsv(header, rows)
}
