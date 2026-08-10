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
// Point format 2: xyz i32×3 + intensity u16 + 4 flag bytes + src u16 + RGB u16×3.
export const LAS_RECORD_F2 = 26

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
  const vlrs = vlr
    ? [{ userId: 'LASF_Projection', recordId: 34735, description: 'GeoKeyDirectory', data: vlr }]
    : []

  // Point records, in the exact on-disk layout. Split out from the header so the
  // LAZ writer (core/io/laz.js) hands this same buffer to the compressor — one
  // definition of a point record, not two.
  const pointBytes = encodeLasPoints({ n, getX, getY, getZ, getC, scale, offset })
  const header = writeLasHeader({ n, vlrs, scale, offset, bbox: { minX, minY, minZ, maxX, maxY, maxZ } })
  const out = new Uint8Array(header.length + pointBytes.length)
  out.set(header, 0)
  out.set(pointBytes, header.length)
  return out
}

// Quantized point records for LAS point format 2. Returns n·26 bytes.
export function encodeLasPoints({ n, getX, getY, getZ, getC, scale, offset }) {
  const out = new Uint8Array(n * LAS_RECORD_F2)
  const dv = new DataView(out.buffer)
  let p = 0
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
    p += LAS_RECORD_F2
  }
  return out
}

// LAS 1.2 public header block + a VLR list. `compressed` sets the LASzip high bit
// on the point format — the ONLY header difference between a .las and a .laz, since
// the record length field keeps describing the *uncompressed* record either way.
export function writeLasHeader({ n, vlrs = [], scale, offset, bbox, compressed = false }) {
  const { minX, minY, minZ, maxX, maxY, maxZ } = bbox
  const vlrBytes = vlrs.reduce((sum, v) => sum + VLR_HEADER_SIZE + v.data.length, 0)
  const offsetToPoints = HEADER_SIZE_12 + vlrBytes
  const out = new Uint8Array(offsetToPoints)
  const dv = new DataView(out.buffer)

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
  dv.setUint32(100, vlrs.length, true)       // number of VLRs
  out[104] = compressed ? (2 | 0x80) : 2     // point data format 2 (high bit = LASzip)
  dv.setUint16(105, LAS_RECORD_F2, true)     // point data record length (uncompressed)
  dv.setUint32(107, n, true)                 // legacy number of point records
  dv.setUint32(111, n, true)                 // points by return[0] (all first-return)
  dv.setFloat64(131, scale[0], true); dv.setFloat64(139, scale[1], true); dv.setFloat64(147, scale[2], true)
  dv.setFloat64(155, offset[0], true); dv.setFloat64(163, offset[1], true); dv.setFloat64(171, offset[2], true)
  dv.setFloat64(179, maxX, true); dv.setFloat64(187, minX, true)
  dv.setFloat64(195, maxY, true); dv.setFloat64(203, minY, true)
  dv.setFloat64(211, maxZ, true); dv.setFloat64(219, minZ, true)

  let p = HEADER_SIZE_12
  for (const v of vlrs) {
    // reserved u16 = 0
    asciiField(out, p + 2, v.userId, 16)
    dv.setUint16(p + 18, v.recordId, true)
    dv.setUint16(p + 20, v.data.length, true)  // record length after header
    asciiField(out, p + 22, v.description ?? '', 32)
    out.set(v.data, p + VLR_HEADER_SIZE)
    p += VLR_HEADER_SIZE + v.data.length
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
  const h = readLasHeader(bytes)
  if (h.isLaz) {
    throw new Error('This file is LAZ (compressed LAS) — open it through the LAZ reader '
      + '(core/io/laz.js), which needs the lazcodec WASM module')
  }
  let count = h.count
  // The record count must fit the buffer; trust the smaller of header vs bytes.
  const avail = Math.floor((bytes.length - h.offsetToPoints) / h.recordLength)
  if (avail < count) {
    onLog?.(`LAS: header claims ${count} points but the file holds ${avail} — reading ${avail}`, 'warn', 'Import')
    count = Math.max(0, avail)
  }
  const cloud = decodeLasPoints(
    bytes.subarray(h.offsetToPoints), count, h.recordLength, h.format, h.scale, h.offset)
  onLog?.(`LAS: read ${count.toLocaleString()} points (v${h.versionMajor}.${h.versionMinor}, `
    + `format ${h.format}${cloud.col ? ', RGB' : ''})`, 'info', 'Import')
  return cloud
}

// Public header block + VLR directory. Shared with the LAZ reader, which needs the
// same fields plus the LASzip VLR payload. Every stride here is read from the
// header, never assumed from the format id (the interop rule at the top).
export function readLasHeader(bytes) {
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

  // laszip sets the high bit of the point format AND writes a "laszip encoded"
  // VLR (record id 22204); either one is enough to call the file compressed.
  let isLaz = (formatRaw & 0x80) !== 0
  const vlrs = []
  let vp = headerSize
  for (let i = 0; i < nVlrs && vp + VLR_HEADER_SIZE <= offsetToPoints; i++) {
    const recordId = dv.getUint16(vp + 18, true)
    const len = dv.getUint16(vp + 20, true)
    const userId = String.fromCharCode(...bytes.subarray(vp + 2, vp + 18)).replace(/\0+$/, '')
    if (recordId === 22204) isLaz = true
    vlrs.push({ userId, recordId, data: bytes.subarray(vp + VLR_HEADER_SIZE, vp + VLR_HEADER_SIZE + len) })
    vp += VLR_HEADER_SIZE + len
  }

  const format = formatRaw & 0x3f
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new Error(`Unsupported LAS point data format ${format} (supported: 0–3, 6–8)`)
  }
  return {
    versionMajor, versionMinor, headerSize, offsetToPoints, formatRaw, format, recordLength,
    count, isLaz, vlrs,
    scale: [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)],
    offset: [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)],
  }
}

// Decode raw point records (already uncompressed) → the flat cloud shape. Reads
// xyz (+ RGB when the format carries it) and skips the rest via `recordLength`.
export function decodeLasPoints(pointBytes, count, recordLength, format, scale, offset) {
  const dv = new DataView(pointBytes.buffer, pointBytes.byteOffset, pointBytes.byteLength)
  const rgbOff = RGB_OFFSET[format]
  const hasRgb = rgbOff != null && recordLength >= rgbOff + 6
  const pos = new Float64Array(count * 3)
  const col = hasRgb ? new Uint8Array(count * 3) : null
  let p = 0
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
  return { count, pos, ...(col ? { col } : {}) }
}
