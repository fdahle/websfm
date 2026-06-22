// Small CSV writers for camera parameters. Each builds a CSV string and triggers
// a browser download. Numbers keep full precision; empty/unknown fields are
// written as blank cells.

function cell(v) {
  if (v == null || v === '') return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
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
  URL.revokeObjectURL(url)
}

// Camera poses (extrinsics) in the project CRS. Each pose already carries its
// own `imageName`, so no image lookup is needed.
export function buildPosesCsv(poses, crs) {
  const header = ['image', 'X', 'Y', 'Z', 'omega', 'phi', 'kappa', 'acc_xyz', 'acc_angle', 'crs']
  const rows = poses.map((p) => [
    p.imageName, p.x, p.y, p.z, p.omega, p.phi, p.kappa, p.accXYZ, p.accAngle, crs,
  ])
  return toCsv(header, rows)
}

// Shared sensor intrinsics.
export function buildSensorsCsv(sensors) {
  const header = ['label', 'width', 'height', 'focal', 'focal_unit', 'cx', 'cy', 'k1', 'k2', 'k3', 'p1', 'p2', 'pixel_size', 'source']
  const rows = sensors.map((s) => [
    s.label, s.width, s.height, s.focal, s.focalUnit, s.cx, s.cy,
    s.k1, s.k2, s.k3, s.p1, s.p2, s.pixelSize, s.source,
  ])
  return toCsv(header, rows)
}
