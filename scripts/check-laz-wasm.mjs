import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import init, { LazEncoder, decompress_points } from '../src/wasm/lazcodec/lazcodec.js'
import { cloudToLaz, parseLaz } from '../src/core/io/laz.js'
import { readLasHeader } from '../src/core/io/las.js'
import { parseCloudFile, cloudStats } from '../src/core/io/cloudImport.js'
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
