// A LAS or LAZ file as a stream of point batches (dev/planning/plan-lod.md ▸ L4), so a
// file larger than memory can be imported straight into a level-of-detail octree.
// Pure: the file is injected I/O ({ size, read(start, end) → Uint8Array }, see
// utils/blobParts.js blobSource), and so is the LASzip codec's streaming decoder:
//   createLazDecoder(vlrData, chunkTableBytes) → { chunkCount(), chunkPoints(i),
//     chunkBytes(i), decode(compressed, first, count, numPoints) → records }
//
// A streamed cloud keeps positions, colour and the attributes most surveys are
// styled by (STREAM_ATTRIBUTES); the rest of a record is not stored.

import { readLasHeader, createLasDecoder, validateLasAllocation } from './las.js'
import { LASZIP_VLR_USER_ID, LASZIP_VLR_RECORD_ID } from './laz.js'

export const STREAM_ATTRIBUTES = [
  { name: 'intensity', type: 'uint16' }, { name: 'classification', type: 'uint8' },
  { name: 'returnNumber', type: 'uint8' }, { name: 'numberOfReturns', type: 'uint8' },
]
const RGB_FORMATS = new Set([2, 3, 5, 7, 8, 10])
const SAMPLE_RUNS = 8 // runs read to decide the colour depth

/**
 * Whether a LAS/LAZ file must be streamed: the whole-file import would pass its
 * working-memory limit (validateLasAllocation; a LAZ also holds its compressed bytes
 * twice). `head` is the file's first bytes, at least up to the point data.
 * → null when the file is not LAS/LAZ (or its header is unreadable), else a boolean.
 */
export function lasNeedsStreaming(head, fileSize) {
  let h
  try { h = readLasHeader(head) } catch { return null }
  try {
    validateLasAllocation(h.count, h.recordLength, h.isLaz ? fileSize + 2 * (fileSize - h.offsetToPoints) : 0)
    return false
  } catch {
    return true
  }
}

/**
 * → { header, count, bounds, layout: { offset, scale }, colour, attributes, batches() }
 * batches() yields { count, pos: Float64Array (the file's coordinates), col?, attributes }.
 */
export async function openLasStream(source, { createLazDecoder = null, batchPoints = 1 << 20, onLog } = {}) {
  const first = await source.read(0, Math.min(source.size, 375))
  const offsetToPoints = first.length >= 100 ? new DataView(first.buffer, first.byteOffset, first.byteLength).getUint32(96, true) : 0
  const h = readLasHeader(await source.read(0, Math.min(source.size, Math.max(offsetToPoints, 375))))
  const { recordLength: size } = h
  let count = h.count
  const runs = [] // { at, bytes, first?, chunks?, n }
  let decodeRun
  if (h.isLaz) {
    if (!createLazDecoder) throw new Error('LAZ streaming needs the lazcodec WASM module')
    const vlr = h.vlrs.find((v) => v.recordId === LASZIP_VLR_RECORD_ID && v.userId === LASZIP_VLR_USER_ID)
    if (!vlr) throw new Error('LAZ file has no "laszip encoded" VLR (record 22204)')
    // The chunk table's offset opens the point data; -1 means it was appended at EOF.
    const pointer = (bytes) => Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true))
    let tableAt = pointer(await source.read(h.offsetToPoints, h.offsetToPoints + 8))
    if (tableAt <= h.offsetToPoints) tableAt = pointer(await source.read(source.size - 8, source.size))
    if (!(tableAt > h.offsetToPoints && tableAt < source.size)) throw new Error('Invalid LAZ chunk-table offset (file may be truncated)')
    const decoder = createLazDecoder(vlr.data, await source.read(tableAt, Math.min(source.size, tableAt + 64 * 1024 ** 2)))
    if (decoder.pointSize?.() != null && decoder.pointSize() !== size) throw new Error('LAZ record size does not match its LASzip VLR')
    // Runs of whole chunks, about batchPoints points each.
    let at = h.offsetToPoints + 8, left = count, run = null
    for (let i = 0; i < decoder.chunkCount() && left > 0; i++) {
      const n = Math.min(decoder.chunkPoints(i), left), bytes = decoder.chunkBytes(i)
      if (!run || run.n + n > batchPoints) { run = { at, bytes: 0, first: i, chunks: 0, n: 0 }; runs.push(run) }
      run.bytes += bytes; run.chunks++; run.n += n
      at += bytes; left -= n
    }
    if (left > 0) {
      onLog?.(`LAZ: the chunk table covers ${(count - left).toLocaleString()} of ${count.toLocaleString()} points — reading those`, 'warn', 'Import')
      count -= left
    }
    decodeRun = async (r, chunks = r.chunks) => {
      const bytes = chunks === r.chunks ? r.bytes : decoder.chunkBytes(r.first)
      const n = chunks === r.chunks ? r.n : Math.min(r.n, decoder.chunkPoints(r.first))
      return { n, records: decoder.decode(await source.read(r.at, r.at + bytes), r.first, chunks, n) }
    }
  } else {
    const avail = Math.floor((source.size - h.offsetToPoints) / size)
    if (avail < count) {
      onLog?.(`LAS: header claims ${count} points but the file holds ${avail} — reading ${avail}`, 'warn', 'Import')
      count = Math.max(0, avail)
    }
    for (let start = 0; start < count; start += batchPoints) {
      const n = Math.min(batchPoints, count - start)
      runs.push({ at: h.offsetToPoints + start * size, bytes: n * size, n })
    }
    decodeRun = async (r, part = null) => {
      const n = part ? Math.min(r.n, 50_000) : r.n
      return { n, records: await source.read(r.at, r.at + n * size) }
    }
  }

  // Colour depth for the whole file, from a sample spread over it: the spec says
  // 16-bit, but many writers store 0–255 (see createLasDecoder).
  let colour = RGB_FORMATS.has(h.format)
  let rgbBits = null
  if (colour) {
    let max = 0
    const off = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }[h.format]
    const step = Math.max(1, Math.floor(runs.length / SAMPLE_RUNS))
    for (let k = 0; k < runs.length && max <= 255; k += step) {
      const { n, records } = await decodeRun(runs[k], 1)
      const dv = new DataView(records.buffer, records.byteOffset, records.byteLength)
      for (let i = 0, p = off; i < n; i++, p += size) max = Math.max(max, dv.getUint16(p, true), dv.getUint16(p + 2, true), dv.getUint16(p + 4, true))
    }
    rgbBits = max > 255 ? 16 : 8
    // A colour format whose colours are all zero (a writer that had none): no colour.
    if (max === 0) {
      colour = false
      onLog?.('LAS: the colour fields are empty — imported without colour', 'info', 'Import')
    }
  }

  async function* batches() {
    for (const r of runs) {
      const { n, records } = await decodeRun(r)
      const dec = createLasDecoder(n, size, h.format, h.scale, h.offset, [], { rgbBits })
      dec.decode(records, 0, n)
      const c = dec.finish()
      yield {
        count: n, pos: c.pos, col: colour ? c.col ?? null : null,
        // The decoder leaves out a field that is zero throughout; the octree keeps all four.
        attributes: Object.fromEntries(STREAM_ATTRIBUTES.map((a) => [a.name,
          c.attributes[a.name] ?? new (a.type === 'uint16' ? Uint16Array : Uint8Array)(n)])),
      }
    }
  }

  // The header's extent, unless it cannot be right; then one pass measures it.
  const b = h.bounds
  let bounds = { min: [...b.min], max: [...b.max] }
  const plausible = [0, 1, 2].every((k) => Number.isFinite(b.min[k]) && Number.isFinite(b.max[k]) && b.min[k] <= b.max[k])
    && (count < 2 || [0, 1, 2].some((k) => b.max[k] > b.min[k]))
  if (!plausible && count) {
    onLog?.('LAS: the header has no usable extent — measuring the points first', 'warn', 'Import')
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    for await (const batch of batches()) {
      for (let i = 0; i < batch.count; i++) for (let k = 0; k < 3; k++) {
        const v = batch.pos[3 * i + k]
        if (v < min[k]) min[k] = v
        if (v > max[k]) max[k] = v
      }
    }
    bounds = { min, max }
  } else {
    // Widen by half a quantum: header extents are often rounded.
    for (let k = 0; k < 3; k++) { bounds.min[k] -= h.scale[k]; bounds.max[k] += h.scale[k] }
  }

  return {
    header: h, count, bounds, layout: { offset: [...h.offset], scale: [...h.scale] },
    colour, attributes: STREAM_ATTRIBUTES.map((a) => ({ ...a })), batches,
  }
}
