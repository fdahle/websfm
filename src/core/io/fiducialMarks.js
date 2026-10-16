// Camera fiducial-mark file parsing (F4): a film camera's calibration
// certificate as a delimited table, one row per mark with its calibrated
// position in millimetres. Distinct from fiducialObs.js, whose rows are scan
// pixels per *image*; these rows belong to a *sensor*.
//
// Columns (header-driven; the export in utils/exportCsv.js writes all of them):
//   sensor, fiducial, x_mm, y_mm, slot, focal_mm, ppx_mm, ppy_mm
// Only fiducial + x_mm + y_mm are required. A headerless file is read as
// `id, xMm, yMm` per line, the same as the sensor table's paste box.

import { sniffDelimiter, parseRows } from './gcp.js'

const PATTERNS = {
  sensor:   /^(sensor|camera|sensor_?label|camera_?label)$/i,
  fiducial: /^(fiducial|fid|fid_?id|fiducial_?id|mark|mark_?id|id)$/i,
  xMm:      /^(x_?mm|mark_?x_?mm|x)$/i,
  yMm:      /^(y_?mm|mark_?y_?mm|y)$/i,
  slot:     /^slot$/i,
  focalMm:  /^(focal_?mm|focal_?length_?mm|calibrated_?focal(_?mm)?)$/i,
  ppxMm:    /^(ppx_?mm|pp_?x_?mm|xp_?mm)$/i,
  ppyMm:    /^(ppy_?mm|pp_?y_?mm|yp_?mm)$/i,
}
const ROLES = Object.keys(PATTERNS)

// Returns each role → column index (or null). Header text only; the positional
// fallback (id, x, y) is applied by parseFiducialMarks for a headerless file.
export function guessMapping(headerCells) {
  const mapping = Object.fromEntries(ROLES.map((r) => [r, null]))
  headerCells.forEach((cell, i) => {
    const text = String(cell ?? '').trim()
    for (const role of ROLES) {
      if (mapping[role] == null && PATTERNS[role].test(text)) { mapping[role] = i; break }
    }
  })
  return mapping
}

// True when a header names the mark id and both mm coordinates.
export function looksLikeFiducialMarks(headerCells) {
  const m = guessMapping(headerCells)
  const mmHeader = headerCells.some((c) => /mm$/i.test(String(c ?? '').trim()))
  return m.fiducial != null && m.xMm != null && m.yMm != null && mmHeader
}

// Parse into { groups: [{ sensor, marks: [{ id, xMm, yMm, slot }], focalMm,
// ppxMm, ppyMm }] }, one group per sensor label in file order (`sensor` is ''
// when the file has no sensor column). Per-sensor scalars take the first finite
// value; a missing one is null. Rows with non-finite coordinates are dropped.
export function parseFiducialMarks(text) {
  const grid = parseRows(text, sniffDelimiter(text))
  if (!grid.length) return { groups: [] }
  const header = grid[0]
  const hasHeader = guessMapping(header).fiducial != null
  const mapping = hasHeader ? guessMapping(header) : { ...guessMapping([]), fiducial: 0, xMm: 1, yMm: 2 }
  const body = hasHeader ? grid.slice(1) : grid
  const num = (v) => (v === '' || v == null ? NaN : Number(v))
  const at = (cells, role) => (mapping[role] != null ? String(cells[mapping[role]] ?? '').trim() : '')
  const groups = new Map()
  for (const cells of body) {
    const xMm = num(at(cells, 'xMm')), yMm = num(at(cells, 'yMm'))
    if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) continue
    const sensor = at(cells, 'sensor')
    if (!groups.has(sensor)) groups.set(sensor, { sensor, marks: [], focalMm: null, ppxMm: null, ppyMm: null })
    const g = groups.get(sensor)
    g.marks.push({ id: at(cells, 'fiducial') || `F${g.marks.length + 1}`, xMm, yMm, slot: at(cells, 'slot') || null })
    for (const k of ['focalMm', 'ppxMm', 'ppyMm']) {
      const v = num(at(cells, k))
      if (g[k] == null && Number.isFinite(v)) g[k] = v
    }
  }
  return { groups: [...groups.values()] }
}

// The sensor's fiducial record after importing a group (sensor.fiducialCalibration):
//   - marks, focal and principal point come from the file, else the old record;
//   - every mark has a slot → that slot map;
//   - otherwise the old slot-map entries whose mark id survives (often none, so a
//     plain certificate leaves the sensor uncalibrated until Calibrate fiducials).
// Either way `fit` is cleared: the previous residuals no longer describe it.
export function applyFiducialMarks(sensor, group) {
  const marks = group.marks.map((m) => ({ id: m.id, xMm: m.xMm, yMm: m.yMm }))
  const old = sensor?.fiducialCalibration ?? null
  const pick = (k) => group[k] ?? old?.[k] ?? 0
  const ids = new Set(marks.map((m) => m.id))
  const slotted = group.marks.length > 0 && group.marks.every((m) => m.slot)
  const slotMap = slotted
    ? Object.fromEntries(group.marks.map((m) => [m.slot, m.id]))
    : Object.fromEntries(Object.entries(old?.slotMap || {}).filter(([, id]) => ids.has(id)))
  return {
    version: 1, method: 'certificate', transform: old?.transform ?? 'affine',
    allowReflection: old?.allowReflection ?? false, slotMap, marks,
    focalMm: pick('focalMm'), ppxMm: pick('ppxMm'), ppyMm: pick('ppyMm'),
    scanPitchMm: old?.scanPitchMm ?? null, fit: null,
  }
}

// The sensor each parsed group goes to (an id, or null when none fits): the sensor
// with the group's label (case-insensitive); a lone group with no matching label
// (or no sensor column) goes to the only film sensor, else the only sensor.
export function planFiducialMarkTargets(groups, sensors) {
  const list = groups || []
  const film = sensors.filter((s) => s.kind === 'film')
  const sole = film.length === 1 ? film[0] : sensors.length === 1 ? sensors[0] : null
  return list.map((g) => {
    const lc = g.sensor.toLowerCase()
    const s = (lc && sensors.find((x) => x.label.toLowerCase() === lc)) || (list.length === 1 ? sole : null)
    return s?.id ?? null
  })
}
