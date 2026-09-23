// XYZ / delimited-text point clouds: the lowest common denominator every tool
// reads. Pure text ↔ flat arrays; no per-point objects (dense-scale invariant).

import { sniffDelimiter, parseRows } from './gcp.js'

// ── Writer: cloud → "x y z [r g b]" lines ────────────────────────────────────
// Same dual input as cloudToPly / cloudToLas: sparse [{ x, y, z, color? }] or
// flat { count, pos, col? }. Colors are 0–255 integers.
export function cloudToXyz(points, { color = true } = {}) {
  const flat = points && points.pos ? points : null
  const n = flat ? (flat.count ?? flat.pos.length / 3) : points.length
  const getX = flat ? (i) => flat.pos[i * 3] : (i) => points[i].x
  const getY = flat ? (i) => flat.pos[i * 3 + 1] : (i) => points[i].y
  const getZ = flat ? (i) => flat.pos[i * 3 + 2] : (i) => points[i].z
  const getC = flat
    ? (flat.col ? (i) => [flat.col[i * 3], flat.col[i * 3 + 1], flat.col[i * 3 + 2]] : () => null)
    : (i) => points[i].color
  const withColor = color && (flat ? !!flat.col : n > 0 && !!points[0]?.color)
  const lines = new Array(n)
  for (let i = 0; i < n; i++) {
    let s = `${getX(i)} ${getY(i)} ${getZ(i)}`
    if (withColor) {
      const c = getC(i) || [200, 200, 200]
      s += ` ${byte(c[0])} ${byte(c[1])} ${byte(c[2])}`
    }
    lines[i] = s
  }
  return lines.join('\n') + '\n'
}

const byte = (v) => Math.max(0, Math.min(255, Math.round(v ?? 0)))

// ── Reader: delimited numeric text → flat cloud ──────────────────────────────
// Tolerates 3–7 columns: the first 3 numeric columns are x/y/z; when ≥6 columns
// exist the LAST 3 are taken as r/g/b (covers both "x y z r g b" and the common
// "x y z intensity r g b"). Color range is auto-detected: all values ≤ 1 → 0–1
// floats scaled ×255, else 0–255. Non-numeric rows (headers, comments) are
// skipped and counted. Returns { count, pos: Float64Array, col?, skipped }.
export function parseXyzText(text, { onLog } = {}) {
  const rows = parseRows(text, sniffDelimiter(text))
  const xs = [], cols = [], intensities = []
  let skipped = 0
  let colMax = 0
  for (const row of rows) {
    const nums = row.map(Number)
    if (row.length < 3 || row.length > 7 || nums.slice(0, 3).some((v) => !Number.isFinite(v))) {
      skipped++
      continue
    }
    xs.push(nums[0], nums[1], nums[2])
    if (row.length === 4 || row.length === 7) intensities.push(nums[3])
    else intensities.push(NaN)
    if (row.length >= 6) {
      const [r, g, b] = nums.slice(row.length - 3)
      if ([r, g, b].every(Number.isFinite)) {
        cols.push(r, g, b)
        colMax = Math.max(colMax, r, g, b)
      } else {
        cols.push(200, 200, 200)
        colMax = Math.max(colMax, 200)
      }
    }
  }
  const count = xs.length / 3
  const pos = Float64Array.from(xs)
  // Only emit color when every point carried one (a partial column would misalign).
  let col
  if (count > 0 && cols.length === count * 3) {
    const scale01 = colMax <= 1.0001
    col = new Uint8Array(count * 3)
    for (let i = 0; i < col.length; i++) col[i] = byte(scale01 ? cols[i] * 255 : cols[i])
  }
  onLog?.(`XYZ: read ${count.toLocaleString()} points`
    + `${col ? ` with color (${colMax <= 1.0001 ? '0–1' : '0–255'} range)` : ''}`
    + `${skipped ? `, skipped ${skipped} non-numeric row(s)` : ''}`, 'info', 'Import')
  return { count, pos, ...(col ? { col } : {}), skipped,
    ...(intensities.some(Number.isFinite) ? { attributes: { intensity: Float64Array.from(intensities) } } : {}) }
}
