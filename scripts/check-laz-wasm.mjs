import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import init, { LazEncoder, decompress_points } from '../src/wasm/lazcodec/lazcodec.js'
import { cloudToLaz, parseLaz } from '../src/core/io/laz.js'
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
const cloud = parseLaz(bytes, { decompress: decompress_points })
assert.equal(chunks, 3)
assert.equal(cloud.count, count)
for (let i = 0; i < pos.length; i++) assert.ok(Math.abs(pos[i] - cloud.pos[i]) < 0.000051)
console.log(`Built LAZ WASM round-trip: ${count} survey-coordinate points, ${chunks} bounded input chunks`)
