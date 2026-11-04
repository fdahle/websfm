import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import init from '../../wasm/lazcodec/lazcodec.js'
import { makeLazCodec } from '../../workers/ops/laz.js'
import { copcPlanFor, lodToCopc, memoryCopcSource } from './copcWrite.js'
import { readCopcFile, openCopcSource, readCopcMeta } from './copc.js'
import { readLasHeader } from '../io/las.js'

// The COPC writer through the real crates/lazcodec, read back by our own COPC reader
// (core/lod/copc.js). PDAL and laspy read the same files (CHANGELOG).
let codec
beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/lazcodec/lazcodec_bg.wasm', import.meta.url)
  await init({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
  codec = makeLazCodec()
})

function cloud(n, { colour = true } = {}) {
  let seed = 3
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const pos = new Float64Array(3 * n),
    col = colour ? new Uint8Array(3 * n) : null
  const classification = new Uint8Array(n),
    intensity = new Uint16Array(n),
    distance = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    pos[3 * i] = 500000 + rnd() * 200
    pos[3 * i + 1] = 5700000 + rnd() * 150
    pos[3 * i + 2] = 100 + rnd() * 20
    if (col) for (let k = 0; k < 3; k++) col[3 * i + k] = (i * (k + 3)) % 256
    classification[i] = i % 3 === 0 ? 2 : 1
    intensity[i] = i % 4000
    distance[i] = i / 7
  }
  return { count: n, pos, col, attributes: { classification, intensity, distance } }
}

async function writeCopc(c, opts = {}) {
  const { reader, lod } = memoryCopcSource(c, { leafMax: 2000, grid: 8 })
  const out = lodToCopc(reader, lod, { createEncoder: codec.createCopcEncoder, wkt: opts.wkt ?? null })
  const parts = []
  for await (const p of out.parts) parts.push(p)
  const { header, first, tail, evlr } = out.ends()
  const blob = new Blob([header, first, ...parts, tail, evlr])
  return { bytes: new Uint8Array(await blob.arrayBuffer()), lod, out }
}
const sourceOf = (bytes) => ({ size: bytes.length, read: async (a, b) => bytes.subarray(a, b) })

describe('copcPlanFor', () => {
  it('puts what fits in the standard fields and the rest in extra bytes', () => {
    const plan = copcPlanFor(
      [
        { name: 'classification', type: 'uint8' },
        { name: 'intensity', type: 'uint16' },
        { name: 'distance', type: 'float32' },
      ],
      { classification: { min: 0, max: 200 }, intensity: { min: 0, max: 9 }, distance: { min: 0, max: 1 } },
      true,
    )
    expect(plan).toMatchObject({ format: 7, recordLength: 40, native: ['classification', 'intensity'], dropped: [] })
    expect(plan.extra.map((e) => e.name)).toEqual(['distance'])
  })
})

describe('lodToCopc', () => {
  it('writes a COPC file whose every node our reader decodes back', async () => {
    const c = cloud(30000)
    const { bytes, lod } = await writeCopc(c, { wkt: 'PROJCS["WGS 84 / UTM zone 32N",AUTHORITY["EPSG","32632"]]' })
    const h = readLasHeader(bytes)
    expect([h.versionMajor, h.versionMinor, h.format, h.count]).toEqual([1, 4, 7, 30000])
    const file = await readCopcFile(sourceOf(bytes))
    expect(file.info.halfsize).toBeCloseTo(lod.root.size / 2, 9)
    expect(file.info.spacing).toBeCloseTo(lod.spacing, 12)
    expect(file.crs?.epsg).toBe('EPSG:32632')

    const meta = await readCopcMeta(sourceOf(bytes), { createChunkDecoder: codec.createChunkDecoder })
    const src = await openCopcSource(meta, sourceOf(bytes), { createChunkDecoder: codec.createChunkDecoder })
    expect(src.nodes.size).toBe(memoryCopcSource(c, { leafMax: 2000, grid: 8 }).reader.nodes.size)
    expect(src.nodes.size).toBeGreaterThan(8)
    // Every point back, to the quantisation step, with its colour and class.
    const { scale, offset } = lod.layout
    const q = (v, k) => Math.round((v - offset[k]) / scale[k])
    const key = (x, y, z) => `${q(x, 0)},${q(y, 1)},${q(z, 2)}`
    const want = new Map()
    for (let i = 0; i < c.count; i++)
      want.set(key(c.pos[3 * i], c.pos[3 * i + 1], c.pos[3 * i + 2]), [c.col[3 * i], c.attributes.classification[i]])
    let got = 0
    for (const node of src.nodes.values()) {
      const p = await src.read(node, { as: 'absolute' })
      const cube = src.cube(node)
      for (let i = 0; i < p.count; i++) {
        const [x, y, z] = [p.pos[3 * i], p.pos[3 * i + 1], p.pos[3 * i + 2]]
        // Inside its node's cube.
        expect(x).toBeGreaterThanOrEqual(cube.min[0] - 1e-6)
        expect(x).toBeLessThanOrEqual(cube.min[0] + cube.size + 1e-6)
        const w = want.get(key(x, y, z))
        expect(w).toBeTruthy()
        expect([p.col[3 * i], p.attributes.classification?.[i] ?? 0]).toEqual(w)
        got++
      }
    }
    expect(got).toBe(30000)
    src.close()
  })

  it('writes a cloud without colour as point format 6, its attribute ranges kept', async () => {
    const { bytes } = await writeCopc(cloud(5000, { colour: false }))
    const h = readLasHeader(bytes)
    expect(h.format).toBe(6)
    expect(h.vlrs[0].userId).toBe('copc')
    expect(h.vlrs.some((v) => v.userId === 'LASF_Spec' && v.recordId === 4)).toBe(true) // distance as extra bytes
  })
})
