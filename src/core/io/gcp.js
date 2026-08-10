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
  role:  'Control / check',
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

export function normalizeGcpRole(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['check', 'checkpoint', 'checkpt', 'validation'].includes(s)) return 'check'
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
    if (role === 'check') g.role = 'check'

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

  // Keep only GCPs with a valid absolute X/Y position.
  const gcps = []
  for (const g of byName.values()) {
    if (g.x == null || g.y == null) { skipped++; continue }
    gcps.push(g)
  }
  return { gcps, skipped }
}
