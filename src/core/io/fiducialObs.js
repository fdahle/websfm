// Fiducial-mark pixel-observation file parsing (F4).
//
// Scanner software / prior tooling exports clicked fiducial positions as a
// delimited table: one row per (image, fiducial) with the scan-pixel x/y. This
// is distinct from a GCP file — a GCP row carries ground coordinates, a fiducial
// row carries only a mark id + pixel — so it routes to the images store, not the
// GCP importer.
//
// A second layout puts one image per row, with an x and a y column per mark position
// (`corner_top_left_x`, `midside_left_y`; core/io/fiducialColumns.js). Its rows are
// spread into the same per-mark rows, with the slot name as the mark id, so each
// mark keeps the slot its column names.
//
// CRS-agnostic (pixels are pixels): the caller matches rows to images by name and
// upserts each observation.

import { sniffDelimiter, parseRows } from './gcp.js'
import { fiducialColumns } from './fiducialColumns.js'
import { IMAGE_COLUMN, makeNameResolver } from './nameMatch.js'

const PATTERNS = {
  image:    IMAGE_COLUMN,
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

// The one-image-per-row layout: an image column plus x/y pixel columns for at least
// three mark positions (fewer cannot fix a scan's frame). Returns the image column
// and { slot: { x, y } }, or null.
export function wideFiducialLayout(headerCells) {
  const image = headerCells.findIndex((c) => PATTERNS.image.test(String(c ?? '').trim()))
  const columns = fiducialColumns(headerCells, 'px')
  return image !== -1 && Object.keys(columns).length >= 3 ? { image, columns } : null
}

// Parse into { rows: [{ imageName, fidId, px, py }], mapping, layout } where layout is
// 'long' (a row per mark) or 'wide' (a row per image). Marks whose pixel values
// aren't finite are dropped.
export function parseFiducialObs(text) {
  const grid = parseRows(text, sniffDelimiter(text))
  if (!grid.length) return { rows: [], mapping: null, layout: 'long' }
  const columnCount = grid.reduce((m, r) => Math.max(m, r.length), 0)
  const header = grid[0]
  const wide = wideFiducialLayout(header)
  if (wide) return { rows: parseWide(grid.slice(1), wide), mapping: null, layout: 'wide' }
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
  return { rows, mapping, layout: 'long' }
}

function parseWide(body, { image, columns }) {
  const num = (v) => (v === '' || v == null ? NaN : Number(v))
  const rows = []
  for (const cells of body) {
    const imageName = String(cells[image] ?? '').trim()
    if (!imageName) continue
    for (const [slot, { x, y }] of Object.entries(columns)) {
      const px = num(cells[x]), py = num(cells[y])
      if (Number.isFinite(px) && Number.isFinite(py)) rows.push({ imageName, fidId: slot, px, py })
    }
  }
  return rows
}

// Preview of an image-fiducial import: the parsed rows grouped by file name, each
// with the project image it matches (the importer's own name rule) and how many of
// its existing marks it would replace (a mark named by slot replaces that slot).
// Returns [{ fileName, imageId, imageName, marks: [{ fidId, px, py }], replaces }]
// in file order; imageId is null for a name the project lacks.
export function previewFiducialObs(rows, images) {
  const resolve = makeNameResolver(images)
  const byId = new Map(images.map((img) => [img.id, img]))
  const groups = new Map()
  for (const r of rows || []) {
    if (!groups.has(r.imageName)) {
      const img = byId.get(resolve(r.imageName)) ?? null
      groups.set(r.imageName, { fileName: r.imageName, imageId: img?.id ?? null, imageName: img?.name ?? null, marks: [], replaces: 0, img })
    }
    groups.get(r.imageName).marks.push({ fidId: r.fidId, px: r.px, py: r.py })
  }
  return [...groups.values()].map(({ img, ...g }) => {
    const existing = new Set((img?.fiducialDetections ?? []).map((d) => d.slot))
    return { ...g, replaces: g.marks.filter((m) => existing.has(m.fidId)).length }
  })
}
