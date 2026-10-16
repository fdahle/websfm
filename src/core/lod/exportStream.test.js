import { describe, it, expect } from 'vitest'
import { buildLod } from './build.js'
import { openLodReader } from './reader.js'
import { lodToLas, lodToText, lasPlanFor } from './exportStream.js'
import { parseLas } from '../io/las.js'

async function lodOf({ n, classMax = 6 }) {
  const pos = new Float64Array(3 * n), col = new Uint8Array(3 * n)
  const attrs = { intensity: new Uint16Array(n), classification: new Uint8Array(n), returnNumber: new Uint8Array(n), numberOfReturns: new Uint8Array(n) }
  for (let i = 0; i < n; i++) {
    pos[3 * i] = 650000 + (i % 400) * 0.25; pos[3 * i + 1] = 5100000 + Math.floor(i / 400) * 0.25; pos[3 * i + 2] = 300 + (i % 9) * 0.01
    col[3 * i] = i & 255; col[3 * i + 1] = (i >> 8) & 255; col[3 * i + 2] = 9
    attrs.intensity[i] = i & 0xffff; attrs.classification[i] = i % (classMax + 1); attrs.returnNumber[i] = 1 + (i % 2); attrs.numberOfReturns[i] = 2
  }
  const files = new Map(), data = []
  let size = 0
  const tmp = {
    async append(name, u8) { (files.get(name) ?? files.set(name, []).get(name)).push(u8) },
    async size(name) { return (files.get(name) ?? []).reduce((a, b) => a + b.length, 0) },
    async read(name, offset, length) {
      let o = 0
      for (const b of files.get(name)) { if (offset < o + b.length) return b.subarray(offset - o, offset - o + length); o += b.length }
      return new Uint8Array(0)
    },
    async remove(name) { files.delete(name) },
  }
  const out = { async write(u8) { const at = size; data.push(u8); size += u8.length; return at } }
  const res = await buildLod({
    count: n, bounds: { min: [650000, 5100000, 300], max: [650100, 5100000 + n / 400 * 0.25, 300.1] }, colour: true,
    attributes: Object.entries(attrs).map(([name, a]) => ({ name, type: a instanceof Uint16Array ? 'uint16' : 'uint8' })),
    async *batches() { yield { count: n, pos, col, attributes: attrs } },
  }, tmp, out, { leafMax: 3000, layout: { offset: [650000, 5100000, 0], scale: [0.01, 0.01, 0.01] } })
  const { hierarchy, ...lod } = res
  return { lod, reader: await openLodReader(lod, { data: new Blob(data), hierarchy: new Blob([hierarchy]) }), pos, col, attrs }
}

const key = (x, y, z) => `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`

describe('streamed cloud export', () => {
  it('writes a LAS that reads back to the same points, attributes and quantisation', async () => {
    const n = 40_000
    const { lod, reader, pos, col, attrs } = await lodOf({ n })
    const las = lodToLas(reader, lod)
    const parts = []
    for await (const p of las.parts) parts.push(p)
    const bytes = new Uint8Array(await new Blob([las.header(), ...parts]).arrayBuffer())
    const back = parseLas(bytes)
    expect(back.count).toBe(n)
    const want = new Map()
    for (let i = 0; i < n; i++) want.set(key(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]), i)
    let matched = 0
    for (let k = 0; k < n; k++) {
      const i = want.get(key(back.pos[3 * k], back.pos[3 * k + 1], back.pos[3 * k + 2]))
      if (i == null) continue
      if (back.attributes.classification[k] === attrs.classification[i] && back.attributes.intensity[k] === attrs.intensity[i]
          && back.col[3 * k] === col[3 * i] && back.attributes.returnNumber[k] === attrs.returnNumber[i]) matched++
    }
    expect(matched).toBe(n)
    const dv = new DataView(bytes.buffer)
    expect(dv.getFloat64(131, true)).toBe(0.01) // the octree's own scale
    expect(dv.getUint32(111, true) + dv.getUint32(115, true)).toBe(n) // points by return
  })

  it('puts a class over 31 into extra bytes rather than clamping it', async () => {
    const { lod, reader } = await lodOf({ n: 3000, classMax: 40 })
    expect(lasPlanFor(lod).extra.map((e) => e.name)).toEqual(['classification'])
    const las = lodToLas(reader, lod)
    const parts = []
    for await (const p of las.parts) parts.push(p)
    const back = parseLas(new Uint8Array(await new Blob([las.header(), ...parts]).arrayBuffer()))
    expect(Math.max(...back.attributes.classification)).toBe(40)
  })

  it('writes one PLY header for the whole cloud, and XYZ lines', async () => {
    const n = 20_000
    const { lod, reader } = await lodOf({ n })
    const ply = []
    for await (const p of lodToText(reader, lod, { format: 'ply' })) ply.push(p)
    const blob = new Blob(ply)
    const text = new TextDecoder().decode(new Uint8Array(await blob.slice(0, 600).arrayBuffer()))
    expect(text.match(/element vertex (\d+)/g)).toEqual([`element vertex ${n}`])
    const headerBytes = text.indexOf('end_header\n') + 'end_header\n'.length
    const stride = 12 + 3 + 2 + 1 + 1 + 1
    expect(blob.size - headerBytes).toBe(n * stride)
    const xyz = []
    for await (const p of lodToText(reader, lod, { format: 'xyz' })) xyz.push(p)
    expect(xyz.join('').trim().split('\n').length).toBe(n)
    const ascii = []
    for await (const p of lodToText(reader, lod, { format: 'ply-ascii' })) ascii.push(p)
    const lines = ascii.join('').split('\n')
    expect(lines.filter((l) => l.startsWith('element vertex'))).toEqual([`element vertex ${n}`])
    expect(lines.filter((l) => l === 'end_header')).toHaveLength(1)
    const body = lines.slice(lines.indexOf('end_header') + 1).filter(Boolean)
    expect(body).toHaveLength(n)
    expect(body[0].split(' ')).toHaveLength(3 + 3 + 4)
  })
})
