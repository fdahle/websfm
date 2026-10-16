import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import init, { LazEncoder, LazDecoder, decompress_points } from '../src/wasm/lazcodec/lazcodec.js'
import { cloudToLaz, parseLaz } from '../src/core/io/laz.js'
import { readLasHeader } from '../src/core/io/las.js'
import { parseCloudFile, cloudStats } from '../src/core/io/cloudImport.js'
import { openLasStream } from '../src/core/io/lasStream.js'
import { buildLod } from '../src/core/lod/build.js'
import { openLodReader } from '../src/core/lod/reader.js'
import { lodToLas, lasPlanFor } from '../src/core/lod/exportStream.js'
await init({ module_or_path: await readFile(new URL('../src/wasm/lazcodec/lazcodec_bg.wasm', import.meta.url)) })
const count = 100_003
const pos = new Float64Array(count * 3)
for (let i = 0; i < count; i++) { pos[i*3] = 7e6 + i / 100; pos[i*3+1] = 5e5 + i / 200; pos[i*3+2] = i / 500 }
let chunks = 0
const bytes = cloudToLaz({ count, pos }, { createCompressor: (format, size) => {
  const encoder = new LazEncoder(format, size)
  return { push: data => { assert.ok(data.length <= 50_000 * 26); chunks++; encoder.push(data) },
    finish: () => { const packed = encoder.finish(); const vlr = packed.vlr; return { vlr, data: packed.data() } },
    free: () => encoder.free() }
} })
// Check the on-disk pointer independently of parseLaz: a round trip alone
// would miss a writer and reader that both incorrectly use relative offsets.
const header = readLasHeader(bytes)
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const tableOffset = Number(view.getBigInt64(header.offsetToPoints, true))
assert.ok(tableOffset > header.offsetToPoints && tableOffset + 8 <= bytes.length)
assert.equal(view.getUint32(tableOffset, true), 0) // chunk-table version
assert.equal(view.getUint32(tableOffset + 4, true), chunks)
const cloud = parseLaz(bytes, { decompress: decompress_points })
assert.equal(chunks, 3)
assert.equal(cloud.count, count)
for (let i = 0; i < pos.length; i++) assert.ok(Math.abs(pos[i] - cloud.pos[i]) < 0.000051)
console.log(`Built LAZ WASM round-trip: ${count} survey-coordinate points, ${chunks} bounded input chunks`)

// The streaming decoder (a run of chunks per call, core/io/lasStream.js) reads the
// same points as the whole-file decoder, in bounded batches.
const createLazDecoder = (vlr, table) => {
  const d = new LazDecoder(vlr, table)
  return { chunkCount: () => d.chunk_count(), chunkPoints: (i) => d.chunk_points(i), chunkBytes: (i) => d.chunk_bytes(i),
    pointSize: () => d.point_size(), decode: (b, first, n, points) => d.decode(b, first, n, points) }
}
const stream = await openLasStream({ size: bytes.length, read: async (a, b) => bytes.slice(a, b) }, { createLazDecoder, batchPoints: 60_000 })
let streamed = 0, batches = 0
for await (const b of stream.batches()) {
  assert.ok(b.count <= 60_000)
  for (let k = 0; k < b.count; k++) for (let a = 0; a < 3; a++) assert.equal(b.pos[3 * k + a], cloud.pos[3 * (streamed + k) + a])
  streamed += b.count; batches++
}
assert.equal(streamed, count)
console.log(`Streamed LAZ: ${streamed} points in ${batches} batches, identical to the whole-file decode`)

// A streamed cloud's LAZ export (core/lod/exportStream.js): the encoder's output is
// drained node by node; the assembled file decodes to the octree's points.
{
  const n = 160_000
  const p = new Float64Array(3 * n), cls = new Uint8Array(n)
  for (let i = 0; i < n; i++) { p[3*i] = 400000 + (i % 400) * 0.1; p[3*i+1] = 6000000 + Math.floor(i / 400) * 0.1; p[3*i+2] = 10 + (i % 13) * 0.01; cls[i] = i % 3 ? 2 : 6 }
  const files = new Map(), data = []; let size = 0
  const tmp = { async append(k, u8) { (files.get(k) ?? files.set(k, []).get(k)).push(u8) },
    async size(k) { return (files.get(k) ?? []).reduce((a, b) => a + b.length, 0) },
    async read(k, off, len) { let o = 0; for (const b of files.get(k)) { if (off < o + b.length) return b.subarray(off - o, off - o + len); o += b.length } return new Uint8Array(0) },
    async remove(k) { files.delete(k) } }
  const res = await buildLod({ count: n, bounds: { min: [400000, 6000000, 10], max: [400040, 6000040, 10.2] }, colour: false,
    attributes: [{ name: 'classification', type: 'uint8' }], async *batches() { yield { count: n, pos: p, attributes: { classification: cls } } } },
  tmp, { async write(u8) { const at = size; data.push(u8); size += u8.length; return at } }, { leafMax: 5000, layout: { offset: [400000, 6000000, 0], scale: [0.001, 0.001, 0.001] } })
  const { hierarchy, ...lod } = res
  const reader = await openLodReader(lod, { data: new Blob(data), hierarchy: new Blob([hierarchy]) })
  const encoder = new LazEncoder(2, lasPlanFor(lod, { extraBytes: false }).recordLength)
  let drains = 0
  const compressor = { push: (b) => encoder.push(b), drain: () => { const d = encoder.drain(); if (d.length) drains++; return d },
    finish: () => { const packed = encoder.finish(); const vlr = packed.vlr; return { vlr, data: packed.data() } } }
  const laz = lodToLas(reader, lod, { compressor })
  const parts = []
  for await (const part of laz.parts) parts.push(part)
  const { header, first, tail } = laz.lazEnds()
  const file = new Uint8Array(await new Blob([header, first, ...parts, tail]).arrayBuffer())
  const back = parseLaz(file, { decompress: decompress_points })
  assert.equal(back.count, n)
  assert.ok(drains > 1, 'the output was handed over as it grew')
  const want = new Set(); for (let i = 0; i < n; i++) want.add(`${Math.round(p[3*i]*1000)},${Math.round(p[3*i+1]*1000)},${Math.round(p[3*i+2]*1000)},${cls[i]}`)
  for (let k = 0; k < n; k++) assert.ok(want.has(`${Math.round(back.pos[3*k]*1000)},${Math.round(back.pos[3*k+1]*1000)},${Math.round(back.pos[3*k+2]*1000)},${back.attributes.classification[k]}`))
  console.log(`Streamed-cloud LAZ export: ${n} points, ${drains} drained parts, decodes to the octree's points`)
}

// Optional external LAZ/COPC files exercise the same dispatch and codec used
// by cloud import without committing large or private survey data as fixtures.
for (const path of process.argv.slice(2)) {
  const input = await readFile(path)
  const h = readLasHeader(input)
  const original = Buffer.from(input)
  const decoded = parseCloudFile(input, path, { lazDecompress: decompress_points })
  assert.equal(decoded.count, h.count)
  assert.deepEqual(input, original)
  const bounds = cloudStats(decoded).bbox
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength)
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(bounds.min[axis] - dv.getFloat64(187 + axis * 16, true)) <= h.scale[axis])
    assert.ok(Math.abs(bounds.max[axis] - dv.getFloat64(179 + axis * 16, true)) <= h.scale[axis])
  }
  for (const coordinate of decoded.pos) assert.ok(Number.isFinite(coordinate))
  console.log(`External LAZ import: ${path}, ${decoded.count} points, bounds match header`)
}
