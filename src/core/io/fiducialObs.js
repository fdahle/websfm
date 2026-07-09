// Fiducial-mark pixel-observation file parsing (F4).
//
// Scanner software / prior tooling exports clicked fiducial positions as a
// delimited table: one row per (image, fiducial) with the scan-pixel x/y. This
// is distinct from a GCP file — a GCP row carries ground coordinates, a fiducial
// row carries only a mark id + pixel — so it routes to the images store, not the
// GCP importer.
//
// CRS-agnostic (pixels are pixels): the caller matches rows to images by name and
// upserts each observation.

import { sniffDelimiter, parseRows } from './gcp.js'

const PATTERNS = {
  image:    /^(image|img|photo|file|filename|picture)$/i,
  fiducial: /^(fiducial|fid|fidid|fiducialid|mark|markid|corner)$/i,
  px:       /^(px|pixelx|pixel_x|imx|u|col|column|x)$/i,
  py:       /^(py|pixely|pixel_y|imy|v|row|line|y)$/i,
}
const ROLES = ['image', 'fiducial', 'px', 'py']

// Returns { image, fiducial, px, py } → column index (or null). Header-driven,
// with a positional fallback (image, fiducial, px, py) when `positional`.
export function guessMapping(headerCells, columnCount, hasHeader, { positional = true } = {}) {
  const mapping = { image: null, fiducial: null, px: null, py: null }
  if (hasHeader) {
    headerCells.forEach((cell, i) => {
      for (const role of ROLES) {
        if (mapping[role] == null && PATTERNS[role].test(String(cell ?? '').trim())) { mapping[role] = i; break }
      }
    })
  }
  if (!positional) return mapping
  const used = new Set(Object.values(mapping).filter((v) => v != null))
  const freeAt = (i) => i < columnCount && !used.has(i)
  if (mapping.image == null && freeAt(0)) { mapping.image = 0; used.add(0) }
  if (mapping.fiducial == null && freeAt(1)) { mapping.fiducial = 1; used.add(1) }
  if (mapping.px == null && freeAt(2)) { mapping.px = 2; used.add(2) }
  if (mapping.py == null && freeAt(3)) { mapping.py = 3; used.add(3) }
  return mapping
}

// True when the first row is a header (any cell matches a known role token and
// the pixel columns aren't numeric on that row).
function hasHeaderRow(firstRow) {
  const anyToken = firstRow.some((c) => ROLES.some((r) => PATTERNS[r].test(String(c ?? '').trim())))
  return anyToken
}

// Parse into { rows: [{ imageName, fidId, px, py }], mapping }. Rows whose pixel
// values aren't finite are dropped.
export function parseFiducialObs(text) {
  const grid = parseRows(text, sniffDelimiter(text))
  if (!grid.length) return { rows: [], mapping: null }
  const columnCount = grid.reduce((m, r) => Math.max(m, r.length), 0)
  const header = grid[0]
  const hasHeader = hasHeaderRow(header)
  const mapping = guessMapping(header, columnCount, hasHeader)
  const body = hasHeader ? grid.slice(1) : grid
  const rows = []
  // Empty cells coerce to 0 via Number(''), so treat blank pixel cells as missing.
  const num = (v) => (v === '' || v == null ? NaN : Number(v))
  for (const cells of body) {
    const px = num(cells[mapping.px])
    const py = num(cells[mapping.py])
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue
    const imageName = mapping.image != null ? String(cells[mapping.image] ?? '').trim() : ''
    const fidId = mapping.fiducial != null ? String(cells[mapping.fiducial] ?? '').trim() : ''
    if (!imageName || !fidId) continue
    rows.push({ imageName, fidId, px, py })
  }
  return { rows, mapping }
}
