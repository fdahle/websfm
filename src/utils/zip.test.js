import { describe, it, expect } from 'vitest'
import { zipStore } from './zip.js'

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
