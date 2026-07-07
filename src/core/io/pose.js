// Camera pose (exterior orientation / extrinsics) parsing.
//
// A pose file is delimited text with one row per image: the image name, the
// camera-centre position (X/Y/Z) and the orientation as omega/phi/kappa angles
// (degrees). Optional per-row accuracies act as bundle-adjustment priors.
//
// This module is CRS-agnostic: it returns numbers in the file's own
// coordinates. The caller transforms positions from the chosen source CRS into
// the project CRS (angles pass through unchanged).

import { sniffDelimiter, parseRows } from './gcp.js'

export { sniffDelimiter, parseRows }

// ── Column-role guessing ──────────────────────────────────────────────────────

const PATTERNS = {
  image:   /^(image|img|photo|file|filename|label|name|id|picture)$/i,
  x:       /^(x|easting|east|e|lon|long|longitude|xs|x_s|xc)$/i,
  y:       /^(y|northing|north|n|lat|latitude|ys|y_s|yc)$/i,
  z:       /^(z|elev|elevation|alt|altitude|height|h|zs|z_s|zc)$/i,
  omega:   /^(omega|om|roll|r|rx|rot_x)$/i,
  phi:     /^(phi|ph|pitch|p|ry|rot_y)$/i,
  kappa:   /^(kappa|ka|yaw|heading|k|rz|rot_z)$/i,
  accXYZ:  /^(acc|accuracy|acc_xyz|sigma|sxyz|posacc)$/i,
  accAngle:/^(accangle|acc_angle|sangle|angacc|rotacc)$/i,
}

export const POSE_ROLES = ['image', 'x', 'y', 'z', 'omega', 'phi', 'kappa', 'accXYZ', 'accAngle']

export const POSE_ROLE_LABELS = {
  ignore:   'Ignore',
  image:    'Image name',
  x:        'Abs X',
  y:        'Abs Y',
  z:        'Abs Z',
  omega:    'Omega (°)',
  phi:      'Phi (°)',
  kappa:    'Kappa (°)',
  accXYZ:   'Pos. accuracy',
  accAngle: 'Angle accuracy',
}

// Returns each role mapped to a column index (or null). Header text first, then
// a positional fallback for image/x/y/z/omega/phi/kappa.
export function guessMapping(headerCells, columnCount, hasHeader, { positional = true } = {}) {
  const mapping = Object.fromEntries(POSE_ROLES.map((r) => [r, null]))

  if (hasHeader) {
    headerCells.forEach((cell, i) => {
      for (const role of POSE_ROLES) {
        if (mapping[role] == null && PATTERNS[role].test(cell)) { mapping[role] = i; break }
      }
    })
  }

  if (!positional) return mapping

  const used = new Set(Object.values(mapping).filter((v) => v != null))
  const order = ['image', 'x', 'y', 'z', 'omega', 'phi', 'kappa']
  order.forEach((role, i) => {
    if (mapping[role] == null && i < columnCount && !used.has(i)) { mapping[role] = i; used.add(i) }
  })
  return mapping
}

function num(cell) {
  if (cell == null || cell === '') return null
  const v = Number(cell)
  return Number.isFinite(v) ? v : null
}

// Build pose objects (in the file's own coordinates) from data rows + a mapping.
// A row needs an image name and a valid X/Y position to be kept. Rows sharing an
// image name keep the last one (a later row overrides an earlier).
// Returns { poses, skipped }.
export function buildPoses(dataRows, mapping) {
  const byImage = new Map()
  let skipped = 0

  for (const row of dataRows) {
    const imageName = mapping.image != null ? row[mapping.image]?.trim() : ''
    const x = mapping.x != null ? num(row[mapping.x]) : null
    const y = mapping.y != null ? num(row[mapping.y]) : null
    if (!imageName || x == null || y == null) { skipped++; continue }

    byImage.set(imageName, {
      imageName,
      x, y,
      z:        mapping.z     != null ? num(row[mapping.z])     : null,
      omega:    mapping.omega != null ? num(row[mapping.omega]) : null,
      phi:      mapping.phi   != null ? num(row[mapping.phi])   : null,
      kappa:    mapping.kappa != null ? num(row[mapping.kappa]) : null,
      accXYZ:   mapping.accXYZ   != null ? num(row[mapping.accXYZ])   : null,
      accAngle: mapping.accAngle != null ? num(row[mapping.accAngle]) : null,
    })
  }

  return { poses: [...byImage.values()], skipped }
}
