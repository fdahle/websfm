// Camera pose (exterior orientation / extrinsics) parsing.
//
// A pose file is delimited text with one row per image: the image name, the
// camera-centre position (X/Y/Z) and the orientation as omega/phi/kappa angles
// (degrees). Optional per-row position and orientation accuracies act as
// bundle-adjustment priors.
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
  accuracyX: /^(accuracyx|accuracy_x|accx|acc_x|sigmax|sigma_x|stdx|std_x|xaccuracy|x_accuracy|posaccx|pos_acc_x)$/i,
  accuracyY: /^(accuracyy|accuracy_y|accy|acc_y|sigmay|sigma_y|stdy|std_y|yaccuracy|y_accuracy|posaccy|pos_acc_y)$/i,
  accuracyZ: /^(accuracyz|accuracy_z|accz|acc_z|sigmaz|sigma_z|stdz|std_z|zaccuracy|z_accuracy|posaccz|pos_acc_z)$/i,
  accAngle:/^(accangle|acc_angle|sangle|angacc|rotacc)$/i,
  accuracyOmega: /^(accuracyomega|accuracy_omega|accomega|acc_omega|sigmaomega|sigma_omega|stdomega|std_omega|omegaaccuracy|omega_accuracy|rollaccuracy|roll_accuracy)$/i,
  accuracyPhi: /^(accuracyphi|accuracy_phi|accphi|acc_phi|sigmaphi|sigma_phi|stdphi|std_phi|phiaccuracy|phi_accuracy|pitchaccuracy|pitch_accuracy)$/i,
  accuracyKappa: /^(accuracykappa|accuracy_kappa|acckappa|acc_kappa|sigmakappa|sigma_kappa|stdkappa|std_kappa|kappaaccuracy|kappa_accuracy|yawaccuracy|yaw_accuracy|headingaccuracy|heading_accuracy)$/i,
}

export const POSE_ROLES = [
  'image', 'x', 'y', 'z', 'omega', 'phi', 'kappa',
  'accuracyX', 'accuracyY', 'accuracyZ', 'accXYZ',
  'accuracyOmega', 'accuracyPhi', 'accuracyKappa', 'accAngle',
]

export const POSE_ROLE_LABELS = {
  ignore:   'Ignore',
  image:    'Image name',
  x:        'Abs X',
  y:        'Abs Y',
  z:        'Abs Z',
  omega:    'Omega (°)',
  phi:      'Phi (°)',
  kappa:    'Kappa (°)',
  accuracyX: 'X accuracy (σ)',
  accuracyY: 'Y accuracy (σ)',
  accuracyZ: 'Z accuracy (σ)',
  accXYZ:   'Position accuracy (all axes)',
  accuracyOmega: 'Omega accuracy (σ)',
  accuracyPhi:   'Phi accuracy (σ)',
  accuracyKappa: 'Kappa accuracy (σ)',
  accAngle: 'Angle accuracy (all axes)',
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
      accuracyX: mapping.accuracyX != null ? num(row[mapping.accuracyX]) : null,
      accuracyY: mapping.accuracyY != null ? num(row[mapping.accuracyY]) : null,
      accuracyZ: mapping.accuracyZ != null ? num(row[mapping.accuracyZ]) : null,
      accXYZ:   mapping.accXYZ   != null ? num(row[mapping.accXYZ])   : null,
      accuracyOmega: mapping.accuracyOmega != null ? num(row[mapping.accuracyOmega]) : null,
      accuracyPhi:   mapping.accuracyPhi   != null ? num(row[mapping.accuracyPhi])   : null,
      accuracyKappa: mapping.accuracyKappa != null ? num(row[mapping.accuracyKappa]) : null,
      accAngle: mapping.accAngle != null ? num(row[mapping.accAngle]) : null,
    })
  }

  return { poses: [...byImage.values()], skipped }
}
