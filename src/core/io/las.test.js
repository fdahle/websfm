import { describe, it, expect } from 'vitest'
import { cloudToLas, parseLas } from './las.js'

// Survey-scale coordinates (UTM-ish) so the scale/offset quantization is exercised
// where it matters.
const PTS = [
  { x: 500000.123, y: 7100000.456, z: 812.789, color: [10, 200, 30] },
  { x: 500123.987, y: 7100456.321, z: 640.5, color: [255, 0, 128] },
  { x: 500250.5, y: 7100250.25, z: 700.0, color: [0, 0, 0] },
]

describe('cloudToLas (LAS 1.2 writer)', () => {
  it('writes spec-correct header fields', () => {
    const las = cloudToLas(PTS)
    const dv = new DataView(las.buffer)
    expect(String.fromCharCode(las[0], las[1], las[2], las[3])).toBe('LASF')
    expect(las[24]).toBe(1) // version major
    expect(las[25]).toBe(2) // version minor
    expect(dv.getUint16(94, true)).toBe(227)  // header size
    expect(dv.getUint32(96, true)).toBe(227)  // offset to points (no VLR)
    expect(dv.getUint32(100, true)).toBe(0)   // VLR count
    expect(las[104]).toBe(2)                  // point format 2
    expect(dv.getUint16(105, true)).toBe(26)  // record length
    expect(dv.getUint32(107, true)).toBe(3)   // legacy point count
    expect(dv.getUint32(111, true)).toBe(3)   // points by return[0]
    // Real-world bbox: max x at 179, min x at 187.
    expect(dv.getFloat64(179, true)).toBeCloseTo(500250.5, 6)
    expect(dv.getFloat64(187, true)).toBeCloseTo(500000.123, 6)
    expect(dv.getFloat64(219, true)).toBeCloseTo(640.5, 6) // min z
    expect(las.length).toBe(227 + 3 * 26)
  })

  it('writes a GeoKeyDirectory VLR when an EPSG code is given', () => {
    const las = cloudToLas(PTS, { crsCode: 32633 })
    const dv = new DataView(las.buffer)
    expect(dv.getUint32(100, true)).toBe(1) // one VLR
    const off = dv.getUint32(96, true)
    expect(off).toBeGreaterThan(227)
    // VLR header at 227: user id + record id 34735.
    const userId = new TextDecoder().decode(las.slice(229, 229 + 15))
    expect(userId).toBe('LASF_Projection')
    expect(dv.getUint16(227 + 18, true)).toBe(34735)
    // GeoKey directory body: version header then a 3072 (ProjectedCSType) key = 32633.
    const bodyOff = 227 + 54
    expect(dv.getUint16(bodyOff, true)).toBe(1)
    const nKeys = dv.getUint16(bodyOff + 6, true)
    const keys = []
    for (let i = 0; i < nKeys; i++) {
      keys.push([0, 1, 2, 3].map((j) => dv.getUint16(bodyOff + 8 + i * 8 + j * 2, true)))
    }
    expect(keys).toContainEqual([3072, 0, 1, 32633])
  })

  it('round-trips coordinates within the scale quantum and colors exactly', () => {
    const las = cloudToLas(PTS, { crsCode: 4326, geographic: true })
    const dv = new DataView(las.buffer)
    const scaleX = dv.getFloat64(131, true)
    const out = parseLas(las)
    expect(out.count).toBe(3)
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(out.pos[i * 3] - PTS[i].x)).toBeLessThanOrEqual(scaleX / 2 + 1e-9)
      expect(Math.abs(out.pos[i * 3 + 2] - PTS[i].z)).toBeLessThanOrEqual(1e-4 / 2 + 1e-9)
      expect([out.col[i * 3], out.col[i * 3 + 1], out.col[i * 3 + 2]]).toEqual(PTS[i].color)
    }
    // mm-ish precision floor on survey coords
    expect(scaleX).toBeLessThan(1e-3)
  })

  it('accepts the flat dense shape', () => {
    const flat = {
      count: 2,
      pos: Float32Array.from([1, 2, 3, 4, 5, 6]),
      col: Uint8Array.from([9, 8, 7, 6, 5, 4]),
    }
    const out = parseLas(cloudToLas(flat))
    expect(out.count).toBe(2)
    expect(out.pos[3]).toBeCloseTo(4, 3)
    expect([...out.col]).toEqual([9, 8, 7, 6, 5, 4])
  })

  it('writes colorless clouds with a neutral gray', () => {
    const out = parseLas(cloudToLas({ count: 1, pos: Float64Array.from([1, 2, 3]) }))
    expect([out.col[0], out.col[1], out.col[2]]).toEqual([200, 200, 200])
  })
})

describe('parseLas (reader)', () => {
  it('honors the header record length over the format stride (format 3 fixture)', () => {
    // Hand-built 1.2 fixture: point format 3 (xyz + intensity + flags + GPS f64 +
    // RGB), record length padded to 40 bytes — the reader must step by the header
    // value, not a per-format constant.
    const RECORD = 40
    const buf = new Uint8Array(227 + 2 * RECORD)
    const dv = new DataView(buf.buffer)
    buf.set([0x4c, 0x41, 0x53, 0x46], 0) // LASF
    buf[24] = 1; buf[25] = 2
    dv.setUint16(94, 227, true)
    dv.setUint32(96, 227, true)
    buf[104] = 3
    dv.setUint16(105, RECORD, true)
    dv.setUint32(107, 2, true)
    dv.setFloat64(131, 0.01, true); dv.setFloat64(139, 0.01, true); dv.setFloat64(147, 0.01, true)
    dv.setFloat64(155, 100, true); dv.setFloat64(163, 200, true); dv.setFloat64(171, 300, true)
    for (let i = 0; i < 2; i++) {
      const p = 227 + i * RECORD
      dv.setInt32(p, 1000 * (i + 1), true)      // x = 100 + 10(i+1)
      dv.setInt32(p + 4, 2000 * (i + 1), true)  // y = 200 + 20(i+1)
      dv.setInt32(p + 8, 50, true)              // z = 300.5
      dv.setUint16(p + 28, (40 + i) << 8, true) // R (format 3: after GPS time at 20)
      dv.setUint16(p + 30, 50 << 8, true)
      dv.setUint16(p + 32, 60 << 8, true)
    }
    const out = parseLas(buf)
    expect(out.count).toBe(2)
    expect(out.pos[0]).toBeCloseTo(110, 9)
    expect(out.pos[3]).toBeCloseTo(120, 9)
    expect(out.pos[4]).toBeCloseTo(240, 9)
    expect(out.pos[5]).toBeCloseTo(300.5, 9)
    expect(out.col[0]).toBe(40)
    expect(out.col[3]).toBe(41)
    expect(out.col[5]).toBe(60)
  })

  it('rejects LAZ (high bit on the point format) with a clear error', () => {
    const las = cloudToLas(PTS)
    las[104] |= 0x80
    expect(() => parseLas(las)).toThrow(/LAZ/)
  })

  it('rejects non-LAS bytes', () => {
    expect(() => parseLas(new TextEncoder().encode('ply\nnot a las file at all — needs some length padding here'))).toThrow(/LASF/)
  })

  it('reads a colorless format (0) without a col buffer', () => {
    // Rewrite the writer output down to format 0 (20-byte records, xyz only).
    const src = cloudToLas(PTS)
    const sdv = new DataView(src.buffer)
    const RECORD = 20
    const buf = new Uint8Array(227 + 3 * RECORD)
    buf.set(src.slice(0, 227), 0)
    const dv = new DataView(buf.buffer)
    buf[104] = 0
    dv.setUint16(105, RECORD, true)
    for (let i = 0; i < 3; i++) {
      buf.set(src.slice(227 + i * 26, 227 + i * 26 + RECORD), 227 + i * RECORD)
    }
    const out = parseLas(buf)
    expect(out.count).toBe(3)
    expect(out.col).toBeUndefined()
    expect(Math.abs(out.pos[0] - PTS[0].x)).toBeLessThan(sdv.getFloat64(131, true))
  })
})

describe('untrusted LAS headers', () => {
  it.each([
    [105, 0, 16, 'record length'],
    [105, 12, 16, 'record length'],
    [94, 10, 16, 'header'],
    [96, 999999, 32, 'offset'],
    [100, 999999, 32, 'VLR count'],
  ])('rejects malformed field at %i', (offset, value, bits, message) => {
    const bytes = cloudToLas(PTS)
    const view = new DataView(bytes.buffer)
    view[`setUint${bits}`](offset, value, true)
    expect(() => parseLas(bytes)).toThrow(message)
  })
  it('rejects a VLR payload extending into the point records', () => {
    const bytes = cloudToLas(PTS, { crsCode: 3031 })
    new DataView(bytes.buffer).setUint16(227 + 20, 65535, true)
    expect(() => parseLas(bytes)).toThrow('VLR payload')
  })
})
