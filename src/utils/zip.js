// Minimal dependency-free ZIP writer (STORE method, no compression). Two forms
// over the same records:
//   zipStore(entries)        — sync, Uint8Array in → Uint8Array out, for small sets.
//   await zipParts(entries)  — the export form: an entry's data may be a Blob (an
//     undistorted image, a source photo) or an iterable of string/Uint8Array parts
//     (core/io/parts.js), and the result is parts for `new Blob(parts)`. Nothing is
//     concatenated, so a multi-GB workspace never becomes one buffer.
// Plain ZIP, not ZIP64: sizes and offsets are u32 and the entry count u16, so both
// forms refuse an archive past those limits instead of writing a corrupt one.

const U32_MAX = 0xffffffff

// entries: [{ name, data:Uint8Array }]. Returns the ZIP archive bytes.
export function zipStore(entries) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let off = 0
  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    const crc = crc32(e.data)
    checkZipLimits(off, e.data.length, entries.length)
    parts.push(localHeader(nameBytes, crc, e.data.length), e.data)
    central.push(centralHeader(nameBytes, crc, e.data.length, off))
    off += 30 + nameBytes.length + e.data.length
  }
  const all = [...parts, ...central, endRecord(entries.length, central, off)]
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of all) { out.set(p, o); o += p.length }
  return out
}

// entries: [{ name, data, crc? }] — data a Uint8Array, a string (UTF-8), a Blob,
// or an iterable of string/Uint8Array parts. `crc` skips re-reading data whose
// CRC-32 the caller already has (a Blob it computed while it held the bytes).
export async function zipParts(entries) {
  const enc = new TextEncoder()
  const out = []
  const central = []
  let off = 0
  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    let data, size, crc
    if (typeof Blob !== 'undefined' && e.data instanceof Blob) {
      data = [e.data]; size = e.data.size
      crc = e.crc ?? await crc32Blob(e.data)
    } else {
      data = byteParts(e.data, enc)
      size = data.reduce((s, p) => s + p.length, 0)
      crc = e.crc ?? data.reduce((c, p) => crc32Update(c, p), ~0) ^ ~0
    }
    crc >>>= 0
    checkZipLimits(off, size, entries.length)
    out.push(localHeader(nameBytes, crc, size), ...data)
    central.push(centralHeader(nameBytes, crc, size, off))
    off += 30 + nameBytes.length + size
  }
  out.push(...central, endRecord(entries.length, central, off))
  return out
}

function byteParts(data, enc) {
  if (data instanceof Uint8Array) return [data]
  if (typeof data === 'string') return [enc.encode(data)]
  return [...data].map((p) => (typeof p === 'string' ? enc.encode(p) : p))
}

function checkZipLimits(offset, size, count) {
  if (count > 0xffff || size > U32_MAX || offset + size > U32_MAX) {
    throw new Error('Export exceeds the 4 GB / 65,535-entry ZIP limit (no ZIP64 writer). '
      + 'Export fewer images or a smaller model, or lower the output resolution.')
  }
}

function localHeader(nameBytes, crc, size) {
  const h = new Uint8Array(30 + nameBytes.length)
  const dv = new DataView(h.buffer)
  dv.setUint32(0, 0x04034b50, true) // local file header signature
  dv.setUint16(4, 20, true) // version needed
  dv.setUint16(6, 0, true) // flags
  dv.setUint16(8, 0, true) // compression: store
  dv.setUint16(10, 0, true) // mod time
  dv.setUint16(12, 0, true) // mod date
  dv.setUint32(14, crc, true)
  dv.setUint32(18, size, true) // compressed size
  dv.setUint32(22, size, true) // uncompressed size
  dv.setUint16(26, nameBytes.length, true)
  dv.setUint16(28, 0, true) // extra length
  h.set(nameBytes, 30)
  return h
}

function centralHeader(nameBytes, crc, size, localOffset) {
  const h = new Uint8Array(46 + nameBytes.length)
  const dv = new DataView(h.buffer)
  dv.setUint32(0, 0x02014b50, true) // central dir header signature
  dv.setUint16(4, 20, true) // version made by
  dv.setUint16(6, 20, true) // version needed
  dv.setUint16(8, 0, true) // flags
  dv.setUint16(10, 0, true) // compression
  dv.setUint16(12, 0, true) // mod time
  dv.setUint16(14, 0, true) // mod date
  dv.setUint32(16, crc, true)
  dv.setUint32(20, size, true)
  dv.setUint32(24, size, true)
  dv.setUint16(28, nameBytes.length, true)
  dv.setUint16(30, 0, true) // extra length
  dv.setUint16(32, 0, true) // comment length
  dv.setUint16(34, 0, true) // disk number start
  dv.setUint16(36, 0, true) // internal attrs
  dv.setUint32(38, 0, true) // external attrs
  dv.setUint32(42, localOffset, true) // local header offset
  h.set(nameBytes, 46)
  return h
}

function endRecord(count, central, centralStart) {
  const centralSize = central.reduce((s, h) => s + h.length, 0)
  if (centralStart + centralSize > U32_MAX) checkZipLimits(U32_MAX, 1, count)
  const h = new Uint8Array(22)
  const dv = new DataView(h.buffer)
  dv.setUint32(0, 0x06054b50, true) // end of central directory signature
  dv.setUint16(4, 0, true) // disk number
  dv.setUint16(6, 0, true) // disk with central dir
  dv.setUint16(8, count, true) // entries on this disk
  dv.setUint16(10, count, true) // total entries
  dv.setUint32(12, centralSize, true) // central dir size
  dv.setUint32(16, centralStart, true) // central dir offset
  dv.setUint16(20, 0, true) // comment length
  return h
}

// Read a ZIP archive (STORE method only — the inverse of zipStore, enough for a
// COLMAP model's .txt set). Returns [{ name, data:Uint8Array }]. Locates entries via
// the End-Of-Central-Directory record + central directory, so it reads archives from
// any writer (not just zipStore). Throws with an actionable message on a compressed
// entry (method ≠ 0) or a malformed archive.
export function unzipStore(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const dec = new TextDecoder()

  // EOCD (0x06054b50) sits at the end but a trailing comment makes its offset
  // variable — scan backwards for the signature.
  let eocd = -1
  for (let i = u8.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('unzip: not a ZIP archive (no end-of-central-directory record)')

  const count = dv.getUint16(eocd + 10, true)
  let cd = dv.getUint32(eocd + 16, true) // central-directory start offset
  const out = []
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(cd, true) !== 0x02014b50) throw new Error('unzip: malformed central directory')
    const method = dv.getUint16(cd + 10, true)
    const compSize = dv.getUint32(cd + 20, true)
    const nameLen = dv.getUint16(cd + 28, true)
    const extraLen = dv.getUint16(cd + 30, true)
    const commentLen = dv.getUint16(cd + 32, true)
    const localOff = dv.getUint32(cd + 42, true)
    const name = dec.decode(u8.subarray(cd + 46, cd + 46 + nameLen))
    if (method !== 0) {
      throw new Error(`unzip: entry "${name}" uses compression method ${method}; only STORE (0) is supported`)
    }
    // Data begins after the local header, whose name/extra lengths can differ from
    // the central directory's — read them from the local header itself.
    const lNameLen = dv.getUint16(localOff + 26, true)
    const lExtraLen = dv.getUint16(localOff + 28, true)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    out.push({ name, data: new Uint8Array(u8.subarray(dataStart, dataStart + compSize)) })
    cd += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf) {
  return (~crc32Update(~0, buf)) >>> 0
}

// The running (un-finalized) CRC after `buf`; start from ~0, finish with ~crc >>> 0.
function crc32Update(crc, buf) {
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return crc
}

// CRC-32 of a Blob, read a slice at a time.
async function crc32Blob(blob, chunkBytes = 8 * 1024 * 1024) {
  let crc = ~0
  for (let off = 0; off < blob.size; off += chunkBytes) {
    crc = crc32Update(crc, new Uint8Array(await blob.slice(off, off + chunkBytes).arrayBuffer()))
  }
  return (~crc) >>> 0
}
