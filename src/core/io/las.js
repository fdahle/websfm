// LAS point-cloud interop (ASPRS LAS 1.2/1.4), dependency-free and pure:
// bytes ↔ plain data, no DOM/Blob/store. The writer emits LAS 1.2 point format 2
// (xyz + intensity + RGB); the reader accepts formats 0–3 and 6–8 and reads only
// xyz (+ RGB when the format carries it). Everything is little-endian per spec.
//
// Byte-exactness rules (the interop bug source — see PLAN):
//   • On read, `headerSize` / `offsetToPointData` / `pointDataRecordLength` from
//     the header are authoritative — never assume a stride from the format id.
//   • Coordinates are stored quantized: i32 · scale + offset. The writer picks
//     offset = bbox min and scale = max(span/2³¹·1.01, 1e-4) per axis, so survey
//     coordinates keep ~mm precision; a round-trip is exact to the scale quantum.

import { geoKeysForEpsg } from '../products/geotiff.js'

const HEADER_SIZE_12 = 227
const VLR_HEADER_SIZE = 54

// Fixed-width ASCII field (zero-padded), for the sys-id / software / VLR strings.
function asciiField(dst, offset, text, width) {
  for (let i = 0; i < width && i < text.length; i++) dst[offset + i] = text.charCodeAt(i) & 0x7f
}

// ── Writer: cloud → LAS 1.2 (point format 2) ─────────────────────────────────
// `points` accepts the same dual input as cloudToPly: a sparse cloud's
// [{ x, y, z, color? }] or the flat dense shape { count, pos, col? }.
// opts: { crsCode?: number|null, geographic?: boolean, onLog? }. When an EPSG
// code is given, a GeoKeyDirectory VLR (LASF_Projection / 34735) is written;
// without one (local frame) no VLR is emitted. Returns a Uint8Array.
export function cloudToLas(points, { crsCode = null, geographic = false, onLog } = {}) {
  const flat = points && points.pos ? points : null
  const n = flat ? (flat.count ?? flat.pos.length / 3) : points.length
  const getX = flat ? (i) => flat.pos[i * 3] : (i) => points[i].x
  const getY = flat ? (i) => flat.pos[i * 3 + 1] : (i) => points[i].y
  const getZ = flat ? (i) => flat.pos[i * 3 + 2] : (i) => points[i].z
  const getC = flat
    ? (flat.col ? (i) => [flat.col[i * 3], flat.col[i * 3 + 1], flat.col[i * 3 + 2]] : () => null)
    : (i) => points[i].color

  // Real-world bbox (header min/max fields + quantization offsets).
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    const x = getX(i), y = getY(i), z = getZ(i)
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  if (!Number.isFinite(minX)) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0 }

  // Per-axis quantization: offset at bbox min so the i32 range starts at 0; scale
  // keeps the span inside i32 with margin while staying ≥ 0.1 mm (survey precision).
  const scaleFor = (span) => Math.max((span / 2 ** 31) * 1.01, 1e-4)
  const scale = [scaleFor(maxX - minX), scaleFor(maxY - minY), scaleFor(maxZ - minZ)]
  const offset = [minX, minY, minZ]
  onLog?.(`LAS export: ${n.toLocaleString()} points, scale [${scale.map((s) => s.toPrecision(3)).join(', ')}], `
    + `offset [${offset.map((o) => o.toPrecision(6)).join(', ')}]`
    + (crsCode ? `, EPSG:${crsCode} GeoKey VLR` : ', no CRS VLR (local frame)'), 'info', 'Export')

  // Optional CRS VLR: GeoKeyDirectory (record 34735) serialized as a u16 array
  // [1,1,0,nKeys, then 4 u16 per key] — same entries the GeoTIFF writer uses.
  let vlr = null
  if (crsCode) {
    const keys = geoKeysForEpsg(crsCode, geographic)
    const dir = [1, 1, 0, keys.length]
    for (const k of keys) dir.push(k[0], k[1], k[2], k[3])
    const body = new Uint8Array(dir.length * 2)
    const bv = new DataView(body.buffer)
    dir.forEach((v, i) => bv.setUint16(i * 2, v, true))
    vlr = body
  }
  const vlrBytes = vlr ? VLR_HEADER_SIZE + vlr.length : 0
  const offsetToPoints = HEADER_SIZE_12 + vlrBytes

  const RECORD = 26 // point format 2: xyz i32×3 + intensity u16 + 4 flag bytes + src u16 + RGB u16×3
  const out = new Uint8Array(offsetToPoints + n * RECORD)
  const dv = new DataView(out.buffer)

  // ── Public header block (LAS 1.2, 227 bytes) ──
  asciiField(out, 0, 'LASF', 4)
  // 4 fileSourceId u16 = 0, 6 globalEncoding u16 = 0, 8–23 GUID = 0 (already zeroed)
  out[24] = 1; out[25] = 2 // version 1.2
  asciiField(out, 26, 'websfm', 32) // system identifier
  asciiField(out, 58, 'websfm', 32) // generating software
  const now = new Date()
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000)
  dv.setUint16(90, dayOfYear, true)
  dv.setUint16(92, now.getFullYear(), true)
  dv.setUint16(94, HEADER_SIZE_12, true)     // header size
  dv.setUint32(96, offsetToPoints, true)     // offset to point data
  dv.setUint32(100, vlr ? 1 : 0, true)       // number of VLRs
  out[104] = 2                               // point data format 2
  dv.setUint16(105, RECORD, true)            // point data record length
  dv.setUint32(107, n, true)                 // legacy number of point records
  dv.setUint32(111, n, true)                 // points by return[0] (all first-return)
  dv.setFloat64(131, scale[0], true); dv.setFloat64(139, scale[1], true); dv.setFloat64(147, scale[2], true)
  dv.setFloat64(155, offset[0], true); dv.setFloat64(163, offset[1], true); dv.setFloat64(171, offset[2], true)
  dv.setFloat64(179, maxX, true); dv.setFloat64(187, minX, true)
  dv.setFloat64(195, maxY, true); dv.setFloat64(203, minY, true)
  dv.setFloat64(211, maxZ, true); dv.setFloat64(219, minZ, true)

  // ── VLR (GeoKeyDirectory) ──
  if (vlr) {
    const p = HEADER_SIZE_12
    // reserved u16 = 0
    asciiField(out, p + 2, 'LASF_Projection', 16)
    dv.setUint16(p + 18, 34735, true)          // record id: GeoKeyDirectory
    dv.setUint16(p + 20, vlr.length, true)     // record length after header
    asciiField(out, p + 22, 'GeoKeyDirectory', 32)
    out.set(vlr, p + VLR_HEADER_SIZE)
  }

  // ── Point records ──
  let p = offsetToPoints
  for (let i = 0; i < n; i++) {
    dv.setInt32(p, Math.round((getX(i) - offset[0]) / scale[0]), true)
    dv.setInt32(p + 4, Math.round((getY(i) - offset[1]) / scale[1]), true)
    dv.setInt32(p + 8, Math.round((getZ(i) - offset[2]) / scale[2]), true)
    // intensity u16 = 0 (12–13); return byte: 1 return, first (14)
    out[p + 14] = 0b0000_1001
    // classification (15), scan angle (16), user data (17), point source id (18–19) = 0
    const c = getC(i) || [200, 200, 200]
    dv.setUint16(p + 20, byte(c[0]) * 257, true) // 8-bit → 16-bit per spec
    dv.setUint16(p + 22, byte(c[1]) * 257, true)
    dv.setUint16(p + 24, byte(c[2]) * 257, true)
    p += RECORD
  }
  return out
}

const byte = (v) => Math.max(0, Math.min(255, Math.round(v ?? 0)))

// RGB byte offset within a point record, per point data format. Formats without
// an entry carry no RGB. (0/1/6: no RGB; 2: after xyz+intensity+flags; 3/5: after
// the f64 GPS time; 7/8: LAS 1.4 layout with a wider flag block + GPS time.)
const RGB_OFFSET = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }
const SUPPORTED_FORMATS = new Set([0, 1, 2, 3, 6, 7, 8])

// ── Reader: LAS bytes → flat cloud ───────────────────────────────────────────
// Supports LAS 1.x headers (1.2 and 1.4 layouts), point formats 0–3 and 6–8;
// reads xyz (+ RGB when present), skipping everything else via the header's
// record length. Rejects compressed LAZ with a clear error. Returns
// { count, pos: Float64Array(3N), col?: Uint8Array(3N) } — flat, never
// per-point objects (dense-scale invariant).
export function parseLas(buffer, { onLog } = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < HEADER_SIZE_12 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'LASF') {
    throw new Error('Not a LAS file (missing LASF signature)')
  }
  const versionMajor = bytes[24], versionMinor = bytes[25]
  const headerSize = dv.getUint16(94, true)
  const offsetToPoints = dv.getUint32(96, true)
  const nVlrs = dv.getUint32(100, true)
  const formatRaw = bytes[104]
  const recordLength = dv.getUint16(105, true)
  let count = dv.getUint32(107, true)
  // LAS 1.4: the legacy u32 count may be 0 with the real u64 count at offset 375.
  if (count === 0 && versionMinor >= 4 && headerSize >= 375) {
    const big = dv.getBigUint64(247, true)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('LAS point count exceeds safe integer range')
    count = Number(big)
  }

  // LAZ rejection: laszip sets the high bit of the point format, and writes a
  // "laszip encoded" VLR (record id 22204). Name the format in the error.
  let isLaz = (formatRaw & 0x80) !== 0
  let vp = headerSize
  for (let i = 0; i < nVlrs && vp + VLR_HEADER_SIZE <= offsetToPoints; i++) {
    const recordId = dv.getUint16(vp + 18, true)
    const len = dv.getUint16(vp + 20, true)
    if (recordId === 22204) isLaz = true
    vp += VLR_HEADER_SIZE + len
  }
  if (isLaz) {
    throw new Error('This file is LAZ (compressed LAS) — decompress it to .las first (e.g. with laszip or CloudCompare)')
  }

  const format = formatRaw & 0x3f
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new Error(`Unsupported LAS point data format ${format} (supported: 0–3, 6–8)`)
  }
  const rgbOff = RGB_OFFSET[format]
  const hasRgb = rgbOff != null && recordLength >= rgbOff + 6

  const scale = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)]
  const offset = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)]

  // The record count must fit the buffer; trust the smaller of header vs bytes.
  const avail = Math.floor((bytes.length - offsetToPoints) / recordLength)
  if (avail < count) {
    onLog?.(`LAS: header claims ${count} points but the file holds ${avail} — reading ${avail}`, 'warn', 'Import')
    count = Math.max(0, avail)
  }

  const pos = new Float64Array(count * 3)
  const col = hasRgb ? new Uint8Array(count * 3) : null
  let p = offsetToPoints
  for (let i = 0; i < count; i++) {
    pos[i * 3] = dv.getInt32(p, true) * scale[0] + offset[0]
    pos[i * 3 + 1] = dv.getInt32(p + 4, true) * scale[1] + offset[1]
    pos[i * 3 + 2] = dv.getInt32(p + 8, true) * scale[2] + offset[2]
    if (col) {
      col[i * 3] = dv.getUint16(p + rgbOff, true) >> 8
      col[i * 3 + 1] = dv.getUint16(p + rgbOff + 2, true) >> 8
      col[i * 3 + 2] = dv.getUint16(p + rgbOff + 4, true) >> 8
    }
    p += recordLength
  }
  onLog?.(`LAS: read ${count.toLocaleString()} points (v${versionMajor}.${versionMinor}, format ${format}`
    + `${hasRgb ? ', RGB' : ''})`, 'info', 'Import')
  return { count, pos, ...(col ? { col } : {}) }
}
