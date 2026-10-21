import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import init from '../../wasm/lazcodec/lazcodec.js'
import { makeLazCodec } from '../../workers/ops/laz.js'
import { cloudToLaz, parseLaz } from './laz.js'
import { cloudToLasParts, parseLas, readLasHeader } from './las.js'
import { openLasStream } from './lasStream.js'
import { joinParts } from './parts.js'

// The real crates/lazcodec through the worker's adapter: core/io/laz.test.js pins the
// container with a stand-in codec, this pins that the coded records come back.
let codec
beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/lazcodec/lazcodec_bg.wasm', import.meta.url)
  await init({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
  codec = makeLazCodec()
})

function cloud(n) {
  const pos = new Float64Array(3 * n),
    col = new Uint8Array(3 * n)
  const attributes = {
    intensity: new Uint16Array(n),
    classification: new Uint8Array(n),
    distance: new Float32Array(n),
    segment: new Int32Array(n),
    height: new Float64Array(n),
  }
  for (let i = 0; i < n; i++) {
    pos[3 * i] = 650000 + (i % 500) * 0.05
    pos[3 * i + 1] = 5100000 + Math.floor(i / 500) * 0.05
    pos[3 * i + 2] = 300 + Math.sin(i * 0.01)
    col[3 * i] = i & 255
    col[3 * i + 1] = 40
    col[3 * i + 2] = (i * 7) & 255
    attributes.intensity[i] = i & 0xffff
    attributes.classification[i] = i % 45 // > 31 ⇒ an extra-bytes field
    attributes.distance[i] = i % 97 === 0 ? NaN : Math.cos(i * 0.003) * 2.5
    attributes.segment[i] = (i % 13) - 6
    attributes.height[i] = 300 + i * 1e-4
  }
  return { count: n, pos, col, attributes }
}

const sameArray = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

describe('LAZ with extra bytes, real codec', () => {
  it('writes the LAS records exactly and reads every attribute back', () => {
    const c = cloud(130_001) // three LASzip chunks
    const logs = []
    const laz = joinParts(
      cloudToLaz(c, { createCompressor: codec.createCompressor, parts: true, onLog: (m, l) => logs.push([m, l]) }),
    )
    expect(logs.some(([, l]) => l === 'warn')).toBe(false)
    const las = joinParts(cloudToLasParts(c))
    const hz = readLasHeader(laz),
      hs = readLasHeader(las)
    expect(hz.recordLength).toBe(hs.recordLength)
    expect(hz.recordLength).toBe(26 + 1 + 4 + 4 + 8)
    expect(hz.extraBytes).toEqual(hs.extraBytes)
    const back = parseLaz(laz, { decompress: codec.decompress })
    const want = parseLas(las)
    expect(back.count).toBe(c.count)
    expect(sameArray(back.pos, want.pos)).toBe(true)
    expect(sameArray(back.col, want.col)).toBe(true)
    for (const k of Object.keys(c.attributes)) expect(sameArray(back.attributes[k], c.attributes[k]), k).toBe(true)
    expect(laz.length).toBeLessThan(las.length / 2)
  })

  it('streams a LAZ with extra bytes like the same LAS', async () => {
    const c = cloud(70_000)
    const laz = joinParts(cloudToLaz(c, { createCompressor: codec.createCompressor, parts: true }))
    const las = joinParts(cloudToLasParts(c))
    const source = (bytes) => ({
      size: bytes.length,
      async read(a, b) {
        return bytes.slice(a, b)
      },
    })
    const read = async (stream) => {
      const out = []
      for await (const b of stream.batches()) out.push(b)
      return out
    }
    const a = await read(
      await openLasStream(source(laz), { createLazDecoder: codec.createDecoder, batchPoints: 30_000 }),
    )
    const b = await read(await openLasStream(source(las), { batchPoints: 30_000 }))
    const cat = (bs, f) => bs.flatMap((x) => [...f(x)])
    expect(cat(a, (x) => x.pos)).toEqual(cat(b, (x) => x.pos))
    expect(cat(a, (x) => x.attributes.intensity)).toEqual(cat(b, (x) => x.attributes.intensity))
    expect(a.reduce((s, x) => s + x.count, 0)).toBe(70_000)
  })
})
