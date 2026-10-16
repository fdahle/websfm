import { describe, it, expect } from 'vitest'
import { openLasStream, STREAM_ATTRIBUTES } from './lasStream.js'
import { cloudToLasParts, parseLas } from './las.js'
import { joinParts } from './parts.js'

const bytesSource = (bytes) => ({ size: bytes.length, async read(a, b) { return bytes.slice(a, b) } })

function cloud(n, { colour = true } = {}) {
  const pos = new Float64Array(3 * n), col = colour ? new Uint8Array(3 * n) : null
  const classification = new Uint8Array(n), intensity = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    pos[3 * i] = 650000 + (i % 1000) * 0.05; pos[3 * i + 1] = 5100000 + Math.floor(i / 1000) * 0.05; pos[3 * i + 2] = 300 + (i % 7)
    if (col) { col[3 * i] = i & 255; col[3 * i + 1] = 40; col[3 * i + 2] = 200 }
    classification[i] = i % 3 ? 2 : 6; intensity[i] = i & 0xffff
  }
  return { count: n, pos, col, attributes: { classification, intensity } }
}

async function readAll(stream) {
  const parts = []
  for await (const b of stream.batches()) parts.push(b)
  return parts
}

describe('LAS as a stream of batches', () => {
  it('yields every point in bounded batches, as the whole-file parser reads them', async () => {
    const c = cloud(25_000)
    const bytes = joinParts(cloudToLasParts(c))
    const stream = await openLasStream(bytesSource(bytes), { batchPoints: 8000 })
    expect(stream.count).toBe(25_000)
    expect(stream.colour).toBe(true)
    expect(stream.attributes).toEqual(STREAM_ATTRIBUTES)
    const whole = parseLas(bytes)
    const batches = await readAll(stream)
    expect(batches.map((b) => b.count)).toEqual([8000, 8000, 8000, 1000])
    let i = 0
    for (const b of batches) {
      for (let k = 0; k < b.count; k++, i++) {
        expect(b.pos[3 * k]).toBe(whole.pos[3 * i])
        expect(b.pos[3 * k + 2]).toBe(whole.pos[3 * i + 2])
        expect(b.col[3 * k]).toBe(whole.col[3 * i])
        expect(b.attributes.classification[k]).toBe(whole.attributes.classification[i])
      }
    }
    // The header's extent (a quantum wider) contains every point.
    for (let k = 0; k < 3; k++) {
      expect(stream.bounds.min[k]).toBeLessThanOrEqual(650000 * (k === 0) + 5100000 * (k === 1) + 300 * (k === 2))
    }
    expect(stream.layout.scale.every((s) => s > 0)).toBe(true)
  })

  it('decides 8-bit colour for the whole file, not per batch', async () => {
    // Colour words 0–255 in a 16-bit field: a batch that happens to be dark must
    // still read as 8-bit, as the whole file does.
    const c = cloud(20_000)
    const bytes = joinParts(cloudToLasParts(c))
    // The writer stores 8-bit colour as 16-bit (×257): rewrite the words to raw 0–255.
    const view = new DataView(bytes.buffer)
    const at = view.getUint32(96, true), size = view.getUint16(105, true)
    for (let i = 0; i < 20_000; i++) for (let k = 0; k < 3; k++) {
      const p = at + i * size + 20 + 2 * k
      view.setUint16(p, i < 10_000 ? 3 : c.col[3 * i + k], true) // first half nearly black
    }
    const batches = await readAll(await openLasStream(bytesSource(bytes), { batchPoints: 10_000 }))
    expect(batches[0].col[0]).toBe(3) // not 3 >> 8 = 0
    expect(batches[1].col[3]).toBe(c.col[3 * 10_001])
  })

  it('a colour format with no colour in it streams without colour', async () => {
    const c = cloud(5000)
    c.col.fill(0)
    const logs = []
    const stream = await openLasStream(bytesSource(joinParts(cloudToLasParts(c))), { onLog: (m) => logs.push(m) })
    expect(stream.colour).toBe(false)
    expect((await readAll(stream))[0].col).toBe(null)
    expect(logs.join()).toMatch(/colour fields are empty/)
  })

  it('measures the extent when the header has none', async () => {
    const c = cloud(3000)
    const bytes = joinParts(cloudToLasParts(c))
    const view = new DataView(bytes.buffer)
    for (let o = 179; o < 227; o += 8) view.setFloat64(o, 0, true)
    const logs = []
    const stream = await openLasStream(bytesSource(bytes), { onLog: (m) => logs.push(m) })
    expect(logs.join()).toMatch(/no usable extent/)
    expect(stream.bounds.min[0]).toBeCloseTo(650000, 3)
    expect(stream.bounds.max[2]).toBeCloseTo(306, 3)
  })
})

describe('when a LAS/LAZ import streams', () => {
  it('streams exactly when the whole-file import would pass its memory limit', async () => {
    const { lasNeedsStreaming } = await import('./lasStream.js')
    const bytes = joinParts(cloudToLasParts(cloud(100)))
    expect(lasNeedsStreaming(bytes, bytes.length)).toBe(false)
    // Claim 40 M points in the header: 40 M × (2 × 26 + 64) B is past the 1 GiB limit.
    const big = bytes.slice()
    new DataView(big.buffer).setUint32(107, 40_000_000, true)
    expect(lasNeedsStreaming(big, big.length)).toBe(true)
    expect(lasNeedsStreaming(new Uint8Array(200), 200)).toBe(null)
  })
})
