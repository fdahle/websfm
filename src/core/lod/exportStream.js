// A streamed cloud written out node by node (dev/planning/plan-lod.md ▸ L5): the
// octree is read one node at a time, so the file is never in memory whole. Pure over
// a reader (core/lod/reader.js); yields parts for a Blob, the header last for LAS
// (its per-return counts are known only at the end), so the caller puts it first.
//
// LAS and LAZ keep the octree's quantisation (an imported LAS's own scale and offset:
// the coordinates come back exactly) and the source file's projection VLRs. PLY and
// XYZ are written as the in-memory exporters write them. Points come in octree order,
// not the source file's.

import { encodeLasPoints, writeLasHeader, extraBytesVlr, LAS_RECORD_F2 } from '../io/las.js'
import { LASZIP_VLR_USER_ID, LASZIP_VLR_RECORD_ID } from '../io/laz.js'
import { cloudToPlyParts } from '../products/exporters.js'
import { cloudToXyzParts } from '../io/cloudText.js'

// The standard LAS fields a streamed cloud's attributes can go in, with their range;
// a cloud whose values fall outside (a class over 31) writes that one as extra bytes.
const NATIVE = { intensity: [0, 65535], classification: [0, 31], returnNumber: [0, 7], numberOfReturns: [0, 7] }
const EXTRA_TYPE = { uint8: 1, int8: 2, uint16: 3, int16: 4, uint32: 5, int32: 6, float32: 9, float64: 10 }
const EXTRA_SIZE = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 9: 4, 10: 8 }

const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/**
 * The LAS record plan from the octree's attribute layout and value ranges.
 * `extraBytes: false` (LAZ: the codec carries standard fields only) lists what would
 * need extra bytes as `dropped`.
 */
export function lasPlanFor(lod, { extraBytes = true } = {}) {
  const native = [], extra = [], dropped = []
  let offset = 0
  for (const a of lod.layout.attributes) {
    const r = lod.stats?.ranges?.[a.name], range = NATIVE[a.name]
    if (range && r && Number.isInteger(r.min) && Number.isInteger(r.max) && r.min >= range[0] && r.max <= range[1]) {
      native.push(a.name)
      continue
    }
    const dataType = EXTRA_TYPE[a.type]
    if (!dataType || !extraBytes) { dropped.push(a.name); continue }
    extra.push({ name: a.name, source: a.name, dataType, size: EXTRA_SIZE[dataType], offset })
    offset += EXTRA_SIZE[dataType]
  }
  return { format: 2, recordLength: LAS_RECORD_F2 + offset, native, extra, dropped }
}

async function* nodes(reader) {
  for (const node of reader.nodes.values()) {
    if (!node.count) continue
    yield await reader.read(node, { as: 'absolute' })
  }
}

/**
 * LAS: → { header: Uint8Array, parts: async iterator of Uint8Array }; the header is
 * filled in once `parts` is exhausted (call `header()` then).
 */
export function lodToLas(reader, lod, { onProgress, compressor = null } = {}) {
  const plan = lasPlanFor(lod, { extraBytes: !compressor })
  const { scale, offset } = lod.layout
  const byReturn = [0, 0, 0, 0, 0]
  let written = 0
  async function* parts() {
    for await (const pts of nodes(reader)) {
      const native = Object.fromEntries(plan.native.map((n) => [n, pts.attributes[n]]))
      const rn = pts.attributes.returnNumber
      for (let i = 0; i < pts.count; i++) { const k = (rn ? rn[i] : 1) - 1; if (k >= 0 && k < 5) byReturn[k]++ }
      const records = encodeLasPoints({
        n: pts.count, getX: (i) => pts.pos[3 * i], getY: (i) => pts.pos[3 * i + 1], getZ: (i) => pts.pos[3 * i + 2],
        getC: pts.col ? (i) => [pts.col[3 * i], pts.col[3 * i + 1], pts.col[3 * i + 2]] : () => null,
        scale, offset, format: plan.format, recordLength: plan.recordLength, native,
        extra: plan.extra.map((e) => ({ ...e, values: pts.attributes[e.source] })),
      })
      if (compressor) {
        // The codec takes at most 8 MB per push; its output is handed over as it grows.
        const step = Math.floor((8 << 20) / plan.recordLength) * plan.recordLength
        for (let o = 0; o < records.length; o += step) compressor.push(records.subarray(o, o + step))
        const out = compressor.drain()
        if (out.length) yield out
      } else yield records
      written += pts.count
      onProgress?.(written, lod.points)
    }
  }
  function header(lazVlr = null) {
    const vlrs = (lod.file?.projection ?? []).map((v) => ({ ...v, data: fromBase64(v.data) }))
    if (plan.extra.length) vlrs.push(extraBytesVlr(plan.extra))
    if (lazVlr) vlrs.push({ userId: LASZIP_VLR_USER_ID, recordId: LASZIP_VLR_RECORD_ID, description: 'lazcodec', data: lazVlr })
    const [minX, minY, minZ] = lod.bounds.min, [maxX, maxY, maxZ] = lod.bounds.max
    return writeLasHeader({ n: written, vlrs, scale, offset, bbox: { minX, minY, minZ, maxX, maxY, maxZ }, compressed: !!lazVlr,
      format: plan.format, recordLength: plan.recordLength, pointsByReturn: lod.layout.attributes.some((a) => a.name === 'returnNumber') ? byReturn : null })
  }
  // LAZ, once `parts` is exhausted: the header, then the stream's first 8 bytes (the
  // chunk-table offset, made absolute), then the parts, then `tail`.
  function lazEnds() {
    const { vlr, data } = compressor.finish()
    const head = header(vlr)
    const first = data.slice(0, 8)
    const dv = new DataView(first.buffer)
    dv.setBigInt64(0, dv.getBigInt64(0, true) + BigInt(head.length), true)
    return { header: head, first, tail: data.subarray(8) }
  }
  return { parts: parts(), header, lazEnds, dropped: plan.dropped }
}

/** PLY (binary or 'ply-ascii') or XYZ: async iterator of parts (strings or Uint8Arrays), header first. */
export async function* lodToText(reader, lod, { format, color = true, onProgress } = {}) {
  let written = 0, first = true
  for await (const pts of nodes(reader)) {
    const cloud = { count: pts.count, pos: pts.pos, ...(pts.col ? { col: pts.col } : {}), attributes: pts.attributes }
    if (format === 'xyz') {
      yield* cloudToXyzParts(cloud, { color })
    } else if (format === 'ply-ascii') {
      // The node's header is cut off its first part, and the first node's carries the
      // cloud's count.
      let headless = false
      for (const part of cloudToPlyParts(cloud, { binary: false, color })) {
        if (headless) { yield part; continue }
        const end = part.indexOf('end_header\n') + 'end_header\n'.length
        if (first) yield part.slice(0, end).replace(/element vertex \d+/, `element vertex ${lod.points}`)
        yield part.slice(end)
        headless = true
      }
    } else {
      const it = cloudToPlyParts(cloud, { binary: true, color })
      const head = it.next().value
      // One header for the whole file: this node's, with the cloud's count.
      if (first) yield new TextEncoder().encode(new TextDecoder().decode(head).replace(/element vertex \d+/, `element vertex ${lod.points}`))
      for (let p = it.next(); !p.done; p = it.next()) yield p.value
    }
    first = false
    written += pts.count
    onProgress?.(written, lod.points)
  }
}
