// Decide whether an imported georeferenced raster is a DEM (elevation) or an
// orthophoto (imagery), so the import can route without forcing the user to
// declare it first. Mirrors importKind.js's contract — { kind, confidence,
// reasons } — but adds `reasons` because "float32 + nodata −9999 ⇒ DEM" in the
// log beats a silent guess you have to reverse-engineer at 11pm.
//
// PURE: takes already-extracted TIFF tags + a decimated value sample, never a
// geotiff.js handle. The decode lives in workers/ops/io.js.
//
// Band count alone is not enough (a panchromatic scan is 1 band; a 16-bit DEM
// and a 16-bit satellite ortho look alike), so the signals are ordered by
// strength and the first decisive one wins.

// TIFF SampleFormat values (tag 339).
export const SAMPLE_FORMAT_UINT = 1
export const SAMPLE_FORMAT_INT = 2
export const SAMPLE_FORMAT_IEEEFP = 3

// The classic sentinel nodata values. Orthos use an alpha band, not a nodata
// value, so *any* nodata tag leans DEM — these just make the reason specific.
const CLASSIC_NODATA = [-9999, -32768, -32767, -3.4028234663852886e38, -1e10]
const isClassicNodata = (v) =>
  CLASSIC_NODATA.some((c) => (c === 0 ? v === 0 : Math.abs((v - c) / c) < 1e-6))

const DEM_NAME = /(^|[^a-z])(dem|dsm|dtm|elev|elevation|height|rema|cop30|copernicus|srtm|arcticdem|bedmap)([^a-z]|$)/i
const ORTHO_NAME = /(^|[^a-z])(ortho|orthophoto|rgb|mosaic|pan|image|imagery|basemap|sentinel|landsat)([^a-z]|$)/i

// Physically plausible Earth elevations in metres, with generous headroom
// (Everest 8849, Bentley Subglacial Trench −2555, plus ellipsoid/geoid offsets).
const ELEV_MIN = -12000
const ELEV_MAX = 11000

// input: {
//   bands, sampleFormat, bitsPerSample, nodata, geoKeys, sampledValues, fileName
// }
//   bands         — SamplesPerPixel (tag 277)
//   sampleFormat  — SampleFormat (tag 339); undefined ⇒ assume uint
//   bitsPerSample — BitsPerSample (tag 258), first sample
//   nodata        — parsed GDAL_NODATA (tag 42113) as a number, or null
//   geoKeys       — { VerticalCSTypeGeoKey?, … } from the GeoTIFF key directory
//   sampledValues — decimated pixel values (~10k) from band 0, nodata already
//                   stripped; used only as the int16/uint16 tie-break
//   fileName      — lowest-confidence tie-break only
// → { kind: 'dem' | 'ortho', confidence: 'high' | 'low', reasons: string[] }
export function classifyRasterKind(input = {}) {
  const {
    bands = 1,
    sampleFormat = SAMPLE_FORMAT_UINT,
    bitsPerSample = 8,
    nodata = null,
    geoKeys = {},
    sampledValues = null,
    fileName = '',
  } = input

  const reasons = []
  const decide = (kind, confidence, why) => {
    reasons.push(why)
    return { kind, confidence, reasons }
  }

  // 1. Float samples with a single band. Nothing ships float ortho imagery, so
  //    this is effectively certain and is checked before everything else.
  if (sampleFormat === SAMPLE_FORMAT_IEEEFP && bands === 1) {
    return decide('dem', 'high', `float${bitsPerSample} sample format, 1 band ⇒ elevation`)
  }

  // 2. A nodata tag at all. Imagery masks with an alpha band; a nodata sentinel
  //    is an elevation-raster convention.
  if (nodata != null && Number.isFinite(nodata)) {
    const why = isClassicNodata(nodata)
      ? `nodata ${nodata} (classic elevation sentinel) ⇒ elevation`
      : `nodata tag ${nodata} present (orthos mask with alpha, not nodata) ⇒ elevation`
    // Still guard against a 3-band raster that happens to carry nodata — band
    // count is the stronger signal in that direction.
    if (bands < 3) return decide('dem', 'high', why)
    reasons.push(`nodata ${nodata} present, but ${bands} bands outweighs it`)
  }

  // 3. Three or more bands is imagery (4 = RGB+alpha or RGB+NIR, still imagery).
  if (bands >= 3) return decide('ortho', 'high', `${bands} bands ⇒ imagery`)

  // 4. Single-band 8-bit is imagery — panchromatic or a greyscale scan. Integer
  //    DEMs at 8 bits don't exist in practice; 8-bit *hillshades* do, and those
  //    are imagery for our purposes anyway (and the kind stays editable).
  if (bands === 1 && bitsPerSample <= 8) {
    return decide('ortho', 'high', `1 band, ${bitsPerSample}-bit ⇒ panchromatic/greyscale imagery`)
  }

  // 5. VerticalCSTypeGeoKey — a raster that declares a vertical CRS is elevation.
  //    Below the cheap structural signals because it's frequently absent, but
  //    above the histogram because it's an explicit declaration.
  if (geoKeys?.VerticalCSTypeGeoKey != null) {
    return decide('dem', 'high', `VerticalCSTypeGeoKey ${geoKeys.VerticalCSTypeGeoKey} ⇒ elevation`)
  }

  // 6. The genuinely ambiguous case: 1-band int16/uint16. Fall back to the value
  //    distribution, which only ever yields `low` confidence — the import modal
  //    opens so the user can confirm.
  const hist = describeSample(sampledValues)
  if (hist) {
    if (hist.min < 0 && hist.min >= ELEV_MIN && hist.max <= ELEV_MAX) {
      return decide('dem', 'low',
        `values ${fmt(hist.min)}…${fmt(hist.max)} include negatives within elevation range ⇒ elevation`)
    }
    if (hist.max <= 255 && hist.min >= 0) {
      return decide('ortho', 'low', `values ${fmt(hist.min)}…${fmt(hist.max)} confined to 0–255 ⇒ imagery`)
    }
    // A saturating histogram (a big pile at the top of the dtype range) is the
    // signature of imagery stretched to fill 16 bits; elevation doesn't clip.
    if (hist.saturated) {
      return decide('ortho', 'low',
        `values saturate at the top of the ${bitsPerSample}-bit range ⇒ imagery`)
    }
    if (hist.min >= ELEV_MIN && hist.max <= ELEV_MAX) {
      return decide('dem', 'low',
        `values ${fmt(hist.min)}…${fmt(hist.max)} sit inside the plausible elevation range ⇒ elevation`)
    }
    reasons.push(`values ${fmt(hist.min)}…${fmt(hist.max)} are inconclusive`)
  }

  // 7. Filename — lowest confidence, same tier as importKind.js's header-wording
  //    fallback. Only used when nothing structural decided.
  const base = String(fileName).split(/[\\/]/).pop() || ''
  const demName = DEM_NAME.test(base)
  const orthoName = ORTHO_NAME.test(base)
  if (demName && !orthoName) return decide('dem', 'low', `filename "${base}" reads as elevation`)
  if (orthoName && !demName) return decide('ortho', 'low', `filename "${base}" reads as imagery`)

  // Default to DEM: a 1-band 16-bit georeferenced raster is far more often
  // elevation, and mis-filing a reference ortho as a DEM is the cheaper error
  // (the "Treat as…" action flips it, and nothing samples it in the meantime).
  return decide('dem', 'low', 'no decisive signal — defaulting to elevation (1-band 16-bit)')
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toPrecision(4))

// Min/max plus a crude saturation flag over the decimated sample. Returns null
// for an empty/absent sample so the caller can skip the histogram tier.
function describeSample(values) {
  if (!values || !values.length) return null
  let min = Infinity
  let max = -Infinity
  let n = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
    n++
  }
  if (!n) return null

  // "Saturated" = ≥5% of samples sit in the top 1% of the observed range, which
  // is what a contrast-stretched image looks like and what terrain does not.
  const span = max - min
  let top = 0
  if (span > 0) {
    const thresh = max - span * 0.01
    for (let i = 0; i < values.length; i++) if (values[i] >= thresh) top++
  }
  return { min, max, n, saturated: span > 0 && top / n >= 0.05 }
}
