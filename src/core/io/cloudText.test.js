import { describe, it, expect } from 'vitest'
import { cloudToXyzParts, parseXyzText, parseXyzChunks } from './cloudText.js'
import { joinParts } from './parts.js'

// The writers yield bounded parts (core/io/parts.js); these join them for small fixtures.
const cloudToXyz = (...a) => joinParts(cloudToXyzParts(...a))

describe('cloudToXyz / parseXyzText', () => {
  it('round-trips a colored cloud through text', () => {
    const pts = [
      { x: 1.5, y: -2.25, z: 3.125, color: [10, 20, 30] },
      { x: 500000.5, y: 7100000.25, z: 812, color: [255, 0, 128] },
    ]
    const out = parseXyzText(cloudToXyz(pts))
    expect(out.count).toBe(2)
    expect(out.pos[0]).toBe(1.5)
    expect(out.pos[3]).toBe(500000.5)
    expect([...out.col]).toEqual([10, 20, 30, 255, 0, 128])
  })

  it('accepts the flat dense shape and omits color when asked', () => {
    const flat = { count: 1, pos: Float64Array.from([1, 2, 3]), col: Uint8Array.from([9, 8, 7]) }
    expect(cloudToXyz(flat, { color: false }).trim()).toBe('1 2 3')
    expect(cloudToXyz(flat).trim()).toBe('1 2 3 9 8 7')
  })

  it('sniffs comma-delimited input and skips header rows', () => {
    const text = 'x,y,z,r,g,b\n1,2,3,100,110,120\n4,5,6,10,20,30\n'
    const out = parseXyzText(text)
    expect(out.count).toBe(2)
    expect(out.skipped).toBe(1)
    expect(out.pos[4]).toBe(5)
    expect([...out.col.slice(3)]).toEqual([10, 20, 30])
  })

  it('detects 0–1 color range and scales to 0–255', () => {
    const out = parseXyzText('1 2 3 1.0 0.5 0.0\n4 5 6 0.0 0.25 1.0\n')
    expect([...out.col]).toEqual([255, 128, 0, 0, 64, 255])
  })

  it('takes the last 3 of 7 columns as color (x y z i r g b)', () => {
    const out = parseXyzText('1 2 3 999 10 20 30\n')
    expect(out.count).toBe(1)
    expect([...out.col]).toEqual([10, 20, 30])
  })

  it('emits no color when only some rows carry one', () => {
    const out = parseXyzText('1 2 3 10 20 30\n4 5 6\n')
    expect(out.count).toBe(2)
    expect(out.col).toBeUndefined()
  })
})

describe('parseXyzChunks — the streaming reader', () => {
  async function* chunksOf(bytes, size) { for (let o = 0; o < bytes.length; o += size) yield bytes.subarray(o, o + size) }
  const texts = {
    plain: '1 2 3\n4 5 6\n',
    crlfComma: 'x,y,z,r,g,b\r\n1,2,3,100,110,120\r\n4,5,6,10,20,30',
    tabs01: '# comment\n\n1\t2\t3\t0.5\t0.2\t0.1\n4\t5\t6\t1\t0\t0\n',
    mixed: '1 2 3 999 10 20 30\n1 2 3 7\nnot a row\n1 2\n1;2;3\n',
    bom: '﻿1 2 3 nan 4 5\n',
    multibyte: 'é 1 2 3\nñ 4 5 6\n1 2 3\n',
    empty: '',
  }
  const plain = (r) => JSON.parse(JSON.stringify(r, (k, v) => (ArrayBuffer.isView(v) ? [v.constructor.name, ...v] : v)))
  for (const [name, text] of Object.entries(texts)) {
    it(`${name}: identical to parseXyzText at any chunk size`, async () => {
      const bytes = new TextEncoder().encode(text)
      const whole = parseXyzText(new TextDecoder().decode(bytes))
      for (const size of [1, 2, 3, 7, 1 << 20]) {
        expect(plain(await parseXyzChunks(chunksOf(bytes, size)))).toEqual(plain(whole))
      }
    })
  }

  it('reads a written cloud back through the chunked path', async () => {
    const n = 3000
    const flat = { count: n, pos: Float64Array.from({ length: n * 3 }, (_, i) => i * 0.25 - 100), col: Uint8Array.from({ length: n * 3 }, (_, i) => i % 256) }
    const parts = [...cloudToXyzParts(flat, { partChars: 1000 })]
    expect(parts.length).toBeGreaterThan(10)
    const out = await parseXyzChunks(chunksOf(new TextEncoder().encode(parts.join('')), 4093))
    expect(out.count).toBe(n)
    expect([...out.pos]).toEqual([...flat.pos])
    expect([...out.col]).toEqual([...flat.col])
  })
})
