// XYZ / delimited-text point clouds: the lowest common denominator every tool
// reads. Pure text ↔ flat arrays; no per-point objects (dense-scale invariant).
// Both directions stream: the writer yields bounded string parts, the reader takes
// text line by line (whole, or as decoded byte chunks) into growable typed arrays,
// so a multi-GB .xyz never becomes one string.

import { MAX_BUFFER_BYTES } from '../bufferLimit.js'
import { flatAxes } from '../products/flatAxes.js'
import { sniffDelimiter, splitRow } from './gcp.js'
import { PART_CHARS, lineParts } from './parts.js'

// ── Writer: cloud → "x y z [r g b]" lines ────────────────────────────────────
// Same dual input as cloudToPlyParts / cloudToLasParts: sparse [{ x, y, z, color? }]
// or flat { count, pos, col? }. Colors are 0–255 integers. Yields string parts.
export function* cloudToXyzParts(points, { color = true, partChars = PART_CHARS } = {}) {
  const flat = points && points.pos ? points : null
  const n = flat ? (flat.count ?? flat.pos.length / 3) : points.length
  const [getX, getY, getZ] = flat ? flatAxes(flat) : [(i) => points[i].x, (i) => points[i].y, (i) => points[i].z]
  const getC = flat
    ? (flat.col ? (i) => [flat.col[i * 3], flat.col[i * 3 + 1], flat.col[i * 3 + 2]] : () => null)
    : (i) => points[i].color
  const withColor = color && (flat ? !!flat.col : n > 0 && !!points[0]?.color)
  // An empty cloud is a lone newline, as `lines.join('\n') + '\n'` always wrote.
  yield* lineParts('', n, (i) => {
    let s = `${getX(i)} ${getY(i)} ${getZ(i)}`
    if (withColor) {
      const c = getC(i) || [200, 200, 200]
      s += ` ${byte(c[0])} ${byte(c[1])} ${byte(c[2])}`
    }
    return s
  }, { emptyBody: '\n', partChars })
}

const byte = (v) => Math.max(0, Math.min(255, Math.round(v ?? 0)))

// ── Reader: delimited numeric text → flat cloud ──────────────────────────────
// Tolerates 3–7 columns: the first 3 numeric columns are x/y/z; when ≥6 columns
// exist the LAST 3 are taken as r/g/b (covers both "x y z r g b" and the common
// "x y z intensity r g b"). Color range is auto-detected: all values ≤ 1 → 0–1
// floats scaled ×255, else 0–255. Non-numeric rows (headers, comments) are
// skipped and counted. The delimiter is sniffed from the first content line (the
// GCP reader's rule). Returns { count, pos: Float64Array, col?, skipped,
// attributes?: { intensity } }.
export function parseXyzText(text, { onLog } = {}) {
  const parser = createXyzParser({ onLog })
  parser.push(text)
  return parser.finish()
}

// The same reader over an async iterable of byte chunks (a File read slice by
// slice): UTF-8 decoded in streaming mode, partial lines carried across chunks.
export async function parseXyzChunks(chunks, { onLog } = {}) {
  const parser = createXyzParser({ onLog })
  const dec = new TextDecoder()
  for await (const chunk of chunks) parser.push(dec.decode(chunk, { stream: true }))
  parser.push(dec.decode())
  return parser.finish()
}

// Incremental reader: push(text) any number of times, then finish().
export function createXyzParser({ onLog } = {}) {
  // Positions in full precision; colour (0–1, 0–255 or 0–65535) and intensity need no
  // more than Float32 — half the memory of the cloud's largest companions.
  const xs = growable(Float64Array), cols = growable(Float32Array), intensities = growable(Float32Array)
  let carry = '', delim = null, skipped = 0, colMax = 0, anyIntensity = false

  function row(raw) {
    const l = raw.trimEnd()
    if (!l.trim() || l.trimStart().startsWith('#')) return
    if (delim === null) delim = sniffDelimiter(l)
    const cells = splitRow(l, delim)
    const k = cells.length
    if (k < 3 || k > 7) { skipped++; return }
    const x = Number(cells[0]), y = Number(cells[1]), z = Number(cells[2])
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { skipped++; return }
    xs.push(x); xs.push(y); xs.push(z)
    if (k === 4 || k === 7) {
      const v = Number(cells[3])
      intensities.push(v)
      if (Number.isFinite(v)) anyIntensity = true
    } else intensities.push(NaN)
    if (k >= 6) {
      const r = Number(cells[k - 3]), g = Number(cells[k - 2]), b = Number(cells[k - 1])
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        cols.push(r); cols.push(g); cols.push(b)
        colMax = Math.max(colMax, r, g, b)
      } else {
        cols.push(200); cols.push(200); cols.push(200)
        colMax = Math.max(colMax, 200)
      }
    }
  }

  return {
    push(text) {
      const lines = (carry + text).split('\n')
      carry = lines.pop()
      for (const l of lines) row(l)
    },
    finish() {
      row(carry); carry = ''
      const count = xs.length / 3
      const pos = xs.take()
      // Only emit color when every point carried one (a partial column would misalign).
      let col
      if (count > 0 && cols.length === count * 3) {
        const scale01 = colMax <= 1.0001
        const raw = cols.view()
        col = new Uint8Array(count * 3)
        for (let i = 0; i < col.length; i++) col[i] = byte(scale01 ? raw[i] * 255 : raw[i])
      }
      onLog?.(`XYZ: read ${count.toLocaleString()} points`
        + `${col ? ` with color (${colMax <= 1.0001 ? '0–1' : '0–255'} range)` : ''}`
        + `${skipped ? `, skipped ${skipped} non-numeric row(s)` : ''}`, 'info', 'Import')
      return { count, pos, ...(col ? { col } : {}), skipped,
        ...(anyIntensity ? { attributes: { intensity: intensities.take() } } : {}) }
    },
  }
}

// A typed array that doubles as it fills; take() returns an exact-length copy. It never
// grows past the browser's buffer wall (core/bufferLimit.js): doubling a 1.1 GB buffer
// would ask for 2.2 GB although the data fits in less. Full at the wall, it throws the
// engine's own RangeError, which the import turns into its "too large" message.
export function growable(Type, initial = 1024) {
  const maxLength = Math.floor(MAX_BUFFER_BYTES / Type.BYTES_PER_ELEMENT)
  let buf = new Type(initial), len = 0
  return {
    push(v) {
      if (len === buf.length) {
        if (len >= maxLength) throw new RangeError('Array buffer allocation failed')
        const next = new Type(Math.min(buf.length * 2, maxLength)); next.set(buf); buf = next
      }
      buf[len++] = v
    },
    get length() { return len },
    view() { return buf.subarray(0, len) },
    take() { return buf.slice(0, len) },
  }
}
