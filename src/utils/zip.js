// Minimal dependency-free ZIP writer (STORE method, no compression). Enough to
// bundle a handful of small text files (e.g. a COLMAP model's three .txt files)
// into one download. Pure: entries in → Uint8Array out; the UI wraps it in a Blob.
//
// entries: [{ name, data:Uint8Array }]. Returns the ZIP archive bytes.

export function zipStore(entries) {
  const enc = new TextEncoder()
  const files = entries.map((e) => {
    const nameBytes = enc.encode(e.name)
    return { nameBytes, data: e.data, crc: crc32(e.data) }
  })

  // Sum sizes to allocate once. Local header = 30 + name + data; central dir
  // header = 46 + name; end-of-central-directory = 22.
  let localSize = 0
  let centralSize = 0
  for (const f of files) {
    localSize += 30 + f.nameBytes.length + f.data.length
    centralSize += 46 + f.nameBytes.length
  }
  const out = new Uint8Array(localSize + centralSize + 22)
  const dv = new DataView(out.buffer)
  let off = 0
  const offsets = []

  for (const f of files) {
    offsets.push(off)
    dv.setUint32(off, 0x04034b50, true) // local file header signature
    dv.setUint16(off + 4, 20, true) // version needed
    dv.setUint16(off + 6, 0, true) // flags
    dv.setUint16(off + 8, 0, true) // compression: store
    dv.setUint16(off + 10, 0, true) // mod time
    dv.setUint16(off + 12, 0, true) // mod date
    dv.setUint32(off + 14, f.crc, true)
    dv.setUint32(off + 18, f.data.length, true) // compressed size
    dv.setUint32(off + 22, f.data.length, true) // uncompressed size
    dv.setUint16(off + 26, f.nameBytes.length, true)
    dv.setUint16(off + 28, 0, true) // extra length
    off += 30
    out.set(f.nameBytes, off); off += f.nameBytes.length
    out.set(f.data, off); off += f.data.length
  }

  const centralStart = off
  files.forEach((f, i) => {
    dv.setUint32(off, 0x02014b50, true) // central dir header signature
    dv.setUint16(off + 4, 20, true) // version made by
    dv.setUint16(off + 6, 20, true) // version needed
    dv.setUint16(off + 8, 0, true) // flags
    dv.setUint16(off + 10, 0, true) // compression
    dv.setUint16(off + 12, 0, true) // mod time
    dv.setUint16(off + 14, 0, true) // mod date
    dv.setUint32(off + 16, f.crc, true)
    dv.setUint32(off + 20, f.data.length, true)
    dv.setUint32(off + 24, f.data.length, true)
    dv.setUint16(off + 28, f.nameBytes.length, true)
    dv.setUint16(off + 30, 0, true) // extra length
    dv.setUint16(off + 32, 0, true) // comment length
    dv.setUint16(off + 34, 0, true) // disk number start
    dv.setUint16(off + 36, 0, true) // internal attrs
    dv.setUint32(off + 38, 0, true) // external attrs
    dv.setUint32(off + 42, offsets[i], true) // local header offset
    off += 46
    out.set(f.nameBytes, off); off += f.nameBytes.length
  })

  dv.setUint32(off, 0x06054b50, true) // end of central directory signature
  dv.setUint16(off + 4, 0, true) // disk number
  dv.setUint16(off + 6, 0, true) // disk with central dir
  dv.setUint16(off + 8, files.length, true) // entries on this disk
  dv.setUint16(off + 10, files.length, true) // total entries
  dv.setUint32(off + 12, off - centralStart, true) // central dir size
  dv.setUint32(off + 16, centralStart, true) // central dir offset
  dv.setUint16(off + 20, 0, true) // comment length

  return out
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

function crc32(buf) {
  let crc = ~0
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (~crc) >>> 0
}
