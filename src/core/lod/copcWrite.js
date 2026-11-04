// A cloud's level-of-detail octree written as a COPC file (Cloud Optimized Point Cloud,
// copc.io, COPC 1.0): the counterpart of core/lod/copc.js, which reads one in place. Pure
// over a reader (core/lod/reader.js, or tiles3d.js memoryLodReader) and an injected
// encoder (crates/lazcodec CopcEncoder, through workers/ops/laz.js):
//   createEncoder(pointFormat, recordLength) → { vlr: Uint8Array, push(records),
//     endChunk(), position() → stream bytes so far, drain() → Uint8Array, finish() → { data } }
//
// Ours and COPC's octrees have the same keys and rules (every point in exactly one node,
// a node a subsample of its cube), so each node of ours becomes one node there: its
// points are one LASzip chunk of point format 6 (7 with colour), and the hierarchy, one
// page of 32-byte entries, is an extended VLR after the points. The file:
//   LAS 1.4 header | VLRs: copc info (first, 160 bytes), laszip, WKT, extra bytes |
//   8-byte chunk-table offset | a chunk per node | the LAZ chunk table | hierarchy EVLR
// The header and info VLR are written last (they hold the hierarchy's offset), so the
// points stream through: the caller puts `header, first` before the parts and `tail,
// evlr` after them, as for LAZ (exportStream.js lodToLas).

import {
  encodeLas14Points,
  writeLas14Header,
  writeEvlr,
  extraBytesVlr,
  NATIVE_FIELDS_14,
  LAS_RECORD_F6,
  LAS_RECORD_F7,
  LAS_VLR_HEADER_SIZE,
  LAS_EVLR_HEADER_SIZE,
} from '../io/las.js'
import { LASZIP_VLR_USER_ID, LASZIP_VLR_RECORD_ID } from '../io/laz.js'
import { COPC_USER_ID, COPC_INFO_RECORD } from './copc.js'
import { chooseLayout } from './build.js'
import { typeName } from './nodeCodec.js'
import { memoryLodReader, lasEpsg } from './tiles3d.js'
import { epsgToWkt } from '../products/wkt.js'

const EXTRA_TYPE = { uint8: 1, int8: 2, uint16: 3, int16: 4, uint32: 5, int32: 6, float32: 9, float64: 10 }
const EXTRA_SIZE = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 9: 4, 10: 8 }
const MAX_PUSH = 8 << 20 // the codec's largest push
const HEADER_14 = 375
const ENTRY = 32
export const COPC_HIERARCHY_RECORD = 1000

/**
 * The record plan for point format 6 or 7: an attribute goes into its standard field
 * when every value fits it (`ranges`), else as extra bytes, unless no extra-bytes type
 * holds it (`dropped`). attributes [{ name, type }], ranges { name: { min, max } }.
 */
export function copcPlanFor(attributes, ranges = {}, colour = false) {
  const native = [],
    extra = [],
    dropped = []
  let offset = 0
  for (const a of attributes) {
    const r = ranges[a.name],
      range = NATIVE_FIELDS_14[a.name]
    if (a.name === 'gpsTime') {
      native.push(a.name)
      continue
    }
    const integral = a.name !== 'scanAngle'
    if (
      range &&
      r &&
      (!integral || (Number.isInteger(r.min) && Number.isInteger(r.max))) &&
      r.min >= range[0] &&
      r.max <= range[1]
    ) {
      native.push(a.name)
      continue
    }
    const dataType = EXTRA_TYPE[a.type]
    if (!dataType) {
      dropped.push(a.name)
      continue
    }
    extra.push({ name: a.name, source: a.name, dataType, size: EXTRA_SIZE[dataType], offset })
    offset += EXTRA_SIZE[dataType]
  }
  const format = colour ? 7 : 6
  return { format, recordLength: (colour ? LAS_RECORD_F7 : LAS_RECORD_F6) + offset, native, extra, dropped }
}

const vlrBytes = (v) => LAS_VLR_HEADER_SIZE + v.data.length

/**
 * The COPC file of an octree. `lod` { root: { min, size }, spacing, layout: { scale,
 * offset, colour, attributes: [{ name, type }] }, stats?: { ranges }, bounds, points }.
 * opts { createEncoder, wkt (OGC WKT of the CRS, or null), color, onProgress(done, total) }
 * → { parts: async iterator of Uint8Array, ends() → { header, first, tail, evlr },
 *     dropped, plan }
 */
export function lodToCopc(reader, lod, { createEncoder, wkt = null, color = true, onProgress } = {}) {
  const colour = !!(color && lod.layout.colour)
  const plan = copcPlanFor(lod.layout.attributes ?? [], lod.stats?.ranges ?? {}, colour)
  const encoder = createEncoder(plan.format, plan.recordLength)
  const { scale, offset } = lod.layout
  // The VLRs, the info record's values filled in at the end (its size is fixed).
  const info = { userId: COPC_USER_ID, recordId: COPC_INFO_RECORD, description: 'copc info', data: new Uint8Array(160) }
  const vlrs = [
    info,
    { userId: LASZIP_VLR_USER_ID, recordId: LASZIP_VLR_RECORD_ID, description: 'lazcodec', data: encoder.vlr },
  ]
  if (wkt)
    vlrs.push({
      userId: 'LASF_Projection',
      recordId: 2112,
      description: 'OGC WKT',
      data: new TextEncoder().encode(`${wkt}\0`),
    })
  if (plan.extra.length) vlrs.push(extraBytesVlr(plan.extra))
  const headerLength = HEADER_14 + vlrs.reduce((n, v) => n + vlrBytes(v), 0)

  const all = [...reader.nodes.values()]
  const full = all.filter((n) => n.count > 0)
  const last = full.at(-1)
  const entries = [] // { key, start, end, count } (stream positions; end null for the last)
  const byReturn = new Array(15).fill(0)
  const gps = [Infinity, -Infinity]
  let written = 0,
    drainedBytes = 0
  const total = full.reduce((n, node) => n + node.count, 0)

  async function* parts() {
    for (const node of all) {
      if (!node.count) {
        entries.push({ key: node.key, start: 0, end: 0, count: 0 })
        continue
      }
      const pts = await reader.read(node, { as: 'absolute' })
      const native = Object.fromEntries(plan.native.map((n) => [n, pts.attributes?.[n]]).filter(([, v]) => v))
      const rn = native.returnNumber
      for (let i = 0; i < pts.count; i++) {
        const k = (rn ? rn[i] : 1) - 1
        if (k >= 0 && k < 15) byReturn[k]++
      }
      if (native.gpsTime)
        for (let i = 0; i < pts.count; i++) {
          const t = native.gpsTime[i]
          if (t < gps[0]) gps[0] = t
          if (t > gps[1]) gps[1] = t
        }
      const records = encodeLas14Points({
        n: pts.count,
        getX: (i) => pts.pos[3 * i],
        getY: (i) => pts.pos[3 * i + 1],
        getZ: (i) => pts.pos[3 * i + 2],
        getC: pts.col ? (i) => [pts.col[3 * i], pts.col[3 * i + 1], pts.col[3 * i + 2]] : () => null,
        scale,
        offset,
        format: plan.format,
        recordLength: plan.recordLength,
        native,
        extra: plan.extra.map((e) => ({ ...e, values: pts.attributes[e.source] })),
      })
      const start = encoder.position()
      const step = Math.floor(MAX_PUSH / plan.recordLength) * plan.recordLength
      for (let o = 0; o < records.length; o += step) encoder.push(records.subarray(o, o + step))
      let end = null
      if (node !== last) {
        encoder.endChunk()
        end = encoder.position()
      }
      entries.push({ key: node.key, start, end, count: pts.count })
      const out = encoder.drain()
      if (out.length) {
        drainedBytes += out.length
        yield out
      }
      written += pts.count
      onProgress?.(written, total)
    }
  }

  // Once `parts` is exhausted: the header, the stream's first 8 bytes (the chunk-table
  // offset, made absolute), the rest of the stream, and the hierarchy.
  function ends() {
    const { data } = encoder.finish()
    const head = new DataView(data.buffer, data.byteOffset, 8)
    const tableAt = Number(head.getBigInt64(0, true))
    for (const e of entries) if (e.end === null) e.end = tableAt
    const streamBytes = drainedBytes + data.length
    const first = data.slice(0, 8)
    new DataView(first.buffer).setBigInt64(0, BigInt(tableAt + headerLength), true)
    const tail = data.subarray(8)

    const page = new Uint8Array(entries.length * ENTRY)
    const pv = new DataView(page.buffer)
    entries.forEach((e, i) => {
      const o = i * ENTRY
      for (let k = 0; k < 4; k++) pv.setInt32(o + 4 * k, e.key[k], true)
      pv.setBigUint64(o + 16, BigInt(e.count ? headerLength + e.start : 0), true)
      pv.setInt32(o + 24, e.count ? e.end - e.start : 0, true)
      pv.setInt32(o + 28, e.count, true)
    })
    const evlrOffset = headerLength + streamBytes
    const evlr = writeEvlr({
      userId: COPC_USER_ID,
      recordId: COPC_HIERARCHY_RECORD,
      description: 'EPT hierarchy',
      data: page,
    })

    const half = lod.root.size / 2
    const iv = new DataView(info.data.buffer)
    for (let k = 0; k < 3; k++) iv.setFloat64(8 * k, lod.root.min[k] + half, true)
    iv.setFloat64(24, half, true)
    iv.setFloat64(32, lod.spacing, true)
    iv.setBigUint64(40, BigInt(evlrOffset + LAS_EVLR_HEADER_SIZE), true)
    iv.setBigUint64(48, BigInt(page.length), true)
    iv.setFloat64(56, Number.isFinite(gps[0]) ? gps[0] : 0, true)
    iv.setFloat64(64, Number.isFinite(gps[1]) ? gps[1] : 0, true)

    const [minX, minY, minZ] = lod.bounds.min,
      [maxX, maxY, maxZ] = lod.bounds.max
    const header = writeLas14Header({
      n: written,
      vlrs,
      scale,
      offset,
      bbox: { minX, minY, minZ, maxX, maxY, maxZ },
      compressed: true,
      format: plan.format,
      recordLength: plan.recordLength,
      pointsByReturn: byReturn,
      evlrs: { offset: evlrOffset, count: 1 },
    })
    if (header.length !== headerLength) throw new Error('COPC: the header is not the size planned')
    return { header, first, tail, evlr }
  }

  return { parts: parts(), ends, dropped: plan.dropped, plan }
}

/**
 * A resident cloud { count, pos (Float64 3n), col?, attributes? } as an octree to write
 * (memoryLodReader), with what lodToCopc needs beyond it: a quantisation (chooseLayout:
 * 10⁸ steps over the extent), the attribute types and their value ranges.
 * → { reader, lod }
 */
export function memoryCopcSource(cloud, opts = {}) {
  const { reader, lod } = memoryLodReader(cloud, opts)
  const attrs = Object.entries(cloud.attributes ?? {})
  const ranges = {}
  for (const [name, arr] of attrs) {
    let min = Infinity,
      max = -Infinity
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]
      if (v < min) min = v
      if (v > max) max = v
    }
    ranges[name] = { min, max }
  }
  const layout = chooseLayout({
    bounds: lod.bounds,
    colour: !!cloud.col,
    attributes: attrs.map(([name, arr]) => ({ name, type: typeName(arr) })),
  })
  return { reader, lod: { ...lod, layout, stats: { ranges }, points: cloud.count } }
}

/**
 * The OGC WKT a streamed cloud's own file gave its CRS (its WKT record, else its EPSG
 * code through epsgToWkt), or null: a streamed cloud is written in its own coordinates.
 */
export function lodWkt(lod) {
  const wkt = (lod?.file?.projection ?? []).find((v) => v.recordId === 2112)
  if (wkt) return new TextDecoder().decode(Uint8Array.from(atob(wkt.data), (c) => c.charCodeAt(0))).replace(/\0+$/, '')
  const epsg = lasEpsg(lod)
  return epsg ? epsgToWkt(epsg) : null
}

/**
 * lodToCopc's output as one Blob, its parts gathered a batch at a time (the browser
 * keeps a large Blob on disk). → Blob
 */
export async function copcBlob(out, type = 'application/octet-stream') {
  let blob = null,
    batch = [],
    size = 0
  for await (const p of out.parts) {
    batch.push(p)
    size += p.byteLength
    if (size >= 64 << 20) {
      blob = new Blob(blob ? [blob, ...batch] : batch)
      batch = []
      size = 0
    }
  }
  const { header, first, tail, evlr } = out.ends()
  return new Blob([header, first, ...(blob ? [blob] : []), ...batch, tail, evlr], { type })
}
