import { describe, it, expect } from 'vitest'
import { zipStore, zipParts, unzipStore, crc32, readZipIndex, zipEntryBlob, zipLocalHeader, zipCentralHeader, zipEndRecords } from './zip.js'

// Parse zipStore's own output structurally: signatures at the recorded offsets, name
// round-trip, CRC of known bytes, and the EOCD's central-directory size/offset. A
// malformed central directory only fails at import time in external tools, so a
// cheap self-parse is worthwhile insurance.

const enc = new TextEncoder()

describe('zipStore', () => {
  it('writes valid local/central/EOCD records with correct offsets and CRCs', () => {
    const entries = [
      { name: 'a.txt', data: enc.encode('hello') },
      { name: 'dir/b.txt', data: enc.encode('world!!') },
    ]
    const out = zipStore(entries)
    const dv = new DataView(out.buffer)
    const dec = new TextDecoder()

    // ── Local headers, in order ──
    let off = 0
    const localOffsets = []
    for (const e of entries) {
      localOffsets.push(off)
      expect(dv.getUint32(off, true)).toBe(0x04034b50) // local file header signature
      const nameLen = dv.getUint16(off + 26, true)
      expect(nameLen).toBe(enc.encode(e.name).length)
      const uncompressed = dv.getUint32(off + 22, true)
      expect(uncompressed).toBe(e.data.length)
      const name = dec.decode(out.subarray(off + 30, off + 30 + nameLen))
      expect(name).toBe(e.name)
      off += 30 + nameLen + e.data.length
    }

    // ── Central directory ──
    const centralStart = off
    entries.forEach((e, i) => {
      expect(dv.getUint32(off, true)).toBe(0x02014b50) // central dir header signature
      const nameLen = dv.getUint16(off + 28, true)
      expect(dv.getUint32(off + 42, true)).toBe(localOffsets[i]) // local header offset
      const name = dec.decode(out.subarray(off + 46, off + 46 + nameLen))
      expect(name).toBe(e.name)
      off += 46 + nameLen
    })

    // ── End of central directory ──
    expect(dv.getUint32(off, true)).toBe(0x06054b50) // EOCD signature
    expect(dv.getUint16(off + 10, true)).toBe(entries.length) // total entries
    expect(dv.getUint32(off + 12, true)).toBe(off - centralStart) // central dir size
    expect(dv.getUint32(off + 16, true)).toBe(centralStart) // central dir offset
    expect(off + 22).toBe(out.length) // no trailing bytes
  })

  it('computes the standard CRC-32 (CRC32 of "hello" = 0x3610a686)', () => {
    const out = zipStore([{ name: 'x', data: enc.encode('hello') }])
    const dv = new DataView(out.buffer)
    expect(dv.getUint32(14, true) >>> 0).toBe(0x3610a686) // local-header CRC field
  })

  it('produces an empty archive with a bare EOCD for no entries', () => {
    const out = zipStore([])
    expect(out.length).toBe(22)
    const dv = new DataView(out.buffer)
    expect(dv.getUint32(0, true)).toBe(0x06054b50)
    expect(dv.getUint16(10, true)).toBe(0) // total entries
  })
})

describe('unzipStore', () => {
  const dec = new TextDecoder()

  it('round-trips zipStore output (names + bytes)', () => {
    const entries = [
      { name: 'cameras.txt', data: enc.encode('1 PINHOLE 640 480 500 500 320 240\n') },
      { name: 'sub/points3D.txt', data: enc.encode('') }, // empty entry
      { name: 'images.txt', data: enc.encode('1 1 0 0 0 0 0 0 1 img.jpg\n\n') },
    ]
    const back = unzipStore(zipStore(entries))
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name))
    back.forEach((e, i) => expect(dec.decode(e.data)).toBe(dec.decode(entries[i].data)))
  })

  it('reads an archive that carries a trailing EOCD comment', () => {
    const zip = zipStore([{ name: 'a.txt', data: enc.encode('hi') }])
    const withComment = new Uint8Array(zip.length + 3)
    withComment.set(zip)
    // Bump the EOCD comment-length field so the reader must scan past the comment.
    new DataView(withComment.buffer).setUint16(zip.length - 2, 3, true)
    withComment.set(enc.encode('xyz'), zip.length)
    const back = unzipStore(withComment)
    expect(back).toHaveLength(1)
    expect(dec.decode(back[0].data)).toBe('hi')
  })

  it('throws on a non-ZIP buffer', () => {
    expect(() => unzipStore(enc.encode('not a zip'))).toThrow(/not a ZIP/)
  })
})

describe('zipParts — the streaming form', () => {
  const bytesOf = async (parts) => new Uint8Array(await new Blob(parts).arrayBuffer())
  const big = Uint8Array.from({ length: 20000 }, (_, i) => (i * 31) % 256)
  const reference = zipStore([
    { name: 'a.txt', data: enc.encode('hello') },
    { name: 'dir/b.bin', data: big },
    { name: 'ü.txt', data: new Uint8Array(0) },
  ])

  it('is byte-identical to zipStore for strings, part lists, generators and Blobs', async () => {
    const parts = await zipParts([
      { name: 'a.txt', data: 'hello' },
      { name: 'dir/b.bin', data: new Blob([big.subarray(0, 7), big.subarray(7)]) },
      { name: 'ü.txt', data: (function* () {})() },
    ])
    expect(await bytesOf(parts)).toEqual(reference)
    const again = await zipParts([
      { name: 'a.txt', data: ['he', enc.encode('llo')] },
      { name: 'dir/b.bin', data: new Blob([big]), crc: crc32(big) }, // CRC supplied: not re-read
      { name: 'ü.txt', data: [] },
    ])
    expect(await bytesOf(again)).toEqual(reference)
  })

  it('keeps a Blob entry as a Blob part (never read into one buffer)', async () => {
    const blob = new Blob([big])
    const parts = await zipParts([{ name: 'x', data: blob }])
    expect(parts).toContain(blob)
    expect(unzipStore(await bytesOf(parts))[0].data).toEqual(big)
  })

  it('writes ZIP64 end records past 65,535 entries, and reads them back', async () => {
    const many = Array.from({ length: 0x10001 }, (_, i) => ({ name: `f${i}`, data: Uint8Array.of(i & 0xff) }))
    const bytes = zipStore(many)
    const dv = new DataView(bytes.buffer)
    expect(dv.getUint32(bytes.length - 22, true)).toBe(0x06054b50)
    expect(dv.getUint16(bytes.length - 22 + 10, true)).toBe(0xffff)
    expect(dv.getUint32(bytes.length - 42, true)).toBe(0x07064b50) // the zip64 locator
    const index = await readZipIndex(new Blob([bytes]))
    expect(index.length).toBe(0x10001)
    expect(index[0x10000]).toMatchObject({ name: 'f65536', size: 1, method: 0 })
    expect([...new Uint8Array(await (await zipEntryBlob(new Blob([bytes]), index[300])).arrayBuffer())]).toEqual([300 & 0xff])
  })
})

describe('ZIP64 records and the index reader', () => {
  // A forced-zip64 archive of small entries (one stored, one deflated): every size
  // and offset goes through the zip64 fields, and the reader must find them there.
  async function forced() {
    const enc = new TextEncoder()
    const a = enc.encode('hello zip64'), json = enc.encode(JSON.stringify({ k: 'v'.repeat(500) }))
    const deflated = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
    const parts = [], central = []
    let off = 0
    for (const [name, data, size, method, crc] of [['a.txt', a, a.length, 0, crc32(a)], ['m.json', deflated, json.length, 8, crc32(json)]]) {
      const nb = enc.encode(name)
      const lh = zipLocalHeader(nb, { crc, size, compressedSize: data.length, method, zip64: true })
      parts.push(lh, data)
      central.push(zipCentralHeader(nb, { crc, size, compressedSize: data.length, offset: off, method, zip64: true }))
      off += lh.length + data.length
    }
    const cdSize = central.reduce((n, h) => n + h.length, 0)
    return { blob: new Blob([...parts, ...central, zipEndRecords(2, off, cdSize, { zip64: true })]), a, json }
  }

  it('reads sizes and offsets from the zip64 fields, stored and deflated', async () => {
    const { blob, a, json } = await forced()
    const index = await readZipIndex(blob)
    expect(index.map((e) => [e.name, e.size, e.method])).toEqual([['a.txt', a.length, 0], ['m.json', json.length, 8]])
    expect(new TextDecoder().decode(await (await zipEntryBlob(blob, index[0])).arrayBuffer())).toBe('hello zip64')
    expect(new Uint8Array(await (await zipEntryBlob(blob, index[1])).arrayBuffer())).toEqual(json)
  })

  it('reads plain archives written by zipParts', async () => {
    const parts = await zipParts([{ name: 'x/y.bin', data: Uint8Array.of(1, 2, 3) }, { name: 'z.txt', data: 'zz' }])
    const blob = new Blob(parts)
    const index = await readZipIndex(blob)
    expect(index.map((e) => e.name)).toEqual(['x/y.bin', 'z.txt'])
    expect([...new Uint8Array(await (await zipEntryBlob(blob, index[0])).arrayBuffer())]).toEqual([1, 2, 3])
  })
})
