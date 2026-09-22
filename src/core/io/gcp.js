// Ground Control Point file parsing.
//
// GCP files are loosely-structured delimited text. A row carries a point name +
// its absolute position, and optionally an image observation (image name + pixel
// x/y). Multiple rows sharing a name describe one GCP seen in several images, so
// they collapse into a single GCP with a list of observations.
//
// This module is CRS-agnostic: it returns numbers in the file's own coordinates.
// The caller transforms them from the chosen source CRS into the project CRS.

const DELIMITERS = [
  { id: 'tab',       char: '\t', label: 'Tab' },
  { id: 'comma',     char: ',',  label: 'Comma' },
  { id: 'semicolon', char: ';',  label: 'Semicolon' },
  { id: 'space',     char: ' ',  label: 'Whitespace' },
]

export const DELIMITER_OPTIONS = DELIMITERS

// Elevation presence is about nullability, not truthiness: zero is a legitimate
// sea-level measurement and must never be treated as an empty placeholder.
export function hasGcpElevation(gcp) {
  return gcp?.z != null
}

// THE ground-control gate. Every place that lets a point constrain the solve —
// the georeference fit, its leave-one-control-out prediction, the GCP-anchored
// bundle adjust and the worker marshalling that feeds it — must ask this, and
// must not re-derive the rule from "has finite coordinates" or "is not a check".
//
// Why that matters (D4): a marker is a scale-bar endpoint with image marks and no
// surveyed position. Null coordinates are useful *representation*, not a safety
// boundary — a migrated, imported or accidentally edited marker with finite
// numbers on it would otherwise silently become ground control. The role is the
// boundary; the coordinates are only a necessary extra.
//
// `precision` is the caller's covariance check (core/gcpAccuracy.js
// `precisionFromGcp`); it lives there because it needs the accuracy model, so it
// is injected rather than imported (this module stays a leaf).
export function isGroundControl(gcp, { precision = () => true } = {}) {
  if (!gcp || gcp.enabled === false) return false
  if (normalizeGcpRole(gcp.role) !== 'control') return false
  if (!Number.isFinite(gcp.x) || !Number.isFinite(gcp.y) || !Number.isFinite(gcp.z)) return false
  return precision(gcp) != null && precision(gcp) !== false
}

// Strip comment (#) and blank lines.
function contentLines(text) {
  return text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() && !l.trimStart().startsWith('#'))
}

function splitRow(line, delimId) {
  if (delimId === 'space') return line.trim().split(/\s+/)
  const char = DELIMITERS.find((d) => d.id === delimId)?.char ?? ','
  return line.split(char).map((c) => c.trim())
}

// Pick the delimiter that yields the most columns on the first content line.
export function sniffDelimiter(text) {
  const lines = contentLines(text)
  if (!lines.length) return 'comma'
  let best = 'comma', bestCount = 0
  for (const d of DELIMITERS) {
    const n = splitRow(lines[0], d.id).length
    if (n > bestCount) { bestCount = n; best = d.id }
  }
  return best
}

// Parse into a rectangular grid of trimmed string cells.
export function parseRows(text, delimId) {
  return contentLines(text).map((l) => splitRow(l, delimId))
}

// ── Column-role guessing ──────────────────────────────────────────────────────

const PATTERNS = {
  name:  /^(name|id|label|gcp|point|pt)$/i,
  x:     /^(x|easting|east|e|lon|long|longitude)$/i,
  y:     /^(y|northing|north|n|lat|latitude)$/i,
  z:     /^(z|elev|elevation|alt|altitude|height|h)$/i,
  image: /^(image|img|photo|file|filename|picture)$/i,
  px:    /^(px|pixelx|pixel_x|imx|u|col|column)$/i,
  py:    /^(py|pixely|pixel_y|imy|v|row|line)$/i,
  role:  /^(role|type|usage|pointtype|point_type)$/i,
  accuracyX: /^(accuracyx|accuracy_x|accx|acc_x|sigmax|sigma_x|stdx|std_x)$/i,
  accuracyY: /^(accuracyy|accuracy_y|accy|acc_y|sigmay|sigma_y|stdy|std_y)$/i,
  accuracyZ: /^(accuracyz|accuracy_z|accz|acc_z|sigmaz|sigma_z|stdz|std_z)$/i,
  accuracyXY: /^(accuracyxy|accuracy_xy|horizontalaccuracy|horizontal_accuracy|hrms|cep|cep95|sigmah|sigma_h)$/i,
  accuracyImgX: /^(accuracyimgx|accuracy_img_x|imgaccx|img_acc_x|sigmau|sigma_u|pixelaccuracyx|pixel_accuracy_x)$/i,
  accuracyImgY: /^(accuracyimgy|accuracy_img_y|imgaccy|img_acc_y|sigmav|sigma_v|pixelaccuracyy|pixel_accuracy_y)$/i,
  correlationXY: /^(correlationxy|correlation_xy|corrxy|corr_xy|rhoxy|rho_xy)$/i,
  correlationXZ: /^(correlationxz|correlation_xz|corrxz|corr_xz|rhoxz|rho_xz)$/i,
  correlationYZ: /^(correlationyz|correlation_yz|corryz|corr_yz|rhoyz|rho_yz)$/i,
}

const ROLES = ['name', 'x', 'y', 'z', 'image', 'px', 'py', 'role', 'accuracyX', 'accuracyY', 'accuracyZ', 'accuracyXY',
  'accuracyImgX', 'accuracyImgY', 'correlationXY', 'correlationXZ', 'correlationYZ']

// Returns { name, x, y, z, image, px, py } mapping each role to a column index
// (or null). Uses header text when present, otherwise positional defaults.
export function guessMapping(headerCells, columnCount, hasHeader, { positional = true } = {}) {
  const mapping = {
    name: null, x: null, y: null, z: null, image: null, px: null, py: null, role: null,
    accuracyX: null, accuracyY: null, accuracyZ: null,
    accuracyXY: null,
    accuracyImgX: null, accuracyImgY: null,
    correlationXY: null, correlationXZ: null, correlationYZ: null,
  }

  if (hasHeader) {
    headerCells.forEach((cell, i) => {
      for (const role of ROLES) {
        if (mapping[role] == null && PATTERNS[role].test(cell)) { mapping[role] = i; break }
      }
    })
  }

  if (!positional) return mapping

  // Positional fallback for anything still unassigned.
  const used = new Set(Object.values(mapping).filter((v) => v != null))
  const freeAt = (i) => i < columnCount && !used.has(i)
  if (mapping.name == null && freeAt(0)) { mapping.name = 0; used.add(0) }
  if (mapping.x == null && freeAt(1)) { mapping.x = 1; used.add(1) }
  if (mapping.y == null && freeAt(2)) { mapping.y = 2; used.add(2) }
  if (mapping.z == null && freeAt(3)) { mapping.z = 3; used.add(3) }
  // Image observation columns only by header (don't guess positionally — risky).
  return mapping
}

export const ROLE_LABELS = {
  ignore: 'Ignore',
  name:  'Name / ID',
  x:     'Abs X',
  y:     'Abs Y',
  z:     'Abs Z',
  image: 'Image name',
  px:    'Pixel X',
  py:    'Pixel Y',
  role:  'Control / check / marker',
  accuracyX: 'X accuracy',
  accuracyY: 'Y accuracy',
  accuracyZ: 'Z accuracy',
  accuracyXY: 'Horizontal accuracy',
  accuracyImgX: 'Image X accuracy',
  accuracyImgY: 'Image Y accuracy',
  correlationXY: 'XY correlation',
  correlationXZ: 'XZ correlation',
  correlationYZ: 'YZ correlation',
}

// Three roles, and the difference between them is a *constraint* boundary, not a
// label — see D4 in docs/planning/plan-scale-and-measurement.md:
//   control — surveyed coordinates that constrain georeferencing / anchored BA
//   check   — surveyed coordinates deliberately withheld from the fit
//   marker  — image observations and NO surveyed coordinates: a scale-bar
//             endpoint. It must never reach a ground constraint, and that is
//             enforced by `role === 'control'` at every gate, never by "its
//             coordinates happen to be null".
// So this must ROUND-TRIP 'marker': collapsing an unknown value to 'control'
// would reload a marker from disk as a control point at whatever coordinates the
// table happens to hold.
export function normalizeGcpRole(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['check', 'checkpoint', 'checkpt', 'validation'].includes(s)) return 'check'
  if (['marker', 'scalemarker', 'scalebar'].includes(s)) return 'marker'
  return 'control'
}

// ── Build GCP objects ─────────────────────────────────────────────────────────

function num(cell) {
  if (cell == null || cell === '') return null
  const v = Number(cell)
  return Number.isFinite(v) ? v : null
}

function positiveNum(cell) {
  const value = num(cell)
  return value != null && value > 0 ? value : null
}

function correlationNum(cell) {
  const value = num(cell)
  return value != null && value > -1 && value < 1 ? value : null
}

// Build GCPs (in the file's own coordinates) from data rows + a role mapping.
// Rows sharing a name merge; the first row with coordinates sets the position,
// any row with image+pixel columns contributes an observation.
// Returns { gcps, skipped }.
export function buildGcps(dataRows, mapping) {
  const byName = new Map()
  let skipped = 0

  for (const row of dataRows) {
    const name = mapping.name != null ? row[mapping.name]?.trim() : ''
    if (!name) { skipped++; continue }

    let g = byName.get(name)
    if (!g) {
      g = {
        name, role: 'control', x: null, y: null, z: null,
        accuracyX: null, accuracyY: null, accuracyZ: null, observations: [],
        correlationXY: null, correlationXZ: null, correlationYZ: null,
      }
      byName.set(name, g)
    }

    const x = mapping.x != null ? num(row[mapping.x]) : null
    const y = mapping.y != null ? num(row[mapping.y]) : null
    const z = mapping.z != null ? num(row[mapping.z]) : null
    const accuracyX = mapping.accuracyX != null ? positiveNum(row[mapping.accuracyX]) : null
    const accuracyY = mapping.accuracyY != null ? positiveNum(row[mapping.accuracyY]) : null
    const accuracyZ = mapping.accuracyZ != null ? positiveNum(row[mapping.accuracyZ]) : null
    const accuracyXY = mapping.accuracyXY != null ? positiveNum(row[mapping.accuracyXY]) : null
    const correlationXY = mapping.correlationXY != null ? correlationNum(row[mapping.correlationXY]) : null
    const correlationXZ = mapping.correlationXZ != null ? correlationNum(row[mapping.correlationXZ]) : null
    const correlationYZ = mapping.correlationYZ != null ? correlationNum(row[mapping.correlationYZ]) : null
    const role = mapping.role != null ? normalizeGcpRole(row[mapping.role]) : 'control'
    if (g.x == null && x != null) g.x = x
    if (g.y == null && y != null) g.y = y
    if (g.z == null && z != null) g.z = z
    if (g.accuracyX == null && (accuracyX ?? accuracyXY) != null) g.accuracyX = accuracyX ?? accuracyXY
    if (g.accuracyY == null && (accuracyY ?? accuracyXY) != null) g.accuracyY = accuracyY ?? accuracyXY
    if (g.accuracyZ == null && accuracyZ != null) g.accuracyZ = accuracyZ
    if (g.correlationXY == null && correlationXY != null) g.correlationXY = correlationXY
    if (g.correlationXZ == null && correlationXZ != null) g.correlationXZ = correlationXZ
    if (g.correlationYZ == null && correlationYZ != null) g.correlationYZ = correlationYZ
    // A repeated point may have one role value per observation row. Check wins so
    // a mixed/partially-filled file can never accidentally use a checkpoint as control.
    // A non-control role wins so one 'check'/'marker' row is not diluted by the
    // plain rows around it; 'check' outranks 'marker' because it makes the
    // stronger claim (surveyed coordinates deliberately held back from the fit).
    if (role !== 'control' && (g.role === 'control' || role === 'check')) g.role = role

    if (mapping.image != null && mapping.px != null && mapping.py != null) {
      const imageName = row[mapping.image]?.trim()
      const px = num(row[mapping.px])
      const py = num(row[mapping.py])
      if (imageName && px != null && py != null) {
        g.observations.push({
          imageName, px, py,
          accuracyX: mapping.accuracyImgX != null ? positiveNum(row[mapping.accuracyImgX]) : null,
          accuracyY: mapping.accuracyImgY != null ? positiveNum(row[mapping.accuracyImgY]) : null,
        })
      }
    }
  }

  // Controls/checks require surveyed X/Y. Markers deliberately do not: their image
  // observations are scale-bar endpoints, and forcing coordinates here made the
  // advertised `marker` CSV role impossible to import.
  const gcps = []
  for (const g of byName.values()) {
    if (g.role === 'marker') {
      if (!g.observations.length) { skipped++; continue }
      g.x = null; g.y = null; g.z = null
      g.accuracyX = null; g.accuracyY = null; g.accuracyZ = null
      g.correlationXY = null; g.correlationXZ = null; g.correlationYZ = null
      gcps.push(g)
      continue
    }
    if (g.x == null || g.y == null) { skipped++; continue }
    gcps.push(g)
  }
  return { gcps, skipped }
}
