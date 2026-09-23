import { describe, it, expect } from 'vitest'
import { cloudToLaz, parseLaz, LASZIP_VLR_RECORD_ID } from './laz.js'
import { cloudToLas, parseLas, readLasHeader } from './las.js'

// A stand-in for crates/lazcodec with the same contract: the point stream in, an
// opaque block + a VLR payload out. It is deliberately NOT a real coder — these
// tests pin the container (header bits, VLR directory, quantization agreement
// with the LAS writer), which is this module's whole job. The arithmetic coding
// itself is pinned by the crate's own round-trip test, which runs 200k points
// through several chunks.
function fakeCodec({ compressor = 2, footer = false } = {}) {
  return {
    compress(pointBytes, format, size) {
      const vlr = new Uint8Array([compressor, 0, format, size & 0xff, size >> 8])
      // "Compress" by prefixing a marker, so a writer that forgot to route the
      // bytes through the codec at all cannot pass.
      const start = compressor === 1 ? 0 : 8
      const table = start + 4 + pointBytes.length
      const data = new Uint8Array(table + (start ? 8 : 0) + (footer ? 8 : 0))
      data.set([0x4c, 0x41, 0x5a, 0x21], start)   // 'LAZ!'
      data.set(pointBytes, start + 4)
      if (start) {
        const view = new DataView(data.buffer)
        view.setBigInt64(0, footer ? -1n : BigInt(table), true)
        if (footer) view.setBigInt64(data.length - 8, BigInt(table), true)
      }
      return { vlr, data }
    },
    decompress(vlrData, compressed, count, size) {
      expect(vlrData[2]).toBe(2)                        // the format we wrote
      const start = compressor === 1 ? 0 : 8
      if (start) {
        const view = new DataView(compressed.buffer, compressed.byteOffset, compressed.byteLength)
        expect(view.getBigInt64(footer ? compressed.length - 8 : 0, true)).toBe(BigInt(start + 4 + count * size))
      }
      expect(String.fromCharCode(...compressed.subarray(start, start + 4))).toBe('LAZ!')
      return compressed.subarray(start + 4, start + 4 + count * size)
    },
  }
}

const cloud = {
  count: 4,
  pos: new Float64Array([
    0, 0, 0,
    10.5, -3.25, 7,
    -100.125, 55, 2.5,
    1000, 1000, 1000,
  ]),
  col: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128]),
}

describe('cloudToLaz', () => {
  it('writes a LAS 1.2 header with the LASzip high bit and the laszip VLR', () => {
    const codec = fakeCodec()
    const bytes = cloudToLaz(cloud, { compress: codec.compress })
    const h = readLasHeader(bytes)
    expect(h.isLaz).toBe(true)
    expect(h.formatRaw).toBe(2 | 0x80)
    expect(h.format).toBe(2)
    // The record length keeps describing the UNCOMPRESSED record — a reader needs
    // it to size its output buffer.
    expect(h.recordLength).toBe(26)
    expect(h.count).toBe(4)
    expect(h.vlrs.some((v) => v.recordId === LASZIP_VLR_RECORD_ID)).toBe(true)
  })

  it('quantizes identically to the LAS writer, so both dequantize the same', () => {
    const codec = fakeCodec()
    const las = readLasHeader(cloudToLas(cloud))
    const laz = readLasHeader(cloudToLaz(cloud, { compress: codec.compress }))
    expect(laz.scale).toEqual(las.scale)
    expect(laz.offset).toEqual(las.offset)
  })

  it('carries a CRS GeoKey VLR alongside the laszip VLR when given an EPSG code', () => {
    const codec = fakeCodec()
    const h = readLasHeader(cloudToLaz(cloud, { compress: codec.compress, crsCode: 3031 }))
    expect(h.vlrs.map((v) => v.recordId)).toEqual([34735, LASZIP_VLR_RECORD_ID])
  })

  it('refuses to write without a compressor rather than emitting plain LAS', () => {
    // The failure this prevents: a .laz file that is actually uncompressed, which
    // every reader rejects at the VLR rather than at the extension.
    expect(() => cloudToLaz(cloud, {})).toThrow(/no LAZ compressor/)
  })

  it('chunks the record build without changing the bytes', () => {
    // 4 points is far below LAZ_CHUNK_POINTS; a larger cloud crosses it. Both must
    // produce the same records as a single-shot build — the chunk loop is a memory
    // measure, not a format change.
    const n = 120_000
    const big = { count: n, pos: new Float64Array(n * 3), col: new Uint8Array(n * 3) }
    for (let i = 0; i < n; i++) {
      big.pos[i * 3] = i * 0.01; big.pos[i * 3 + 1] = -i * 0.02; big.pos[i * 3 + 2] = i % 97
      big.col[i * 3] = i & 0xff; big.col[i * 3 + 1] = (i >> 8) & 0xff; big.col[i * 3 + 2] = 7
    }
    const codec = fakeCodec()
    const laz = cloudToLaz(big, { compress: codec.compress })
    const back = parseLaz(laz, { decompress: codec.decompress })
    expect(back.count).toBe(n)
    // Spot-check across chunk boundaries (LAZ_CHUNK_POINTS = 50k).
    for (const i of [0, 49_999, 50_000, 99_999, 100_000, n - 1]) {
      expect(back.pos[i * 3]).toBeCloseTo(i * 0.01, 3)
      expect(back.pos[i * 3 + 1]).toBeCloseTo(-i * 0.02, 3)
    }
  })
})

describe('parseLaz', () => {
  it.each([2, 3])('relocates compressor %i file offsets without changing the input', (compressor) => {
    const codec = fakeCodec({ compressor })
    const bytes = cloudToLaz(cloud, { compress: codec.compress, crsCode: 3031 })
    const h = readLasHeader(bytes)
    const view = new DataView(bytes.buffer)
    expect(view.getBigInt64(h.offsetToPoints, true)).toBe(BigInt(bytes.length - 8))
    // Also exercise Uint8Array inputs with a nonzero byteOffset.
    const padded = new Uint8Array(bytes.length + 17)
    padded.set(bytes, 17)
    const input = padded.subarray(17)
    expect(parseLaz(input, { decompress: codec.decompress }).count).toBe(cloud.count)
    expect(input).toEqual(bytes)
  })

  it('relocates the EOF pointer from a non-seekable writer', () => {
    const codec = fakeCodec({ footer: true })
    const bytes = cloudToLaz(cloud, { compress: codec.compress })
    const view = new DataView(bytes.buffer)
    expect(view.getBigInt64(readLasHeader(bytes).offsetToPoints, true)).toBe(-1n)
    expect(view.getBigInt64(bytes.length - 8, true)).toBe(BigInt(bytes.length - 16))
    expect(parseLaz(bytes, { decompress: codec.decompress }).count).toBe(cloud.count)
  })

  it('leaves unchunked pointwise data untouched', () => {
    const codec = fakeCodec({ compressor: 1 })
    const bytes = cloudToLaz(cloud, { compress: codec.compress })
    expect(parseLaz(bytes, { decompress: codec.decompress }).count).toBe(cloud.count)
  })

  it('rejects an out-of-file chunk table before calling the decoder', () => {
    const codec = fakeCodec()
    const bytes = cloudToLaz(cloud, { compress: codec.compress })
    new DataView(bytes.buffer).setBigInt64(readLasHeader(bytes).offsetToPoints, BigInt(bytes.length), true)
    let called = false
    expect(() => parseLaz(bytes, { decompress: () => { called = true } })).toThrow(/chunk-table offset/)
    expect(called).toBe(false)
  })

  it('round-trips a cloud through the container', () => {
    const codec = fakeCodec()
    const bytes = cloudToLaz(cloud, { compress: codec.compress })
    const back = parseLaz(bytes, { decompress: codec.decompress })
    expect(back.count).toBe(4)
    for (let i = 0; i < 12; i++) expect(back.pos[i]).toBeCloseTo(cloud.pos[i], 3)
    expect(Array.from(back.col)).toEqual(Array.from(cloud.col))
  })

  it('rejects an uncompressed LAS instead of mis-reading it', () => {
    const codec = fakeCodec()
    expect(() => parseLaz(cloudToLas(cloud), { decompress: codec.decompress }))
      .toThrow(/uncompressed LAS/)
  })

  it('rejects a LAZ whose laszip VLR is missing', () => {
    const codec = fakeCodec()
    const bytes = cloudToLaz(cloud, { compress: codec.compress })
    // Blank the VLR record id, keeping the high bit set: the file still claims to
    // be compressed but no longer says how.
    const h = readLasHeader(bytes)
    const vp = h.headerSize + 18
    new DataView(bytes.buffer).setUint16(vp, 0, true)
    expect(() => parseLaz(bytes, { decompress: codec.decompress })).toThrow(/22204/)
  })

  it('refuses without a decompressor', () => {
    const codec = fakeCodec()
    const bytes = cloudToLaz(cloud, { compress: codec.compress })
    expect(() => parseLaz(bytes)).toThrow(/no LAZ decompressor/)
  })
})

describe('parseLas on a LAZ file', () => {
  it('points at the LAZ reader rather than silently misreading', () => {
    const codec = fakeCodec()
    const bytes = cloudToLaz(cloud, { compress: codec.compress })
    expect(() => parseLas(bytes)).toThrow(/LAZ/)
  })
})
