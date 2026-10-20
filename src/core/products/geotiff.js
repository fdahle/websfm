// Minimal, dependency-free GeoTIFF writer + the GeoTIFF georeferencing tags.
// Two writers share the tag machinery:
//   writeGeoTiff — baseline (little-endian, uncompressed, single strip), the
//                  export path: a 1-band float DEM or an RGBA orthophoto.
//   writeCog     — internally tiled with reduced-resolution overviews, the
//                  storage path for imported reference rasters (see below).
//
// Little-endian only (all target platforms are). The caller hands raw interleaved
// pixel bytes already in LE sample order; we don't transcode.
//
// spec:
//   width, height
//   samples: [{ bits, format }]   // format: 1=uint, 2=int, 3=float
//   photometric: 1 (BlackIsZero / grayscale) | 2 (RGB)
//   extraSamples: number[] | null // e.g. [2] = unassociated alpha (RGBA)
//   data: Uint8Array              // strip bytes (raw, or already-compressed), row-major
//   pixelScale: [sx, sy, sz]      // ModelPixelScaleTag
//   tiepoint: [i, j, k, X, Y, Z]  // ModelTiepointTag (pixel → world)
//   geoKeys: [[keyId, loc, count, value], ...]  // GeoKeyDirectory entries
//   gdalNoData?: string           // GDAL_NODATA tag
//   compression?: number          // TIFF Compression tag (1 = none, 8 = Adobe DEFLATE).
//                                  // The writer stays sync: when 8, `data` must ALREADY be
//                                  // zlib-deflated by the caller (CompressionStream lives in
//                                  // the DOM/worker layer, not this pure path).

const TYPE = { SHORT: 3, LONG: 4, DOUBLE: 12, ASCII: 2 }

function shortArrayBytes(vals) {
  const b = new Uint8Array(vals.length * 2)
  const dv = new DataView(b.buffer)
  vals.forEach((v, i) => dv.setUint16(i * 2, v, true))
  return b
}
// An ASCII tag (GDAL_NODATA): inline when it fits the 4-byte value field, else an
// external block. A reader takes a value of count·size ≤ 4 from the field itself, so
// writing "255\0" (4 bytes) as an offset made every reader see the offset's bytes as
// the nodata value (found 2026-10-20: "255" and "12" read back as NaN).
function asciiTag(entries, extern, tag, text) {
  const bytes = new TextEncoder().encode(text + '\0')
  if (bytes.length <= 4) entries.push({ tag, type: TYPE.ASCII, count: bytes.length, inlineBytes: bytes })
  else extern(tag, TYPE.ASCII, bytes.length, bytes)
}
function doubleArrayBytes(vals) {
  const b = new Uint8Array(vals.length * 8)
  const dv = new DataView(b.buffer)
  vals.forEach((v, i) => dv.setFloat64(i * 8, v, true))
  return b
}

export function writeGeoTiff(spec) {
  const { width, height, samples, photometric, extraSamples, data,
          pixelScale, tiepoint, geoKeys, gdalNoData, compression = 1 } = spec
  const spp = samples.length

  // Entries are appended in ascending tag order (TIFF requires sorted IFD).
  const entries = []   // { tag, type, count, inline? , externIndex? }
  const externals = [] // Uint8Array[]
  const inline = (tag, type, value, count = 1) => entries.push({ tag, type, count, inline: value })
  const extern = (tag, type, count, bytes) => {
    entries.push({ tag, type, count, externIndex: externals.length })
    externals.push(bytes)
  }
  // A SHORT array is stored inline only when a single value fits the 4-byte field.
  const shortField = (tag, vals) =>
    vals.length === 1 ? inline(tag, TYPE.SHORT, vals[0]) : extern(tag, TYPE.SHORT, vals.length, shortArrayBytes(vals))

  inline(256, TYPE.LONG, width)                     // ImageWidth
  inline(257, TYPE.LONG, height)                    // ImageLength
  shortField(258, samples.map((s) => s.bits))       // BitsPerSample
  inline(259, TYPE.SHORT, compression)             // Compression (1=none, 8=Adobe DEFLATE)
  inline(262, TYPE.SHORT, photometric)              // PhotometricInterpretation
  inline(273, TYPE.LONG, 8)                         // StripOffsets = right after header
  inline(277, TYPE.SHORT, spp)                      // SamplesPerPixel
  inline(278, TYPE.LONG, height)                    // RowsPerStrip (single strip)
  inline(279, TYPE.LONG, data.length)               // StripByteCounts
  if (extraSamples && extraSamples.length) shortField(338, extraSamples) // ExtraSamples
  shortField(339, samples.map((s) => s.format))     // SampleFormat
  extern(33550, TYPE.DOUBLE, 3, doubleArrayBytes(pixelScale))  // ModelPixelScale
  extern(33922, TYPE.DOUBLE, 6, doubleArrayBytes(tiepoint))    // ModelTiepoint
  const dir = [1, 1, 0, geoKeys.length]
  for (const k of geoKeys) dir.push(k[0], k[1], k[2], k[3])
  extern(34735, TYPE.SHORT, dir.length, shortArrayBytes(dir))  // GeoKeyDirectory
  if (gdalNoData != null) asciiTag(entries, extern, 42113, String(gdalNoData))

  const nEntries = entries.length
  const even = (n) => (n % 2 ? n + 1 : n)

  const dataOffset = 8
  const ifdOffset = even(dataOffset + data.length)
  const ifdSize = 2 + 12 * nEntries + 4
  // Assign external block offsets (each even-aligned).
  const externOffsets = []
  let cur = ifdOffset + ifdSize
  for (const b of externals) { cur = even(cur); externOffsets.push(cur); cur += b.length }
  const total = cur

  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)

  // Header.
  out[0] = 0x49; out[1] = 0x49            // 'II' little-endian
  dv.setUint16(2, 42, true)
  dv.setUint32(4, ifdOffset, true)
  // Image strip.
  out.set(data, dataOffset)
  // IFD.
  let p = ifdOffset
  dv.setUint16(p, nEntries, true); p += 2
  for (const e of entries) {
    dv.setUint16(p, e.tag, true)
    dv.setUint16(p + 2, e.type, true)
    dv.setUint32(p + 4, e.count, true)
    if (e.inlineBytes) out.set(e.inlineBytes, p + 8)
    else if (e.externIndex != null) dv.setUint32(p + 8, externOffsets[e.externIndex], true)
    else if (e.type === TYPE.SHORT) dv.setUint16(p + 8, e.inline, true)
    else dv.setUint32(p + 8, e.inline, true)
    p += 12
  }
  dv.setUint32(p, 0, true)                // next IFD offset = 0 (last)
  // External blocks.
  externals.forEach((b, i) => out.set(b, externOffsets[i]))
  return out
}

// Baseline GeoTIFF in STRIPS whose bytes are already made — the export path for a
// raster too large to hold as one array (an orthophoto read out of its stored COG a
// band of rows at a time). Same tags as writeGeoTiff plus RowsPerStrip; the IFD comes
// first, then the strips in order, so the header can be written before any strip is
// read back. `strips` = Uint8Array or { length, part } (a Blob part, as assembleCog
// takes), ceil(height / rowsPerStrip) of them, each the rows' interleaved samples —
// raw, or deflated when `compression` is 8. → Uint8Array, or the parts for a Blob.
export function assembleStripTiff(spec, strips, { parts = false } = {}) {
  const { width, height, samples, photometric, extraSamples, pixelScale, tiepoint, geoKeys, gdalNoData,
    compression = 1, rowsPerStrip } = spec
  const n = strips.length
  if (!(rowsPerStrip > 0) || n !== Math.ceil(height / rowsPerStrip))
    throw new Error(`assembleStripTiff: ${n} strips for ${height} rows of ${rowsPerStrip}`)
  const entries = [], externals = []
  const inline = (tag, type, value, count = 1) => { const e = { tag, type, count, inline: value }; entries.push(e); return e }
  const extern = (tag, type, count, bytes) => {
    const e = { tag, type, count, externIndex: externals.length }
    entries.push(e); externals.push(bytes); return e
  }
  const shortField = (tag, vals) =>
    vals.length === 1 ? inline(tag, TYPE.SHORT, vals[0]) : extern(tag, TYPE.SHORT, vals.length, shortArrayBytes(vals))
  const longField = (tag, vals) => (vals.length === 1 ? inline(tag, TYPE.LONG, vals[0])
    : extern(tag, TYPE.LONG, vals.length, new Uint8Array(vals.length * 4)))

  inline(256, TYPE.LONG, width)
  inline(257, TYPE.LONG, height)
  shortField(258, samples.map((s) => s.bits))
  inline(259, TYPE.SHORT, compression)
  inline(262, TYPE.SHORT, photometric)
  const offsetsEntry = longField(273, new Array(n).fill(0)) // filled once laid out
  inline(277, TYPE.SHORT, samples.length)
  inline(278, TYPE.LONG, rowsPerStrip)
  const countsEntry = longField(279, strips.map((s) => s.length))
  if (extraSamples && extraSamples.length) shortField(338, extraSamples)
  shortField(339, samples.map((s) => s.format))
  extern(33550, TYPE.DOUBLE, 3, doubleArrayBytes(pixelScale))
  extern(33922, TYPE.DOUBLE, 6, doubleArrayBytes(tiepoint))
  const dir = [1, 1, 0, geoKeys.length]
  for (const k of geoKeys) dir.push(k[0], k[1], k[2], k[3])
  extern(34735, TYPE.SHORT, dir.length, shortArrayBytes(dir))
  if (gdalNoData != null) asciiTag(entries, extern, 42113, String(gdalNoData))

  const even = (v) => (v % 2 ? v + 1 : v)
  const ifdOffset = 8
  let cur = ifdOffset + 2 + 12 * entries.length + 4
  const externOffsets = externals.map((b) => { cur = even(cur); const o = cur; cur += b.length; return o })
  const headerLength = cur
  const stripOffsets = strips.map((s) => { cur = even(cur); const o = cur; cur += s.length; return o })
  if (cur > 0xffffffff) throw new Error('GeoTIFF exceeds the classic TIFF 4 GiB limit')

  const fillLongs = (entry, vals) => {
    if (entry.externIndex == null) { entry.inline = vals[0]; return }
    const block = externals[entry.externIndex], bdv = new DataView(block.buffer, block.byteOffset, block.byteLength)
    vals.forEach((v, i) => bdv.setUint32(i * 4, v, true))
  }
  fillLongs(offsetsEntry, stripOffsets)
  fillLongs(countsEntry, strips.map((s) => s.length))

  const out = new Uint8Array(parts ? headerLength : cur)
  const dv = new DataView(out.buffer)
  out[0] = 0x49; out[1] = 0x49
  dv.setUint16(2, 42, true)
  dv.setUint32(4, ifdOffset, true)
  let p = ifdOffset
  dv.setUint16(p, entries.length, true); p += 2
  for (const e of entries) {
    dv.setUint16(p, e.tag, true)
    dv.setUint16(p + 2, e.type, true)
    dv.setUint32(p + 4, e.count, true)
    if (e.inlineBytes) out.set(e.inlineBytes, p + 8)
    else if (e.externIndex != null) dv.setUint32(p + 8, externOffsets[e.externIndex], true)
    else if (e.type === TYPE.SHORT) dv.setUint16(p + 8, e.inline, true)
    else dv.setUint32(p + 8, e.inline, true)
    p += 12
  }
  dv.setUint32(p, 0, true)
  externals.forEach((b, i) => out.set(b, externOffsets[i]))
  if (!parts) {
    strips.forEach((s, i) => out.set(s, stripOffsets[i]))
    return out
  }
  const result = [out]
  let position = headerLength
  strips.forEach((s, i) => {
    if (stripOffsets[i] > position) result.push(new Uint8Array(stripOffsets[i] - position))
    result.push(s.part ?? s)
    position = stripOffsets[i] + s.length
  })
  return result
}

// ---------------------------------------------------------------------------
// COG writer: internally tiled, multi-IFD (full resolution + reduced-resolution
// overviews). Same georeferencing tags as writeGeoTiff, different image layout.
//
// This is what makes an imported reference raster usable by a tile renderer: a
// striped full-resolution TIFF forces a whole-image decode on every pan, so the
// overviews are load-bearing, not an optimisation.
//
// COG layout rules honoured here:
//   - every IFD (and its external tag values) precedes all image data;
//   - IFDs are ordered full-res first, then overviews by decreasing resolution;
//   - tile data is written lowest-resolution-overview first, full-res last;
//   - tile offsets ascend within each IFD.
//
// Uncompressed only. Per-tile DEFLATE would need the injected async callback
// dance for every tile of every level; measure whether it's worth it first
// (OPFS is local). Compression = 1 is therefore not a parameter.
//
// Unlike writeGeoTiff, this writer must *interpret* pixels (to tile and to
// downsample), so `data` is a TypedArray of the sample type — not raw bytes —
// interleaved by pixel, and every sample must share bits/format.
//
// spec: writeGeoTiff's spec, except
//   data: TypedArray             // length width*height*samples.length
//   tileSize?: number            // default 256; must be a multiple of 16
//   maxOverviews?: number        // default: until the level fits one tile
//
// Little-endian only, like the rest of this file: typed-array bytes are taken
// verbatim as the on-disk sample order.

const isFloatFormat = (f) => f === 3

// Box-average 2× downsample, skipping nodata; an output cell whose whole source
// block is nodata stays nodata. Averaging (rather than subsampling) is the
// honest choice for both elevations and reflectance — a decimated overview of a
// noisy DEM reads as noise rather than terrain.
// The GDAL_NODATA tag as the value cells hold: a number, NaN for a float raster
// whose nodata is "nan" (a DEM's empty cells), or null (none). An integer raster
// cannot hold NaN, so "nan" there means no nodata.
function nodataValue(gdalNoData, float) {
  if (gdalNoData == null) return null
  const n = Number(gdalNoData)
  return Number.isNaN(n) ? (float ? NaN : null) : n
}

function downsampleHalf(src, w, h, spp, nodata, float) {
  return downsampleTo(src, w, h, Math.max(1, w >> 1), Math.max(1, h >> 1), spp, nodata, float)
}

// downsampleHalf into explicit output dims. A window of a level halves into the
// matching window of the next level as long as it starts on an even cell: output
// cell x reads source cells 2x and min(2x + 1, w − 1), and a window that ends at the
// level's edge clamps there exactly as the whole level does (createCogBuilder).
function downsampleTo(src, w, h, w2, h2, spp, nodata, float) {
  const out = new src.constructor(w2 * h2 * spp)
  for (let y = 0; y < h2; y++) {
    const y0 = y * 2
    const y1 = Math.min(y0 + 1, h - 1)
    for (let x = 0; x < w2; x++) {
      const x0 = x * 2
      const x1 = Math.min(x0 + 1, w - 1)
      const o = (y * w2 + x) * spp
      for (let s = 0; s < spp; s++) {
        let sum = 0
        let n = 0
        for (const yy of y0 === y1 ? [y0] : [y0, y1]) {
          for (const xx of x0 === x1 ? [x0] : [x0, x1]) {
            const v = src[(yy * w + xx) * spp + s]
            if (nodata != null && (v === nodata || (nodata !== nodata && v !== v))) continue
            sum += v
            n++
          }
        }
        out[o + s] = n === 0 ? (nodata ?? 0) : float ? sum / n : Math.round(sum / n)
      }
    }
  }
  return { data: out, width: w2, height: h2 }
}

// Cut one level into row-major tiles, padding partial edge tiles with nodata
// (TIFF tiles are always full-size).
function cutTiles(level, spp, tileSize, nodata) {
  const { data, width, height } = level
  const across = Math.ceil(width / tileSize)
  const down = Math.ceil(height / tileSize)
  const per = tileSize * tileSize * spp
  const tiles = []
  for (let ty = 0; ty < down; ty++) {
    for (let tx = 0; tx < across; tx++) {
      const t = new data.constructor(per)
      if (nodata != null && nodata !== 0) t.fill(nodata)
      const x0 = tx * tileSize
      const y0 = ty * tileSize
      const rowLen = Math.min(tileSize, width - x0) * spp
      for (let r = 0; r < tileSize; r++) {
        const sy = y0 + r
        if (sy >= height) break
        const srcOff = (sy * width + x0) * spp
        t.set(data.subarray(srcOff, srcOff + rowLen), r * tileSize * spp)
      }
      tiles.push(new Uint8Array(t.buffer, t.byteOffset, t.byteLength))
    }
  }
  return { tiles, across, down }
}

// ── COG: plan → (compress) → assemble ────────────────────────────────────────
//
// Layout and bytes are split into two calls because compression is *async* here:
// DEFLATE comes from the browser's CompressionStream, which is DOM/worker-only
// and so is injected rather than imported (the same reason writeGeoTiff takes a
// `deflate` callback). A tiled image has thousands of tiles across all levels, so
// awaiting inside the writer would serialize thousands of round-trips; instead
// `planCog` hands back the raw tiles, the caller compresses them however it likes
// (batched, in parallel, or not at all), and `assembleCog` lays out the file once
// the real byte counts are known — which they must be, since a compressed tile's
// size is exactly what TileByteCounts records.
//
// `writeCog(spec)` remains the uncompressed one-shot form.

// GDAL's "ghost area": a comment block immediately after the TIFF header that
// lets a reader recognise the COG layout without scanning the whole file (it is
// what makes gdalinfo report LAYOUT=COG). We advertise only what we actually do —
// no BLOCK_LEADER/BLOCK_TRAILER, since we write bare tile data with no per-block
// size prefix. The declared size counts the bytes after the first line.
function ghostArea() {
  const body = 'LAYOUT=IFDS_BEFORE_DATA\n'
    + 'BLOCK_ORDER=ROW_MAJOR\n'
    + 'KNOWN_INCOMPATIBLE_EDITION=NO\n'
  const head = `GDAL_STRUCTURAL_METADATA_SIZE=${String(body.length).padStart(6, '0')} bytes\n`
  return new TextEncoder().encode(head + body)
}

// Cut a raster into COG levels and tiles. Returns the raw (uncompressed) tiles in
// **write order** — lowest-resolution overview first, full resolution last, which
// is what puts the overviews in the first bytes of the file — plus the plan
// assembleCog needs.
export function planCog(spec) {
  const { width, height, samples, photometric, extraSamples, data,
          pixelScale, tiepoint, geoKeys, gdalNoData,
          tileSize = 256, maxOverviews = Infinity } = spec
  const spp = samples.length
  const { bits, format } = samples[0]
  if (!samples.every((s) => s.bits === bits && s.format === format))
    throw new Error('planCog: every sample must share bits and format')
  if (tileSize % 16 || tileSize <= 0)
    throw new Error('planCog: tileSize must be a positive multiple of 16')
  if (!ArrayBuffer.isView(data) || data instanceof DataView)
    throw new Error('planCog: data must be a TypedArray of the sample type')
  if (data.length !== width * height * spp)
    throw new Error(`planCog: data length ${data.length} != ${width}*${height}*${spp}`)

  const float = isFloatFormat(format)
  const nodata = nodataValue(gdalNoData, float)

  // Levels: full resolution, then halvings until one tile covers the image.
  const levels = [{ data, width, height }]
  while (levels.length <= maxOverviews) {
    const last = levels[levels.length - 1]
    if (last.width <= tileSize && last.height <= tileSize) break
    if (last.width <= 1 && last.height <= 1) break
    levels.push(downsampleHalf(last.data, last.width, last.height, spp, nodata, float))
  }

  const cut = levels.map((l) => cutTiles(l, spp, tileSize, nodata))
  // Flat write order + the index back to (level, tile) so assembleCog can put each
  // compressed buffer's byte count on the right IFD entry.
  const order = []
  const tiles = []
  for (let li = levels.length - 1; li >= 0; li--) {
    cut[li].tiles.forEach((t, ti) => { order.push({ li, ti }); tiles.push(t) })
  }
  const plan = {
    levels: levels.map((l) => ({ width: l.width, height: l.height })),
    tileCounts: cut.map((c) => c.tiles.length),
    order, spp, samples, photometric, extraSamples,
    pixelScale, tiepoint, geoKeys, gdalNoData, tileSize,
  }
  return { plan, tiles }
}

// Lay out and emit the file. `tileBuffers` must be the array planCog returned,
// in the same order, either untouched or with each entry replaced by its
// compressed form. `compression` is the TIFF tag value (1 = none, 8 = Adobe
// DEFLATE) and must match what the caller actually did to the tiles.
// `bigTiff`: 'auto' (default) writes a classic TIFF while it fits 4 GiB and a BigTIFF
// (64-bit offsets, version 43) past that; true / false force one. GDAL, QGIS and
// geotiff.js read both; a classic file is what older tools expect, so it stays the
// form whenever it fits.
export function assembleCog(plan, tileBuffers, { compression = 1, parts = false, bigTiff = 'auto' } = {}) {
  const { order, tileCounts, levels } = plan
  if (tileBuffers.length !== order.length)
    throw new Error(`assembleCog: expected ${order.length} tiles, got ${tileBuffers.length}`)
  // Per-level tile byte counts, from what the caller actually produced.
  const byteCounts = levels.map((_, li) => new Array(tileCounts[li]).fill(0))
  order.forEach(({ li, ti }, i) => { byteCounts[li][ti] = tileBuffers[i].length })

  let layout = layoutCog(plan, byteCounts, tileBuffers, compression, bigTiff === true)
  if (bigTiff === 'auto' && layout.total > 0xffffffff) layout = layoutCog(plan, byteCounts, tileBuffers, compression, true)
  if (!layout.big && layout.total > 0xffffffff) throw new Error('COG exceeds the classic TIFF 4 GiB limit')
  const { big, ifds, headerLength, tileOffsets, total } = layout

  const out = new Uint8Array(parts ? headerLength : total)
  const dv = new DataView(out.buffer)
  const word = (p, v) => (big ? dv.setBigUint64(p, BigInt(v), true) : dv.setUint32(p, v, true))
  out[0] = 0x49; out[1] = 0x49
  if (big) {
    dv.setUint16(2, 43, true); dv.setUint16(4, 8, true); dv.setUint16(6, 0, true)
    dv.setBigUint64(8, BigInt(ifds[0].offset), true)
  } else {
    dv.setUint16(2, 42, true)
    dv.setUint32(4, ifds[0].offset, true)
  }
  out.set(ghostArea(), big ? 16 : 8)

  ifds.forEach((ifd, li) => {
    // Backfill the tile offsets now that they are known.
    const off = ifd.offsetsEntry.bytes, odv = new DataView(off.buffer, off.byteOffset, off.byteLength)
    tileOffsets[li].forEach((o, i) => (big ? odv.setBigUint64(i * 8, BigInt(o), true) : odv.setUint32(i * 4, o, true)))
    let p = ifd.offset
    if (big) { dv.setBigUint64(p, BigInt(ifd.entries.length), true); p += 8 } else { dv.setUint16(p, ifd.entries.length, true); p += 2 }
    for (const e of ifd.entries) {
      dv.setUint16(p, e.tag, true)
      dv.setUint16(p + 2, e.type, true)
      word(p + 4, e.count)
      const field = p + (big ? 12 : 8)
      if (e.offset != null) word(field, e.offset)
      else out.set(e.bytes, field)
      p += big ? 20 : 12
    }
    word(p, li + 1 < ifds.length ? ifds[li + 1].offset : 0)
    for (const e of ifd.entries) if (e.offset != null) out.set(e.bytes, e.offset)
  })

  if (parts) {
    const result = [out]
    let position = headerLength
    order.forEach(({ li, ti }, i) => {
      const offset = tileOffsets[li][ti]
      if (offset > position) result.push(new Uint8Array(offset - position))
      result.push(tileBuffers[i].part ?? tileBuffers[i])
      position = offset + tileBuffers[i].length
    })
    return result
  }
  order.forEach(({ li, ti }, i) => out.set(tileBuffers[i], tileOffsets[li][ti]))
  return out
}

// TIFF field types and their sizes (LONG8 is BigTIFF's 64-bit unsigned).
const TYPE_SIZE = { 2: 1, 3: 2, 4: 4, 12: 8, 16: 8 }
const LONG8 = 16

// The layout of assembleCog's file: every IFD's entries — each value as its bytes,
// stored in the entry's value field when it fits (4 bytes classic, 8 BigTIFF), else in
// an external block at `offset` — then the tile data in write order (overviews first),
// each 2-byte aligned. The tile offsets are filled in by the caller.
function layoutCog(plan, byteCounts, tileBuffers, compression, big) {
  const { levels, tileCounts, order, spp, samples, photometric, extraSamples,
          pixelScale, tiepoint, geoKeys, gdalNoData, tileSize } = plan
  const even = (n) => (n % 2 ? n + 1 : n)
  const cap = big ? 8 : 4
  const ints = (vals, size) => {
    const b = new Uint8Array(vals.length * size), d = new DataView(b.buffer)
    vals.forEach((v, i) => (size === 2 ? d.setUint16(i * 2, v, true) : d.setUint32(i * 4, v, true)))
    return b
  }

  const ifds = levels.map((level, li) => {
    const entries = []
    const field = (tag, type, bytes, count = bytes.length / TYPE_SIZE[type]) => {
      const e = { tag, type, count, bytes }
      entries.push(e)
      return e
    }
    const shorts = (tag, vals) => field(tag, TYPE.SHORT, ints(vals, 2))
    const long = (tag, v) => field(tag, TYPE.LONG, ints([v], 4))
    const nTiles = tileCounts[li]
    long(254, li === 0 ? 0 : 1)                     // NewSubfileType (1 = reduced resolution)
    long(256, level.width)
    long(257, level.height)
    shorts(258, samples.map((s) => s.bits))
    shorts(259, [compression])
    shorts(262, [photometric])
    shorts(277, [spp])
    shorts(284, [1])                                // PlanarConfiguration: chunky
    long(322, tileSize)                             // TileWidth
    long(323, tileSize)                             // TileLength
    // TileOffsets: known only after layout, so only their size here. A single-tile
    // level's offset fits the value field, where a reader looks for it.
    const offsetsEntry = field(324, big ? LONG8 : TYPE.LONG, new Uint8Array(nTiles * (big ? 8 : 4)))
    field(325, TYPE.LONG, ints(byteCounts[li], 4))
    if (extraSamples && extraSamples.length) shorts(338, extraSamples)
    shorts(339, samples.map((s) => s.format))
    if (li === 0) {
      // Georeferencing lives on the full-resolution IFD; an overview inherits it
      // (its geotransform is implied by its own dimensions).
      field(33550, TYPE.DOUBLE, doubleArrayBytes(pixelScale))
      field(33922, TYPE.DOUBLE, doubleArrayBytes(tiepoint))
      const dir = [1, 1, 0, geoKeys.length]
      for (const k of geoKeys) dir.push(k[0], k[1], k[2], k[3])
      shorts(34735, dir)
    }
    if (gdalNoData != null) field(42113, TYPE.ASCII, new TextEncoder().encode(String(gdalNoData) + '\0'))
    return { entries, offsetsEntry }
  })

  // Header (8 or 16 bytes), ghost area, all IFDs + their external values, then tiles.
  let cur = (big ? 16 : 8) + ghostArea().length
  for (const ifd of ifds) {
    cur = even(cur)
    ifd.offset = cur
    cur += (big ? 8 : 2) + (big ? 20 : 12) * ifd.entries.length + (big ? 8 : 4)
    for (const e of ifd.entries) {
      e.offset = null
      if (e.bytes.length > cap) { cur = even(cur); e.offset = cur; cur += e.bytes.length }
    }
  }
  const headerLength = cur
  const tileOffsets = levels.map((_, li) => new Array(tileCounts[li]).fill(0))
  order.forEach(({ li, ti }, i) => {
    cur = even(cur)
    tileOffsets[li][ti] = cur
    cur += tileBuffers[i].length
  })
  return { big, ifds, headerLength, tileOffsets, total: cur }
}

export function writeCog(spec) {
  const { plan, tiles } = planCog(spec)
  return assembleCog(plan, tiles)
}

// The compressed form: same plan, DEFLATE every tile through the injected async
// callback. `deflate` is the same zlib-stream callback writeGeoTiff takes, so a
// caller wires one function for both writers.
export async function writeCogDeflate(spec, deflate) {
  const { plan, tiles } = planCog(spec)
  if (!deflate) return assembleCog(plan, tiles)
  const packed = []
  for (const t of tiles) packed.push(await deflate(t))
  return assembleCog(plan, packed, { compression: 8 })
}

// ── COG from blocks (plan SC-9 / T2) ─────────────────────────────────────────
//
// planCog needs the whole raster as one array, which a tiled orthophoto never has.
// createCogBuilder takes it a block at a time instead — square blocks on a grid of
// `blockSize` cells (a multiple of tileSize) — and keeps only what the file needs:
//   - levels whose tiles lie wholly inside one block (blockSize / 2^k a multiple of
//     the tile size) are cut, compressed and kept as packed tiles the moment the block
//     arrives; its pixels are dropped;
//   - the first level where a tile spans several blocks is accumulated whole — it is
//     1/4^k of the image (1/64 for 2,048-cell blocks of 512 tiles) — and every coarser
//     level is halved from it at finish().
// Every level is the one planCog would compute (downsampleTo), so for the same pixels
// the file is byte-identical to writeCogDeflate's (geotiff.test.js pins it).
//
// The shape planCog would give a raster of this size: level dims and tile grid.
export function planCogFromTiles({ width, height, tileSize = 256, maxOverviews = Infinity }) {
  if (tileSize % 16 || tileSize <= 0) throw new Error('planCogFromTiles: tileSize must be a positive multiple of 16')
  const levels = [{ width, height }]
  while (levels.length <= maxOverviews) {
    const last = levels[levels.length - 1]
    if (last.width <= tileSize && last.height <= tileSize) break
    if (last.width <= 1 && last.height <= 1) break
    levels.push({ width: Math.max(1, last.width >> 1), height: Math.max(1, last.height >> 1) })
  }
  const across = levels.map((l) => Math.ceil(l.width / tileSize))
  const tileCounts = levels.map((l, li) => across[li] * Math.ceil(l.height / tileSize))
  return { levels, across, tileCounts, tileSize }
}

// spec: planCog's, minus `data`, plus `ArrayType` (the samples' TypedArray constructor,
// default Uint8Array). options:
//   blockSize    the block grid, a multiple of tileSize (default 2048)
//   compress     async (Uint8Array) → Uint8Array | { length, part } — one tile's DEFLATE
//                (zlib) stream; null = uncompressed
//   previewMaxDim  also keep the first level whose long side fits, for a preview
// → { addBlock({ col0, row0, width, height, data }), finish() → { parts, preview,
//     levels } } — `parts` for a Blob (assembleCog parts), `preview` = { data, width,
//     height } or null. Blocks may arrive in any order; every block must arrive once.
export function createCogBuilder(spec, { blockSize = 2048, compress = null, previewMaxDim = 0 } = {}) {
  const { width, height, samples, photometric, extraSamples, pixelScale, tiepoint, geoKeys, gdalNoData,
    tileSize = 256, maxOverviews = Infinity, ArrayType = Uint8Array } = spec
  const spp = samples.length
  const { bits, format } = samples[0]
  if (!samples.every((s) => s.bits === bits && s.format === format))
    throw new Error('createCogBuilder: every sample must share bits and format')
  if (!(blockSize > 0) || blockSize % tileSize) throw new Error('createCogBuilder: blockSize must be a multiple of tileSize')
  const layout = planCogFromTiles({ width, height, tileSize, maxOverviews })
  const { levels, across, tileCounts } = layout
  const float = isFloatFormat(format)
  const nodata = nodataValue(gdalNoData, float)

  // Levels cut per block, then the accumulated level (if the pyramid goes that far).
  let blockLevels = 0
  while (blockLevels < levels.length && (blockSize / 2 ** blockLevels) % tileSize === 0) blockLevels++
  const accLevel = blockLevels < levels.length ? blockLevels : -1
  const acc = accLevel >= 0 ? new ArrayType(levels[accLevel].width * levels[accLevel].height * spp) : null
  let previewLevel = -1
  if (previewMaxDim > 0) previewLevel = levels.findIndex((l) => Math.max(l.width, l.height) <= previewMaxDim)
  const preview = previewLevel >= 0 && previewLevel < blockLevels
    ? new ArrayType(levels[previewLevel].width * levels[previewLevel].height * spp) : null

  const packed = levels.map((_, li) => new Array(tileCounts[li]).fill(null))
  const pack = async (li, tiles, tx0, ty0, nAcross) => {
    const out = compress ? await Promise.all(tiles.map((t) => compress(t))) : tiles
    out.forEach((t, i) => { packed[li][(ty0 + Math.floor(i / nAcross)) * across[li] + tx0 + (i % nAcross)] = t })
  }
  // Copy a window into a whole-level plane.
  const place = (dst, lw, win, x0, y0) => {
    for (let r = 0; r < win.height; r++) {
      dst.set(win.data.subarray(r * win.width * spp, (r + 1) * win.width * spp), ((y0 + r) * lw + x0) * spp)
    }
  }

  async function addBlock({ col0, row0, width: bw, height: bh, data }) {
    if (col0 % blockSize || row0 % blockSize || bw !== Math.min(blockSize, width - col0) || bh !== Math.min(blockSize, height - row0))
      throw new Error(`createCogBuilder: block at ${col0},${row0} (${bw}×${bh}) is not on the ${blockSize} grid`)
    if (data.length !== bw * bh * spp) throw new Error('createCogBuilder: block data length mismatch')
    let cur = { data, width: bw, height: bh }
    const last = accLevel >= 0 ? accLevel : levels.length - 1
    for (let k = 0; k <= last; k++) {
      const f = 2 ** k, x0 = col0 / f, y0 = row0 / f
      if (k > 0) {
        const lw = Math.min(levels[k].width - x0, blockSize / f), lh = Math.min(levels[k].height - y0, blockSize / f)
        cur = downsampleTo(cur.data, cur.width, cur.height, lw, lh, spp, nodata, float)
      }
      if (k === previewLevel && preview) place(preview, levels[k].width, cur, x0, y0)
      if (k === accLevel) { place(acc, levels[k].width, cur, x0, y0); break }
      const { tiles, across: nAcross } = cutTiles(cur, spp, tileSize, nodata)
      await pack(k, tiles, x0 / tileSize, y0 / tileSize, nAcross)
    }
  }

  async function finish() {
    let previewOut = preview ? { data: preview, ...levels[previewLevel] } : null
    if (acc) {
      let cur = { data: acc, ...levels[accLevel] }
      for (let li = accLevel; li < levels.length; li++) {
        if (li > accLevel) cur = downsampleHalf(cur.data, cur.width, cur.height, spp, nodata, float)
        if (li === previewLevel) previewOut = { data: cur.data, width: cur.width, height: cur.height }
        await pack(li, cutTiles(cur, spp, tileSize, nodata).tiles, 0, 0, across[li])
      }
    }
    const order = [], buffers = []
    for (let li = levels.length - 1; li >= 0; li--) {
      packed[li].forEach((t, ti) => {
        if (t == null) throw new Error(`createCogBuilder: level ${li} tile ${ti} never arrived`)
        order.push({ li, ti }); buffers.push(t)
      })
    }
    const plan = { levels, tileCounts, order, spp, samples, photometric, extraSamples,
      pixelScale, tiepoint, geoKeys, gdalNoData, tileSize }
    const parts = assembleCog(plan, buffers, { compression: compress ? 8 : 1, parts: true })
    return { parts, preview: previewOut, levels }
  }

  return { addBlock, finish, layout }
}

// Upper bound on a COG's bytes before compression: every level's padded tiles plus
// headers — what decides whether the classic-TIFF 4 GiB offsets can hold it.
export function cogRawBytes({ width, height, tileSize = 256, bytesPerPixel }) {
  const { tileCounts } = planCogFromTiles({ width, height, tileSize })
  return tileCounts.reduce((n, c) => n + c, 0) * tileSize * tileSize * bytesPerPixel + 65536
}

// What a product's GeoTIFF tags (and .prj) say about its frame: { crs, code,
// geographic }. A local frame has no CRS — never a fabricated one (CLAUDE.md ▸ Scale
// & units) — so its keys are user-defined. One home for the stored ortho COG (built
// in the products worker) and every export, so the two can never tag differently.
export function crsTagInfo(source) {
  const crs = source?.crs
  if (!crs || crs === 'local') return { crs: null, code: null, geographic: false }
  const m = /EPSG:(\d+)/i.exec(crs)
  const code = m ? Number(m[1]) : null
  const geographic = code === 4326 || /degree|deg\b/i.test(source.unit || '')
  return { crs, code, geographic }
}

// GeoKeyDirectory entries for an EPSG code (or a bare geotransform when unknown).
// loc=0 → value stored inline in the directory. Codes: 1024 GTModelType (1=proj,
// 2=geographic, 32767=user-defined), 1025 GTRasterType (1=PixelIsArea), 3072
// ProjectedCSType, 2048 GeographicType.
export function geoKeysForEpsg(code, geographic) {
  if (!code) return [[1024, 0, 1, 32767], [1025, 0, 1, 1]]
  return geographic
    ? [[1024, 0, 1, 2], [1025, 0, 1, 1], [2048, 0, 1, code]]
    : [[1024, 0, 1, 1], [1025, 0, 1, 1], [3072, 0, 1, code]]
}
