// Minimal dependency-free ZIP writer (STORE method, no compression). Two forms
// over the same records:
//   zipStore(entries)        — sync, Uint8Array in → Uint8Array out, for small sets.
//   await zipParts(entries)  — the export form: an entry's data may be a Blob (an
//     undistorted image, a source photo) or an iterable of string/Uint8Array parts
//     (core/io/parts.js), and the result is parts for `new Blob(parts)`. Nothing is
//     concatenated, so a multi-GB workspace never becomes one buffer.
// ZIP64 where needed (APPNOTE 4.5): an entry size or offset at or past 4 GiB, or more
// than 65,535 entries, gets the zip64 extra field and the zip64 end records; a small
// archive is plain ZIP (names flagged UTF-8, dated 1980-01-01). The record builders are exported for
// the project-file writer (utils/projectFile.js), and `readZipIndex` / `zipEntryBlob`
// read any archive through its central directory, zip64 included.

const U32_MAX = 0xffffffff
const U16_MAX = 0xffff

// entries: [{ name, data:Uint8Array }]. Returns the ZIP archive bytes.
export function zipStore(entries) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let off = 0
  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    const crc = crc32(e.data)
    const lh = zipLocalHeader(nameBytes, { crc, size: e.data.length })
    parts.push(lh, e.data)
    central.push(zipCentralHeader(nameBytes, { crc, size: e.data.length, offset: off }))
    off += lh.length + e.data.length
  }
  const all = [...parts, ...central, zipEndRecords(entries.length, off, central.reduce((n, h) => n + h.length, 0))]
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
    const lh = zipLocalHeader(nameBytes, { crc, size })
    out.push(lh, ...data)
    central.push(zipCentralHeader(nameBytes, { crc, size, offset: off }))
    off += lh.length + size
  }
  out.push(...central, zipEndRecords(entries.length, off, central.reduce((n, h) => n + h.length, 0)))
  return out
}

// A zip made one entry at a time, for an export whose entries are produced one by one
// and must never all be held (a 3D Tiles tileset of thousands of tiles): `add` returns
// the entry's parts (local header + data) for the caller to fold into a Blob as it
// goes, `finish` the central directory and end records. Same records as zipParts.
export function zipStream() {
  const enc = new TextEncoder()
  const central = []
  let off = 0, cdSize = 0
  return {
    add(name, data) {
      const bytes = typeof data === 'string' ? enc.encode(data) : data
      const nameBytes = enc.encode(name)
      const crc = crc32(bytes)
      const lh = zipLocalHeader(nameBytes, { crc, size: bytes.length })
      const ch = zipCentralHeader(nameBytes, { crc, size: bytes.length, offset: off })
      central.push(ch)
      cdSize += ch.length
      off += lh.length + bytes.length
      return [lh, bytes]
    },
    finish: () => [...central, zipEndRecords(central.length, off, cdSize)],
    get entries() { return central.length },
  }
}

function byteParts(data, enc) {
  if (data instanceof Uint8Array) return [data]
  if (typeof data === 'string') return [enc.encode(data)]
  return [...data].map((p) => (typeof p === 'string' ? enc.encode(p) : p))
}

// ── Records (zip64-aware) ────────────────────────────────────────────────────
// A size or offset at or past U32_MAX is written as 0xFFFFFFFF and carried in the
// zip64 extended-information extra field (id 0x0001); `zip64: true` forces the
// zip64 form for a small entry (tests). Method 0 = store, 8 = deflate.
const big = (v) => v >= U32_MAX

function zip64Extra(values) {
  const x = new Uint8Array(4 + 8 * values.length)
  const dv = new DataView(x.buffer)
  dv.setUint16(0, 0x0001, true)
  dv.setUint16(2, 8 * values.length, true)
  values.forEach((v, k) => dv.setBigUint64(4 + 8 * k, BigInt(v), true))
  return x
}

export function zipLocalHeader(nameBytes, { crc, size, compressedSize = size, method = 0, zip64 = false }) {
  const z = zip64 || big(size) || big(compressedSize)
  // In a local header the zip64 field holds both sizes, uncompressed first.
  const extra = z ? zip64Extra([size, compressedSize]) : new Uint8Array(0)
  const h = new Uint8Array(30 + nameBytes.length + extra.length)
  const dv = new DataView(h.buffer)
  dv.setUint32(0, 0x04034b50, true) // local file header signature
  dv.setUint16(4, z ? 45 : 20, true) // version needed
  dv.setUint16(6, 0x0800, true) // flags: UTF-8 names
  dv.setUint16(8, method, true)
  dv.setUint16(10, 0, true) // mod time
  dv.setUint16(12, 0x21, true) // mod date: 1980-01-01, not the invalid 0
  dv.setUint32(14, crc >>> 0, true)
  dv.setUint32(18, z ? U32_MAX : compressedSize, true)
  dv.setUint32(22, z ? U32_MAX : size, true)
  dv.setUint16(26, nameBytes.length, true)
  dv.setUint16(28, extra.length, true)
  h.set(nameBytes, 30)
  h.set(extra, 30 + nameBytes.length)
  return h
}

export function zipCentralHeader(nameBytes, { crc, size, compressedSize = size, offset, method = 0, zip64 = false }) {
  // Only the fields that overflow go into the zip64 field, in this order.
  const over = [zip64 || big(size), zip64 || big(compressedSize), zip64 || big(offset)]
  const values = [size, compressedSize, offset].filter((_, k) => over[k])
  const extra = values.length ? zip64Extra(values) : new Uint8Array(0)
  const h = new Uint8Array(46 + nameBytes.length + extra.length)
  const dv = new DataView(h.buffer)
  dv.setUint32(0, 0x02014b50, true) // central dir header signature
  dv.setUint16(4, values.length ? 45 : 20, true) // version made by
  dv.setUint16(6, values.length ? 45 : 20, true) // version needed
  dv.setUint16(8, 0x0800, true) // flags: UTF-8 names
  dv.setUint16(10, method, true)
  dv.setUint16(12, 0, true) // mod time
  dv.setUint16(14, 0x21, true) // mod date
  dv.setUint32(16, crc >>> 0, true)
  dv.setUint32(20, over[1] ? U32_MAX : compressedSize, true)
  dv.setUint32(24, over[0] ? U32_MAX : size, true)
  dv.setUint16(28, nameBytes.length, true)
  dv.setUint16(30, extra.length, true)
  dv.setUint16(32, 0, true) // comment length
  dv.setUint16(34, 0, true) // disk number start
  dv.setUint16(36, 0, true) // internal attrs
  dv.setUint32(38, 0, true) // external attrs
  dv.setUint32(42, over[2] ? U32_MAX : offset, true)
  h.set(nameBytes, 46)
  h.set(extra, 46 + nameBytes.length)
  return h
}

// The end of the archive: the zip64 end record and its locator when the entry count,
// the central directory's size or its offset overflow the classic fields, then the
// classic end record (its overflowing fields 0xFFFF / 0xFFFFFFFF).
export function zipEndRecords(count, cdOffset, cdSize, { zip64 = false } = {}) {
  const z = zip64 || count >= U16_MAX || big(cdOffset) || big(cdSize)
  const out = new Uint8Array((z ? 56 + 20 : 0) + 22)
  const dv = new DataView(out.buffer)
  let o = 0
  if (z) {
    dv.setUint32(0, 0x06064b50, true) // zip64 end of central directory record
    dv.setBigUint64(4, 44n, true) // size of the rest of this record
    dv.setUint16(12, 45, true); dv.setUint16(14, 45, true)
    dv.setUint32(16, 0, true); dv.setUint32(20, 0, true) // disk numbers
    dv.setBigUint64(24, BigInt(count), true); dv.setBigUint64(32, BigInt(count), true)
    dv.setBigUint64(40, BigInt(cdSize), true); dv.setBigUint64(48, BigInt(cdOffset), true)
    dv.setUint32(56, 0x07064b50, true) // zip64 end of central directory locator
    dv.setUint32(60, 0, true)
    dv.setBigUint64(64, BigInt(cdOffset + cdSize), true) // where the zip64 record starts
    dv.setUint32(72, 1, true) // total disks
    o = 76
  }
  dv.setUint32(o, 0x06054b50, true) // end of central directory signature
  dv.setUint16(o + 4, 0, true); dv.setUint16(o + 6, 0, true)
  dv.setUint16(o + 8, z ? U16_MAX : count, true)
  dv.setUint16(o + 10, z ? U16_MAX : count, true)
  dv.setUint32(o + 12, z ? U32_MAX : cdSize, true)
  dv.setUint32(o + 16, z ? U32_MAX : cdOffset, true)
  dv.setUint16(o + 20, 0, true) // comment length
  return out
}

// ── Reading by central directory ─────────────────────────────────────────────
// `readZipIndex(blob)` → [{ name, method, size, compressedSize, offset, crc }] from
// the end records and central directory (zip64 included), reading only the tail and
// the directory; `zipEntryBlob(blob, entry)` → the entry's bytes as a Blob (a slice
// of the archive for a stored entry, so a GB-sized entry is never read into memory).
export async function readZipIndex(blob) {
  const tailLen = Math.min(blob.size, 22 + 0xffff + 20)
  const tail = new Uint8Array(await blob.slice(blob.size - tailLen).arrayBuffer())
  const tv = new DataView(tail.buffer)
  let e = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { e = i; break }
  if (e < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)')
  let count = tv.getUint16(e + 10, true), cdSize = tv.getUint32(e + 12, true), cdOffset = tv.getUint32(e + 16, true)
  if (e >= 20 && tv.getUint32(e - 20, true) === 0x07064b50) {
    const recOff = Number(tv.getBigUint64(e - 12, true))
    const rec = new DataView(await blob.slice(recOff, recOff + 56).arrayBuffer())
    if (rec.getUint32(0, true) !== 0x06064b50) throw new Error('malformed ZIP64 end record')
    count = Number(rec.getBigUint64(32, true)); cdSize = Number(rec.getBigUint64(40, true)); cdOffset = Number(rec.getBigUint64(48, true))
  }
  const cd = new Uint8Array(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer())
  const dv = new DataView(cd.buffer)
  const dec = new TextDecoder()
  const entries = []
  let p = 0
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('malformed ZIP central directory')
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true)
    let compressedSize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true), offset = dv.getUint32(p + 42, true)
    // The zip64 field holds, in order, only the fields marked 0xFFFFFFFF.
    for (let x = p + 46 + nameLen; x + 4 <= p + 46 + nameLen + extraLen;) {
      const id = dv.getUint16(x, true), len = dv.getUint16(x + 2, true)
      if (id === 0x0001) {
        let q = x + 4
        if (size === U32_MAX) { size = Number(dv.getBigUint64(q, true)); q += 8 }
        if (compressedSize === U32_MAX) { compressedSize = Number(dv.getBigUint64(q, true)); q += 8 }
        if (offset === U32_MAX) { offset = Number(dv.getBigUint64(q, true)); q += 8 }
      }
      x += 4 + len
    }
    entries.push({ name: dec.decode(cd.subarray(p + 46, p + 46 + nameLen)), method: dv.getUint16(p + 10, true),
      crc: dv.getUint32(p + 16, true), size, compressedSize, offset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

export async function zipEntryBlob(blob, entry) {
  const lh = new DataView(await blob.slice(entry.offset, entry.offset + 30).arrayBuffer())
  if (lh.getUint32(0, true) !== 0x04034b50) throw new Error(`ZIP entry "${entry.name}": bad local header`)
  const start = entry.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true)
  const data = blob.slice(start, start + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method === 8) return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob()
  throw new Error(`ZIP entry "${entry.name}" uses compression method ${entry.method}`)
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
export function crc32Update(crc, buf) {
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return crc
}

// CRC-32 of a Blob, read a slice at a time.
export async function crc32Blob(blob, chunkBytes = 8 * 1024 * 1024) {
  let crc = ~0
  for (let off = 0; off < blob.size; off += chunkBytes) {
    crc = crc32Update(crc, new Uint8Array(await blob.slice(off, off + chunkBytes).arrayBuffer()))
  }
  return (~crc) >>> 0
}
