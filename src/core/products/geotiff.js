// Minimal, dependency-free GeoTIFF writer: baseline (little-endian, uncompressed,
// single strip) TIFF + the GeoTIFF georeferencing tags. Covers the two shapes this
// app exports — a 1-band float DEM and an RGBA orthophoto — but the spec is generic.
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
