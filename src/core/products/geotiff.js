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
  if (gdalNoData != null) {
    extern(42113, TYPE.ASCII, undefined, new TextEncoder().encode(String(gdalNoData) + '\0'))
    entries[entries.length - 1].count = externals[externals.length - 1].length
  }

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
    if (e.externIndex != null) dv.setUint32(p + 8, externOffsets[e.externIndex], true)
    else if (e.type === TYPE.SHORT) dv.setUint16(p + 8, e.inline, true)
    else dv.setUint32(p + 8, e.inline, true)
    p += 12
  }
  dv.setUint32(p, 0, true)                // next IFD offset = 0 (last)
  // External blocks.
  externals.forEach((b, i) => out.set(b, externOffsets[i]))
  return out
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
function downsampleHalf(src, w, h, spp, nodata, float) {
  const w2 = Math.max(1, w >> 1)
  const h2 = Math.max(1, h >> 1)
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
            if (nodata != null && v === nodata) continue
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

export function writeCog(spec) {
  const { width, height, samples, photometric, extraSamples, data,
          pixelScale, tiepoint, geoKeys, gdalNoData,
          tileSize = 256, maxOverviews = Infinity } = spec
  const spp = samples.length
  const { bits, format } = samples[0]
  if (!samples.every((s) => s.bits === bits && s.format === format))
    throw new Error('writeCog: every sample must share bits and format')
  if (tileSize % 16 || tileSize <= 0)
    throw new Error('writeCog: tileSize must be a positive multiple of 16')
  if (!ArrayBuffer.isView(data) || data instanceof DataView)
    throw new Error('writeCog: data must be a TypedArray of the sample type')
  if (data.length !== width * height * spp)
    throw new Error(`writeCog: data length ${data.length} != ${width}*${height}*${spp}`)

  const nodataNum = gdalNoData == null ? null : Number(gdalNoData)
  const nodata = nodataNum == null || Number.isNaN(nodataNum) ? null : nodataNum
  const float = isFloatFormat(format)

  // Levels: full resolution, then halvings until one tile covers the image.
  const levels = [{ data, width, height }]
  while (levels.length <= maxOverviews) {
    const last = levels[levels.length - 1]
    if (last.width <= tileSize && last.height <= tileSize) break
    if (last.width <= 1 && last.height <= 1) break
    levels.push(downsampleHalf(last.data, last.width, last.height, spp, nodata, float))
  }

  const cut = levels.map((l) => cutTiles(l, spp, tileSize, nodata))
  const tileBytes = tileSize * tileSize * spp * (bits / 8)
  const even = (n) => (n % 2 ? n + 1 : n)

  // --- Build each level's IFD entries (tag order ascending). --------------
  const ifds = levels.map((level, li) => {
    const entries = []
    const externals = []
    const inline = (tag, type, value, count = 1) => entries.push({ tag, type, count, inline: value })
    const extern = (tag, type, count, bytes) => {
      entries.push({ tag, type, count, externIndex: externals.length })
      externals.push(bytes)
    }
    const shortField = (tag, vals) =>
      vals.length === 1 ? inline(tag, TYPE.SHORT, vals[0])
        : extern(tag, TYPE.SHORT, vals.length, shortArrayBytes(vals))

    const nTiles = cut[li].tiles.length
    inline(254, TYPE.LONG, li === 0 ? 0 : 1)          // NewSubfileType (1 = reduced resolution)
    inline(256, TYPE.LONG, level.width)
    inline(257, TYPE.LONG, level.height)
    shortField(258, samples.map((s) => s.bits))
    inline(259, TYPE.SHORT, 1)                        // Compression: none
    inline(262, TYPE.SHORT, photometric)
    inline(277, TYPE.SHORT, spp)
    inline(284, TYPE.SHORT, 1)                        // PlanarConfiguration: chunky
    inline(322, TYPE.LONG, tileSize)                  // TileWidth
    inline(323, TYPE.LONG, tileSize)                  // TileLength
    // Tile offsets are only known after layout; the blocks are filled in below.
    // A single-tile level must stay INLINE — a reader takes count*size <= 4 as
    // an inline value and would otherwise read the offset itself as the offset.
    const offsetsEntry = { tag: 324, type: TYPE.LONG, count: nTiles }
    if (nTiles === 1) offsetsEntry.inline = 0
    else { offsetsEntry.externIndex = externals.length; externals.push(new Uint8Array(nTiles * 4)) }
    entries.push(offsetsEntry)
    if (nTiles === 1) inline(325, TYPE.LONG, tileBytes)
    else {
      const counts = new Uint8Array(nTiles * 4)
      const cdv = new DataView(counts.buffer)
      for (let i = 0; i < nTiles; i++) cdv.setUint32(i * 4, tileBytes, true)
      extern(325, TYPE.LONG, nTiles, counts)
    }
    if (extraSamples && extraSamples.length) shortField(338, extraSamples)
    shortField(339, samples.map((s) => s.format))
    if (li === 0) {
      // Georeferencing lives on the full-resolution IFD; an overview inherits it
      // (its geotransform is implied by its own dimensions).
      extern(33550, TYPE.DOUBLE, 3, doubleArrayBytes(pixelScale))
      extern(33922, TYPE.DOUBLE, 6, doubleArrayBytes(tiepoint))
      const dir = [1, 1, 0, geoKeys.length]
      for (const k of geoKeys) dir.push(k[0], k[1], k[2], k[3])
      extern(34735, TYPE.SHORT, dir.length, shortArrayBytes(dir))
    }
    if (gdalNoData != null) {
      const bytes = new TextEncoder().encode(String(gdalNoData) + '\0')
      extern(42113, TYPE.ASCII, bytes.length, bytes)
    }
    return { entries, externals, offsetsEntry }
  })

  // --- Layout: header, all IFDs + their externals, then tile data. --------
  let cur = 8
  for (const ifd of ifds) {
    cur = even(cur)
    ifd.offset = cur
    cur += 2 + 12 * ifd.entries.length + 4
    ifd.externOffsets = []
    for (const b of ifd.externals) { cur = even(cur); ifd.externOffsets.push(cur); cur += b.length }
  }
  // Tile data order: lowest-resolution overview first, full resolution last.
  const dataOrder = levels.map((_, i) => i).reverse()
  const tileOffsets = levels.map(() => [])
  for (const li of dataOrder) {
    cur = even(cur)
    for (let t = 0; t < cut[li].tiles.length; t++) { tileOffsets[li].push(cur); cur += tileBytes }
  }
  const total = cur

  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)

  out[0] = 0x49; out[1] = 0x49
  dv.setUint16(2, 42, true)
  dv.setUint32(4, ifds[0].offset, true)

  ifds.forEach((ifd, li) => {
    // Backfill the tile offsets now that they are known.
    if (ifd.offsetsEntry.externIndex != null) {
      const block = ifd.externals[ifd.offsetsEntry.externIndex]
      const bdv = new DataView(block.buffer, block.byteOffset, block.byteLength)
      tileOffsets[li].forEach((o, i) => bdv.setUint32(i * 4, o, true))
    } else {
      ifd.offsetsEntry.inline = tileOffsets[li][0]
    }

    let p = ifd.offset
    dv.setUint16(p, ifd.entries.length, true); p += 2
    for (const e of ifd.entries) {
      dv.setUint16(p, e.tag, true)
      dv.setUint16(p + 2, e.type, true)
      dv.setUint32(p + 4, e.count, true)
      if (e.externIndex != null) dv.setUint32(p + 8, ifd.externOffsets[e.externIndex], true)
      else if (e.type === TYPE.SHORT) dv.setUint16(p + 8, e.inline, true)
      else dv.setUint32(p + 8, e.inline, true)
      p += 12
    }
    dv.setUint32(p, li + 1 < ifds.length ? ifds[li + 1].offset : 0, true)
    ifd.externals.forEach((b, i) => out.set(b, ifd.externOffsets[i]))
  })

  for (const li of dataOrder) {
    cut[li].tiles.forEach((t, i) => out.set(t, tileOffsets[li][i]))
  }
  return out
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
