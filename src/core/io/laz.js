// LAZ (compressed LAS) interop. Pure — the arithmetic coder is **injected**, the
// same way core/products/geotiff.js takes its `deflate`, so this module stays
// testable in the node test environment with no wasm loaded.
//
// Division of labour with crates/lazcodec:
//   • here — the LAS header, the VLR directory, the point-record layout, and the
//     chunk framing rules. All of it is shared with core/io/las.js, so a .laz and
//     a .las of the same cloud differ in exactly two places: the LASzip high bit
//     on the point format, and the extra "laszip encoded" VLR.
//   • crates/lazcodec — the LASzip chunked arithmetic coding, and nothing else.
//
// Memory: the compressor is fed the point records in **chunks**, never as one
// giant buffer, so a 30 M-point fused cloud (780 MB of records) never has a
// second full copy alive. That is the same invariant prepareCloudForExport keeps
// on the way in.

import {
  validateLasAllocation, LAS_RECORD_F2, encodeLasPoints, writeLasHeader, readLasHeader, decodeLasPoints,
} from './las.js'
import { geoKeysForEpsg } from '../products/geotiff.js'

// The LASzip VLR, as written by laszip itself. Readers key off this pair.
export const LASZIP_VLR_USER_ID = 'laszip encoded'
export const LASZIP_VLR_RECORD_ID = 22204

// Points per compressor call. Large enough that the per-call overhead is
// irrelevant, small enough that the staged copy stays a few MB rather than the
// whole cloud.
export const LAZ_CHUNK_POINTS = 50_000

// Cloud → LAZ bytes.
//
// `compress` is the injected codec: (pointBytes, pointFormat, pointSize) →
// { vlr: Uint8Array, data: Uint8Array }. It is called ONCE with the full record
// stream for small legacy callers. Production uses createCompressor, keeping one
// encoder across bounded pushes. Splitting the stream across
// several compressor instances would produce several independent LAZ blocks, not
// one file. The chunking this module does is only in how the records are *built*.
//
// Returns a Uint8Array. Throws if no compressor was supplied — silently writing
// an uncompressed .las under a .laz name would be worse.
export function cloudToLaz(points, { crsCode = null, geographic = false, compress, createCompressor, onLog } = {}) {
  if (typeof compress !== 'function' && typeof createCompressor !== 'function') {
    throw new Error('cloudToLaz: no LAZ compressor supplied (the lazcodec WASM module failed to load)')
  }
  const flat = points && points.pos ? points : null
  const n = flat ? (flat.count ?? flat.pos.length / 3) : points.length
  const getX = flat ? (i) => flat.pos[i * 3] : (i) => points[i].x
  const getY = flat ? (i) => flat.pos[i * 3 + 1] : (i) => points[i].y
  const getZ = flat ? (i) => flat.pos[i * 3 + 2] : (i) => points[i].z
  const getC = flat
    ? (flat.col ? (i) => [flat.col[i * 3], flat.col[i * 3 + 1], flat.col[i * 3 + 2]] : () => null)
    : (i) => points[i].color

  const { scale, offset, bbox } = quantization(n, getX, getY, getZ)

  // The browser codec keeps one encoder alive across bounded chunks. The
  // whole-buffer adapter remains for small callers with an injected legacy codec.
  if (!createCompressor && n * LAS_RECORD_F2 > 64 * 1024 ** 2) {
    throw new Error('Large LAZ exports require an incremental compressor')
  }
  const encoder = createCompressor?.(2, LAS_RECORD_F2)
  let packed
  try {
    const pointBytes = encoder ? null : new Uint8Array(n * LAS_RECORD_F2)
    for (let start = 0; start < n; start += LAZ_CHUNK_POINTS) {
      const len = Math.min(LAZ_CHUNK_POINTS, n - start)
      const chunk = encodeLasPoints({ n: len,
        getX: i => getX(start + i), getY: i => getY(start + i), getZ: i => getZ(start + i),
        getC: i => getC(start + i), scale, offset })
      if (encoder) encoder.push(chunk)
      else pointBytes.set(chunk, start * LAS_RECORD_F2)
    }
    packed = encoder ? encoder.finish() : compress(pointBytes, 2, LAS_RECORD_F2)
  } finally { encoder?.free?.() }

  const vlrs = []
  if (crsCode) vlrs.push({ userId: 'LASF_Projection', recordId: 34735, description: 'GeoKeyDirectory', data: geoKeyBytes(crsCode, geographic) })
  // The LASzip VLR must be present for any reader to know how the points were
  // coded — the point format's high bit alone says only *that* they were.
  vlrs.push({
    userId: LASZIP_VLR_USER_ID, recordId: LASZIP_VLR_RECORD_ID,
    description: 'lazcodec', data: packed.vlr,
  })

  const header = writeLasHeader({ n, vlrs, scale, offset, bbox, compressed: true })
  const out = new Uint8Array(header.length + packed.data.length)
  out.set(header, 0)
  out.set(packed.data, header.length)
  // The codec writes a standalone point block; LASzip files store absolute
  // chunk-table offsets, so account for the header and VLRs when embedding it.
  relocateChunkTable(out.subarray(header.length), packed.vlr, header.length)
  const ratio = n ? (n * LAS_RECORD_F2 / packed.data.length) : 1
  onLog?.(`LAZ export: ${n.toLocaleString()} points, ${(out.length / 1024 ** 2).toFixed(1)} MB `
    + `(${ratio.toFixed(1)}× smaller than LAS)`
    + (crsCode ? `, EPSG:${crsCode} GeoKey VLR` : ', no CRS VLR (local frame)'), 'info', 'Export')
  return out
}

// LAZ bytes → the flat cloud shape, via the injected decompressor:
// (vlrData, compressed, numPoints, pointSize) → Uint8Array of raw records.
export function parseLaz(buffer, { decompress, onLog } = {}) {
  if (typeof decompress !== 'function') {
    throw new Error('parseLaz: no LAZ decompressor supplied (the lazcodec WASM module failed to load)')
  }
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const h = readLasHeader(bytes)
  if (!h.isLaz) {
    throw new Error('This file is uncompressed LAS, not LAZ — read it with parseLas')
  }
  const lazVlr = h.vlrs.find((v) => v.recordId === LASZIP_VLR_RECORD_ID && v.userId === LASZIP_VLR_USER_ID)
  if (!lazVlr) {
    throw new Error('LAZ file has no "laszip encoded" VLR (record 22204) — cannot know how the points were coded')
  }
  // Keep the caller's file unchanged. The codec seeks within the point block,
  // whereas the file's chunk-table pointer is relative to the whole LAS file.
  // Include both this copy and the codec's input copy in the memory budget.
  validateLasAllocation(h.count, h.recordLength, bytes.byteLength + 2 * (bytes.byteLength - h.offsetToPoints))
  const compressed = new Uint8Array(bytes.subarray(h.offsetToPoints))
  relocateChunkTable(compressed, lazVlr.data, -h.offsetToPoints)
  const records = decompress(lazVlr.data, compressed, h.count, h.recordLength)
  const cloud = decodeLasPoints(records, h.count, h.recordLength, h.format, h.scale, h.offset)
  onLog?.(`LAZ: read ${h.count.toLocaleString()} points (v${h.versionMajor}.${h.versionMinor}, `
    + `format ${h.format}${cloud.col ? ', RGB' : ''})`, 'info', 'Import')
  return cloud
}

// LASzip compressor types 2 (pointwise chunked) and 3 (layered/COPC) have
// an i64 chunk-table pointer. Type 1 is an unchunked stream without a pointer.
function relocateChunkTable(data, vlr, delta) {
  if (vlr.byteLength < 2) throw new Error('Truncated LASzip VLR')
  const compressor = new DataView(vlr.buffer, vlr.byteOffset, vlr.byteLength).getUint16(0, true)
  if (compressor !== 2 && compressor !== 3) return
  if (data.byteLength < 8) throw new Error('Truncated LAZ chunk-table pointer')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let pointerOffset = 0
  let pointer = view.getBigInt64(0, true)
  // Non-seekable writers put the actual pointer at EOF and leave -1 here.
  if (pointer === -1n) {
    pointerOffset = data.byteLength - 8
    pointer = view.getBigInt64(pointerOffset, true)
  }
  if (pointer <= 0n) return // No chunk table; let the codec handle sequential decoding.
  const relative = pointer + BigInt(Math.min(delta, 0))
  if (relative < 8n || relative + 8n > BigInt(data.byteLength)) {
    throw new Error('Invalid LAZ chunk-table offset (file may be truncated)')
  }
  view.setBigInt64(pointerOffset, pointer + BigInt(delta), true)
}

// Per-axis quantization, identical to the LAS writer's — a .laz and .las of the
// same cloud must dequantize to the same coordinates.
function quantization(n, getX, getY, getZ) {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    const x = getX(i), y = getY(i), z = getZ(i)
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  if (!Number.isFinite(minX)) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0 }
  const scaleFor = (span) => Math.max((span / 2 ** 31) * 1.01, 1e-4)
  return {
    scale: [scaleFor(maxX - minX), scaleFor(maxY - minY), scaleFor(maxZ - minZ)],
    offset: [minX, minY, minZ],
    bbox: { minX, minY, minZ, maxX, maxY, maxZ },
  }
}

function geoKeyBytes(crsCode, geographic) {
  const keys = geoKeysForEpsg(crsCode, geographic)
  const dir = [1, 1, 0, keys.length]
  for (const k of keys) dir.push(k[0], k[1], k[2], k[3])
  const body = new Uint8Array(dir.length * 2)
  const bv = new DataView(body.buffer)
  dir.forEach((v, i) => bv.setUint16(i * 2, v, true))
  return body
}
