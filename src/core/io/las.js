// LAS point-cloud interop (ASPRS LAS 1.2/1.4), dependency-free and pure:
// bytes ↔ plain data, no DOM/Blob/store. The writer emits LAS 1.2 point format 2
// (xyz + intensity + RGB), or format 3 when the cloud carries a GPS time; the reader
// accepts formats 0–3 and 6–8 and reads xyz, RGB, the standard scalar fields and any
// "extra bytes" attributes. Everything is little-endian per spec.
//
// Point attributes (`cloud.attributes`, one typed array per name) are written in
// two ways. One named like a standard field our reader produces (intensity,
// classification, gpsTime, …) goes INTO that field when every value fits it
// losslessly; anything else — a computed `distance`, a PLY scalar, a class id > 31 —
// is written as an LAS 1.4 "extra bytes" field (VLR LASF_Spec/4, one 192-byte
// descriptor each, values appended to every point record). LAS 1.2 readers that
// know extra bytes (PDAL, CloudCompare, LAStools) read them; others skip them by
// the record length, which is what the header is for.
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
// Point format 3: format 2 with an f64 GPS time between the source id and RGB.
export const LAS_RECORD_F3 = 34

// Fixed-width ASCII field (zero-padded), for the sys-id / software / VLR strings.
function asciiField(dst, offset, text, width) {
  for (let i = 0; i < width && i < text.length; i++) dst[offset + i] = text.charCodeAt(i) & 0x7f
}

// ── Writer: cloud → LAS 1.2 (point format 2, or 3 with GPS time) ─────────────
// `points` accepts the same dual input as cloudToPly: a sparse cloud's
// [{ x, y, z, color? }] or the flat dense shape { count, pos, col? }.
// opts: { crsCode?: number|null, geographic?: boolean, attributes = true, onLog? }.
// When an EPSG code is given, a GeoKeyDirectory VLR (LASF_Projection / 34735) is
// written; without one (local frame) no CRS VLR is emitted. A flat cloud's
// `attributes` are written as described at the top (attributes:false skips them).
// Returns a Uint8Array.
export function cloudToLas(points, { crsCode = null, geographic = false, attributes = true, onLog } = {}) {
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
  const plan = planLasAttributes(attributes && flat ? flat.attributes : null, n, { onLog })
  if (plan.extra.length) vlrs.push(extraBytesVlr(plan.extra))

  // Point records, in the exact on-disk layout. Split out from the header so the
  // LAZ writer (core/io/laz.js) hands this same buffer to the compressor — one
  // definition of a point record, not two.
  const pointBytes = encodeLasPoints({ n, getX, getY, getZ, getC, scale, offset, ...plan })
  const header = writeLasHeader({ n, vlrs, scale, offset, bbox: { minX, minY, minZ, maxX, maxY, maxZ },
    format: plan.format, recordLength: plan.recordLength, pointsByReturn: pointsByReturn(plan.native, n) })
  const out = new Uint8Array(header.length + pointBytes.length)
  out.set(header, 0)
  out.set(pointBytes, header.length)
  return out
}

// Quantized point records for LAS point format 2 (26 bytes) or 3 (34: + GPS time),
// plus any extra bytes. `native` maps standard field names to typed arrays already
// checked to fit (planLasAttributes); `extra` is the extra-bytes field list. With
// neither, every point is "return 1 of 1, never classified", as before.
export function encodeLasPoints({ n, getX, getY, getZ, getC, scale, offset,
  format = 2, recordLength = LAS_RECORD_F2, native = {}, extra = [] }) {
  const out = new Uint8Array(n * recordLength)
  const dv = new DataView(out.buffer)
  const rgbOff = format === 3 ? 28 : 20
  const base = format === 3 ? LAS_RECORD_F3 : LAS_RECORD_F2
  const {
    intensity, returnNumber, numberOfReturns, scanDirection, edgeOfFlightLine,
    classification, synthetic, keyPoint, withheld, scanAngle, userData, pointSourceId, gpsTime,
  } = native
  const writers = extra.map((e) => [e.values, base + e.offset, EXTRA_SETTERS[e.dataType]])
  let p = 0
  for (let i = 0; i < n; i++) {
    dv.setInt32(p, Math.round((getX(i) - offset[0]) / scale[0]), true)
    dv.setInt32(p + 4, Math.round((getY(i) - offset[1]) / scale[1]), true)
    dv.setInt32(p + 8, Math.round((getZ(i) - offset[2]) / scale[2]), true)
    if (intensity) dv.setUint16(p + 12, intensity[i], true)
    // Return byte: return number (3 bits), number of returns (3), scan direction, edge.
    out[p + 14] = ((returnNumber ? returnNumber[i] : 1) & 7) | (((numberOfReturns ? numberOfReturns[i] : 1) & 7) << 3)
      | ((scanDirection ? scanDirection[i] & 1 : 0) << 6) | ((edgeOfFlightLine ? edgeOfFlightLine[i] & 1 : 0) << 7)
    // Classification byte: class (5 bits) + synthetic / key-point / withheld flags.
    out[p + 15] = ((classification ? classification[i] : 0) & 31) | ((synthetic ? synthetic[i] & 1 : 0) << 5)
      | ((keyPoint ? keyPoint[i] & 1 : 0) << 6) | ((withheld ? withheld[i] & 1 : 0) << 7)
    if (scanAngle) dv.setInt8(p + 16, scanAngle[i])
    if (userData) out[p + 17] = userData[i]
    if (pointSourceId) dv.setUint16(p + 18, pointSourceId[i], true)
    if (format === 3) dv.setFloat64(p + 20, gpsTime ? gpsTime[i] : 0, true)
    const c = getC(i) || [200, 200, 200]
    dv.setUint16(p + rgbOff, byte(c[0]) * 257, true) // 8-bit → 16-bit per spec
    dv.setUint16(p + rgbOff + 2, byte(c[1]) * 257, true)
    dv.setUint16(p + rgbOff + 4, byte(c[2]) * 257, true)
    for (const [values, at, set] of writers) set(dv, p + at, values[i])
    p += recordLength
  }
  return out
}

// LAS 1.2 public header block + a VLR list. `compressed` sets the LASzip high bit
// on the point format — the ONLY header difference between a .las and a .laz, since
// the record length field keeps describing the *uncompressed* record either way.
export function writeLasHeader({ n, vlrs = [], scale, offset, bbox, compressed = false,
  format = 2, recordLength = LAS_RECORD_F2, pointsByReturn = null }) {
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
  out[104] = compressed ? (format | 0x80) : format // point data format (high bit = LASzip)
  dv.setUint16(105, recordLength, true)      // point data record length (uncompressed)
  dv.setUint32(107, n, true)                 // legacy number of point records
  // Points by return 1–5 (all first-return unless the cloud carries return numbers).
  if (pointsByReturn) pointsByReturn.forEach((c, k) => dv.setUint32(111 + k * 4, c, true))
  else dv.setUint32(111, n, true)
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

// ── Point attributes ↔ LAS fields ────────────────────────────────────────────

// Standard point-format-2/3 fields, by the attribute name decodeLasPoints gives them,
// with the value range the field holds. An attribute goes into its field only when
// EVERY value is an integer in range (gpsTime: any finite number); otherwise it is
// written as extra bytes under its own name, unchanged. Silently clamping an
// imported class 40 to 8 would be worse than a field the reader has to look for.
const NATIVE_FIELDS = {
  intensity: [0, 65535], returnNumber: [0, 7], numberOfReturns: [0, 7],
  scanDirection: [0, 1], edgeOfFlightLine: [0, 1], classification: [0, 31],
  synthetic: [0, 1], keyPoint: [0, 1], withheld: [0, 1],
  // Format 0–5 store whole degrees in an int8 (spec range ±90).
  scanAngle: [-90, 90], userData: [0, 255], pointSourceId: [0, 65535],
  gpsTime: null,
}

// LAS 1.4 R15 extra-bytes data types (single values): id, byte size, DataView
// getter, and the typed array a reader hands back. 7/8 (u64/i64) read as doubles.
const EXTRA_TYPES = {
  1: [1, 'getUint8', Uint8Array], 2: [1, 'getInt8', Int8Array],
  3: [2, 'getUint16', Uint16Array], 4: [2, 'getInt16', Int16Array],
  5: [4, 'getUint32', Uint32Array], 6: [4, 'getInt32', Int32Array],
  7: [8, 'getBigUint64', Float64Array], 8: [8, 'getBigInt64', Float64Array],
  9: [4, 'getFloat32', Float32Array], 10: [8, 'getFloat64', Float64Array],
}
const EXTRA_TYPE_OF = {
  Uint8Array: 1, Int8Array: 2, Uint16Array: 3, Int16Array: 4,
  Uint32Array: 5, Int32Array: 6, Float32Array: 9, Float64Array: 10,
}
const EXTRA_SETTERS = {
  1: (dv, o, v) => dv.setUint8(o, v), 2: (dv, o, v) => dv.setInt8(o, v),
  3: (dv, o, v) => dv.setUint16(o, v, true), 4: (dv, o, v) => dv.setInt16(o, v, true),
  5: (dv, o, v) => dv.setUint32(o, v, true), 6: (dv, o, v) => dv.setInt32(o, v, true),
  9: (dv, o, v) => dv.setFloat32(o, v, true), 10: (dv, o, v) => dv.setFloat64(o, v, true),
}
export const EXTRA_BYTES_DESCRIPTOR_SIZE = 192
const EXTRA_NAME_BYTES = 32
const MAX_EXTRA_FIELDS = Math.floor(0xffff / EXTRA_BYTES_DESCRIPTOR_SIZE)

function fitsNative(values, n, range) {
  for (let i = 0; i < n; i++) {
    const v = values[i]
    if (range ? !(Number.isInteger(v) && v >= range[0] && v <= range[1]) : !Number.isFinite(v)) return false
  }
  return true
}

// ASCII, at most 32 bytes, unique within the file (a truncated name may collide).
function extraName(name, used) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_')
  let out = ascii.slice(0, EXTRA_NAME_BYTES) || 'attribute'
  for (let k = 2; used.has(out); k++) out = `${ascii.slice(0, EXTRA_NAME_BYTES - String(k).length - 1)}_${k}`
  used.add(out)
  return out
}

/**
 * Decide where each attribute goes in a LAS record. Returns
 * `{ format, recordLength, native: { field: values }, extra: [{ name, source, values,
 *   dataType, size, offset }], dropped: [names] }` — `offset` is from the end of the
 * standard record. Format 3 is chosen exactly when a GPS time fits natively.
 * opts.extraBytes:false (the LAZ codec cannot carry them) lists the rest as dropped.
 */
export function planLasAttributes(attributes, n, { extraBytes = true, onLog } = {}) {
  const native = {}, extra = [], dropped = []
  const used = new Set()
  let offset = 0
  for (const [name, values] of Object.entries(attributes || {})) {
    if (!values || !(values.length >= n)) { dropped.push(name); continue }
    if (Object.hasOwn(NATIVE_FIELDS, name) && fitsNative(values, n, NATIVE_FIELDS[name])) {
      native[name] = values
      continue
    }
    const dataType = EXTRA_TYPE_OF[values.constructor?.name]
    // A VLR payload is at most 65535 bytes: 341 descriptors.
    if (!extraBytes || !dataType || extra.length >= MAX_EXTRA_FIELDS) { dropped.push(name); continue }
    const size = EXTRA_TYPES[dataType][0]
    extra.push({ name: extraName(name, used), source: name, values, dataType, size, offset })
    offset += size
  }
  const format = native.gpsTime ? 3 : 2
  const recordLength = (format === 3 ? LAS_RECORD_F3 : LAS_RECORD_F2) + offset
  if (Object.keys(native).length || extra.length || dropped.length) {
    onLog?.(`LAS attributes: point format ${format}, ${recordLength}-byte records`
      + (Object.keys(native).length ? `; in standard fields: ${Object.keys(native).join(', ')}` : '')
      + (extra.length ? `; as extra bytes: ${extra.map((e) => e.name).join(', ')}` : '')
      + (dropped.length ? `; not written: ${dropped.join(', ')}` : ''), dropped.length ? 'warn' : 'info', 'Export')
  }
  return { format, recordLength, native, extra, dropped }
}

// Header "points by return" (returns 1–5) from a native returnNumber, else null.
export function pointsByReturn(native, n) {
  const rn = native.returnNumber
  if (!rn) return null
  const counts = [0, 0, 0, 0, 0]
  for (let i = 0; i < n; i++) if (rn[i] >= 1 && rn[i] <= 5) counts[rn[i] - 1]++
  return counts
}

/**
 * The extra-bytes VLR (user id "LASF_Spec", record 4): one 192-byte descriptor per
 * field (LAS 1.4 R15 §2.6) — reserved u16, data_type u8, options u8 (0: no no-data,
 * min/max, scale or offset), name char[32], then unused/no_data/min/max/scale/offset
 * slots left zero, description char[32] at byte 160.
 */
export function extraBytesVlr(extra) {
  const data = new Uint8Array(extra.length * EXTRA_BYTES_DESCRIPTOR_SIZE)
  extra.forEach((e, k) => {
    const o = k * EXTRA_BYTES_DESCRIPTOR_SIZE
    data[o + 2] = e.dataType
    asciiField(data, o + 4, e.name, EXTRA_NAME_BYTES)
    asciiField(data, o + 160, `websfm ${e.source}`, 32)
  })
  return { userId: 'LASF_Spec', recordId: 4, description: 'Extra bytes', data }
}

// Parse an extra-bytes VLR into [{ name, dataType, size, offset, scale, add }] with
// `offset` from the end of the standard record. Undocumented bytes (type 0, size in
// `options`) and the deprecated array types (11–30) only advance the offset; a
// malformed descriptor ends the list rather than guessing a layout past it.
export function parseExtraBytes(vlrs = []) {
  const v = vlrs.find((r) => r.userId === 'LASF_Spec' && r.recordId === 4)
  if (!v) return []
  const out = []
  const dv = new DataView(v.data.buffer, v.data.byteOffset, v.data.byteLength)
  let offset = 0
  for (let o = 0; o + EXTRA_BYTES_DESCRIPTOR_SIZE <= v.data.length; o += EXTRA_BYTES_DESCRIPTOR_SIZE) {
    const type = v.data[o + 2], options = v.data[o + 3]
    if (type === 0) { offset += options; continue }
    if (type > 30) break
    const single = type <= 10
    const base = EXTRA_TYPES[((type - 1) % 10) + 1]
    const size = base[0] * (single ? 1 : Math.floor((type - 1) / 10) + 1)
    if (single) {
      let end = 4
      while (end < 4 + EXTRA_NAME_BYTES && v.data[o + end]) end++
      const name = String.fromCharCode(...v.data.subarray(o + 4, o + end))
      out.push({
        name: name || `extra${out.length}`, dataType: type, size, offset,
        scale: options & 8 ? dv.getFloat64(o + 112, true) : null,
        add: options & 16 ? dv.getFloat64(o + 136, true) : null,
      })
    }
    offset += size
  }
  return out
}


// RGB byte offset within a point record, per point data format. Formats without
// an entry carry no RGB. (0/1/6: no RGB; 2: after xyz+intensity+flags; 3/5: after
// the f64 GPS time; 7/8: LAS 1.4 layout with a wider flag block + GPS time.)
const RGB_OFFSET = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }
const RECORD_MIN = { 0: 20, 1: 28, 2: 26, 3: 34, 6: 30, 7: 36, 8: 38 }
const SUPPORTED_FORMATS = new Set(Object.keys(RECORD_MIN).map(Number))
export const LAS_IMPORT_BUDGET = 1024 ** 3

export function validateLasAllocation(count, recordLength, extraBytes = 0) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 0xffffffff
      || !Number.isSafeInteger(recordLength) || recordLength <= 0
      || count * (recordLength * 2 + 64) + extraBytes > LAS_IMPORT_BUDGET) {
    throw new Error('LAS/LAZ import exceeds the 1 GiB working-memory limit; split or subsample the cloud first')
  }
}

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
    bytes.subarray(h.offsetToPoints), count, h.recordLength, h.format, h.scale, h.offset, h.extraBytes)
  onLog?.(`LAS: read ${count.toLocaleString()} points (v${h.versionMajor}.${h.versionMinor}, `
    + `format ${h.format}${cloud.col ? ', RGB' : ''}`
    + `${h.extraBytes.length ? `, extra bytes: ${h.extraBytes.map((e) => e.name).join(', ')}` : ''})`, 'info', 'Import')
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
  if (versionMajor !== 1 || versionMinor > 4) throw new Error('Unsupported LAS version')
  const minimumHeader = versionMinor >= 4 ? 375 : versionMinor === 3 ? 235 : HEADER_SIZE_12
  if (headerSize < minimumHeader || headerSize > bytes.length
      || offsetToPoints < headerSize || offsetToPoints > bytes.length) {
    throw new Error('Invalid LAS header size or point-data offset')
  }
  const nVlrs = dv.getUint32(100, true)
  if (nVlrs > Math.floor((offsetToPoints - headerSize) / VLR_HEADER_SIZE)) {
    throw new Error('Invalid LAS VLR count')
  }
  const formatRaw = bytes[104]
  const recordLength = dv.getUint16(105, true)
  let count = dv.getUint32(107, true)
  // LAS 1.4: the legacy u32 count may be 0 with the real u64 count at offset 247.
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
  for (let i = 0; i < nVlrs; i++) {
    if (vp + VLR_HEADER_SIZE > offsetToPoints) throw new Error('Truncated LAS VLR header')
    const recordId = dv.getUint16(vp + 18, true)
    const len = dv.getUint16(vp + 20, true)
    if (vp + VLR_HEADER_SIZE + len > offsetToPoints) throw new Error('Truncated LAS VLR payload')
    const userId = String.fromCharCode(...bytes.subarray(vp + 2, vp + 18)).replace(/\0+$/, '')
    if (recordId === 22204 && userId === 'laszip encoded') isLaz = true
    vlrs.push({ userId, recordId, data: bytes.subarray(vp + VLR_HEADER_SIZE, vp + VLR_HEADER_SIZE + len) })
    vp += VLR_HEADER_SIZE + len
  }

  const format = formatRaw & 0x3f
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new Error(`Unsupported LAS point data format ${format} (supported: 0–3, 6–8)`)
  }
  if (recordLength < RECORD_MIN[format]) throw new Error('Invalid LAS point record length')
  const scale = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)]
  const offset = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)]
  if (scale.some(v => !Number.isFinite(v) || v <= 0) || offset.some(v => !Number.isFinite(v))) {
    throw new Error('Invalid LAS coordinate scale or offset')
  }
  return {
    versionMajor, versionMinor, headerSize, offsetToPoints, formatRaw, format, recordLength,
    count, isLaz, vlrs, extraBytes: parseExtraBytes(vlrs),
    scale: [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)],
    offset: [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)],
  }
}

// Decode raw point records (already uncompressed) → the flat cloud shape. Reads
// coordinates, RGB and standard scalar LAS attributes, plus the `extraBytes` fields
// (from parseExtraBytes) that fit inside the record — an extra-bytes field named like
// a standard one replaces it (that is how a class id > 31 round-trips). Any other
// trailing bytes are skipped via recordLength; classification flags stay separate
// from class ids.
export function decodeLasPoints(pointBytes, count, recordLength, format, scale, offset, extraBytes = []) {
  validateLasAllocation(count, recordLength)
  if (!SUPPORTED_FORMATS.has(format) || recordLength < RECORD_MIN[format]
      || count * recordLength > pointBytes.byteLength) throw new Error('Truncated or invalid LAS point records')
  const dv = new DataView(pointBytes.buffer, pointBytes.byteOffset, pointBytes.byteLength)
  const rgbOff = RGB_OFFSET[format]
  const hasRgb = rgbOff != null && recordLength >= rgbOff + 6
  const pos = new Float64Array(count * 3)
  const col = hasRgb ? new Uint8Array(count * 3) : null
  const modern = format >= 6
  const attributes = {
    intensity: new Uint16Array(count), classification: new Uint8Array(count),
    returnNumber: new Uint8Array(count), numberOfReturns: new Uint8Array(count),
    scanAngle: new Float32Array(count), pointSourceId: new Uint16Array(count),
    userData: new Uint8Array(count), synthetic: new Uint8Array(count),
    keyPoint: new Uint8Array(count), withheld: new Uint8Array(count),
    scanDirection: new Uint8Array(count), edgeOfFlightLine: new Uint8Array(count),
  }
  if (modern || format === 1 || format === 3) attributes.gpsTime = new Float64Array(count)
  if (modern) {
    attributes.overlap = new Uint8Array(count)
    attributes.scannerChannel = new Uint8Array(count)
  }
  if (format === 8) attributes.nir = new Uint16Array(count)
  let p = 0, rgbMax = 0
  for (let i = 0; i < count; i++) {
    pos[i * 3] = dv.getInt32(p, true) * scale[0] + offset[0]
    pos[i * 3 + 1] = dv.getInt32(p + 4, true) * scale[1] + offset[1]
    pos[i * 3 + 2] = dv.getInt32(p + 8, true) * scale[2] + offset[2]
    attributes.intensity[i] = dv.getUint16(p + 12, true)
    const returns = dv.getUint8(p + 14)
    const flags = dv.getUint8(p + 15)
    attributes.returnNumber[i] = returns & (modern ? 15 : 7)
    attributes.numberOfReturns[i] = (returns >> (modern ? 4 : 3)) & (modern ? 15 : 7)
    attributes.classification[i] = modern ? dv.getUint8(p + 16) : flags & 31
    const classFlags = modern ? flags : flags >> 5
    attributes.synthetic[i] = classFlags & 1
    attributes.keyPoint[i] = (classFlags >> 1) & 1
    attributes.withheld[i] = (classFlags >> 2) & 1
    attributes.scanDirection[i] = ((modern ? flags : returns) >> 6) & 1
    attributes.edgeOfFlightLine[i] = ((modern ? flags : returns) >> 7) & 1
    attributes.scanAngle[i] = modern ? dv.getInt16(p + 18, true) * 0.006 : dv.getInt8(p + 16)
    attributes.userData[i] = dv.getUint8(p + 17)
    attributes.pointSourceId[i] = dv.getUint16(p + (modern ? 20 : 18), true)
    if (attributes.gpsTime) attributes.gpsTime[i] = dv.getFloat64(p + (modern ? 22 : 20), true)
    if (modern) {
      attributes.overlap[i] = (flags >> 3) & 1
      attributes.scannerChannel[i] = (flags >> 4) & 3
    }
    if (attributes.nir) attributes.nir[i] = dv.getUint16(p + 36, true)
    if (col) {
      const r = dv.getUint16(p + rgbOff, true), g = dv.getUint16(p + rgbOff + 2, true), b = dv.getUint16(p + rgbOff + 4, true)
      if (r > rgbMax) rgbMax = r; if (g > rgbMax) rgbMax = g; if (b > rgbMax) rgbMax = b
      col[i * 3] = r >> 8; col[i * 3 + 1] = g >> 8; col[i * 3 + 2] = b >> 8
    }
    p += recordLength
  }
  // Extra bytes start after the standard record. A field that would run past the
  // record (a descriptor list longer than the records it describes) is ignored.
  const base = RECORD_MIN[format]
  for (const e of extraBytes || []) {
    const at = base + e.offset
    if (at + e.size > recordLength) continue
    const [, getter, ArrayType] = EXTRA_TYPES[e.dataType]
    const transform = e.scale != null || e.add != null
    const values = new (transform ? Float64Array : ArrayType)(count)
    const big = getter.startsWith('getBig')
    const k = e.scale ?? 1, add = e.add ?? 0
    for (let i = 0, q = at; i < count; i++, q += recordLength) {
      const raw = big ? Number(dv[getter](q, true)) : dv[getter](q, true)
      values[i] = transform ? raw * k + add : raw
    }
    // Own data property even for a hostile name like "__proto__".
    Object.defineProperty(attributes, e.name, { value: values, enumerable: true, writable: true, configurable: true })
  }
  // The spec says 16-bit colour, but many writers store 0–255 in those fields;
  // the >> 8 above would turn such a cloud black. A file whose colours never
  // exceed 255 is 8-bit: re-read them unshifted (only the colour words).
  if (col && rgbMax > 0 && rgbMax <= 255) {
    for (let i = 0, q = rgbOff; i < count; i++, q += recordLength) {
      col[i * 3] = dv.getUint16(q, true)
      col[i * 3 + 1] = dv.getUint16(q + 2, true)
      col[i * 3 + 2] = dv.getUint16(q + 4, true)
    }
  }
  return { count, pos, ...(col ? { col } : {}), attributes }
}
