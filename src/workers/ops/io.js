import { fromArrayBuffer } from 'geotiff'
import { parseCloudFile, cloudStats } from '../../core/io/cloudImport.js'
import { classifyRasterKind } from '../../core/io/rasterKind.js'
import { hillshadeRgba } from '../../core/products/colormap.js'
import { rasterToDataUrl } from '../rasterPreview.js'
import { isAxisAlignedModelTransformation, readTiffTag } from '../../utils/tiff.js'
import {
  needsStyling, resolveRasterStyle, bandsUsedBy, resolveRange, composeStyledRgba, describeStyle,
} from '../../core/io/rasterStyle.js'

// File-interop ops: parse a dropped/picked point-cloud, mesh or georeferenced
// raster off the main thread (a 500 MB LAS — or a 200 MB REMA tile — parsed on
// the UI thread is the trap this avoids). Pure parsing/classification lives in
// core/io/*; this marshals bytes in and flat buffers out (all in `transfer` —
// no clones of dense-scale data).
export function makeIoOps() {
  // args: [{ buffer: ArrayBuffer, name: string }] → { parsed, stats }
  // parsed: cloud { count, pos, col?, nrm? } | mesh { nVerts, count, pos, idx, col? }
  async function parseCloud([{ buffer, name }], { emit }) {
    const t0 = performance.now()
    const parsed = parseCloudFile(buffer, name, { onLog: (m, l, c) => emit('log', [m, l, c]) })
    const stats = cloudStats(parsed)
    emit('log', [`Parsed ${name}: ${stats.points.toLocaleString()} points`
      + `${stats.faces ? `, ${stats.faces.toLocaleString()} faces` : ''}`
      + ` in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'info', 'Import'])
    const transfer = [parsed.pos.buffer]
    if (parsed.col) transfer.push(parsed.col.buffer)
    if (parsed.nrm) transfer.push(parsed.nrm.buffer)
    if (parsed.idx) transfer.push(parsed.idx.buffer)
    return { result: { parsed, stats }, transfer }
  }

  // ── Georeferenced raster (reference DEM / orthophoto) ────────────────────────
  //
  // Decode a GeoTIFF, classify it DEM-vs-ortho from its own tags, and return the
  // metadata + a single flat plane. The classifier (core/io/rasterKind.js) is
  // pure and gets only extracted tags + a decimated sample, so it stays unit
  // testable without a decode.
  //
  // args: [{ buffer, name, forceKind? }]
  //   forceKind — 'dem' | 'ortho', set when the user answered the import modal or
  //               flipped the kind afterwards; skips classification.
  // → { meta, plane } with `plane` transferred:
  //     DEM   — Float32Array(width·height), nodata folded to NaN
  //     ortho — Uint8Array(width·height·4) RGBA (this IS the display data; an
  //             ortho needs no separate value plane, only geometry)
  async function parseRaster([{ buffer, name, forceKind = null, style = null }], { emit }) {
    const t0 = performance.now()
    const log = (m, l = 'info') => emit('log', [m, l, 'Import'])

    const tiff = await fromArrayBuffer(buffer)
    const image = await tiff.getImage()
    const fd = image.getFileDirectory()
    const geoKeys = image.getGeoKeys() || {}

    const width = image.getWidth()
    const height = image.getHeight()
    const bands = image.getSamplesPerPixel()
    // Tags must be read through readTiffTag — geotiff 3.x IFDs are lazy, and
    // plain `fd.SampleFormat` reads undefined, collapsing every raster to the
    // "int8, no nodata" defaults and feeding the classifier garbage.
    const sampleFormat = (await readTiffTag(fd, 'SampleFormat'))?.[0] ?? 1
    const bitsPerSample = image.getBitsPerSample?.() ?? (await readTiffTag(fd, 'BitsPerSample'))?.[0] ?? 8
    const nodata = parseNodata(await readTiffTag(fd, 'GDAL_NODATA'))

    const geoTransform = await readGeoTransform(image, fd)
    if (!geoTransform) throw new Error(`${name} carries no geotransform — not a georeferenced raster`)
    const crs = readCrs(geoKeys)

    // Decimated sample from band 0 for the classifier's histogram tier. geotiff
    // resamples on read, so this never materialises the full plane.
    const sampledValues = await readDecimatedSample(image, nodata)

    const guess = classifyRasterKind({
      bands, sampleFormat, bitsPerSample, nodata, geoKeys, sampledValues, fileName: name,
    })
    const kind = forceKind || guess.kind
    log(`Raster ${name}: ${kind.toUpperCase()} (${guess.confidence} confidence)`
      + `${forceKind ? ' — user-specified' : ''} — ${guess.reasons.join('; ')}`)
    log(`Raster ${name}: ${width}×${height}, ${bands} band(s), `
      + `${sampleFormat === 3 ? 'float' : 'int'}${bitsPerSample}, CRS ${crs || 'unknown'}`
      + `, origin ${geoTransform.originX.toPrecision(8)}/${geoTransform.originY.toPrecision(8)}`
      + `, scale ${geoTransform.scaleX}/${geoTransform.scaleY}`)

    let plane, zMin = null, zMax = null, previewDataUrl = null, dtype
    // The style actually used, echoed back on the meta so the Style modal opens
    // on what is on screen rather than on a guess it has to re-derive.
    let resolvedStyle = null

    if (kind === 'dem') {
      dtype = 'float32'
      const [band] = await image.readRasters({ samples: [0], interleave: false })
      plane = new Float32Array(width * height)
      let lo = Infinity, hi = -Infinity, valid = 0
      for (let i = 0; i < plane.length; i++) {
        const v = band[i]
        // Nodata → NaN once, here, so nothing downstream has to remember the
        // sentinel (and so a -9999 can never be averaged into a bilinear sample).
        if (!Number.isFinite(v) || (nodata != null && v === nodata)) { plane[i] = NaN; continue }
        plane[i] = v
        if (v < lo) lo = v
        if (v > hi) hi = v
        valid++
      }
      if (!valid) throw new Error(`${name} contained no valid elevation samples`)
      zMin = lo; zMax = hi
      const nodataPct = (100 * (plane.length - valid)) / plane.length
      log(`Raster ${name}: elevation ${lo.toPrecision(6)}…${hi.toPrecision(6)}`
        + `, ${nodataPct.toFixed(1)}% nodata`)
      previewDataUrl = await makePreview(
        (w, h, sub) => hillshadeRgba({
          width: w, height: h, data: sub, gsd: Math.abs(geoTransform.scaleX) * (width / w),
          zMin: lo, zMax: hi,
        }),
        plane, width, height)
    } else if (!style && !needsStyling({ bands, bitsPerSample, sampleFormat })) {
      dtype = 'uint8'
      // Fast path, unchanged: an 8-bit 1–3 band image is already display-ready.
      // readRGB resolves photometric interpretation (RGB / grey / palette / CMYK
      // / YCbCr) to 8-bit RGB — the same call utils/tiff.js leans on.
      const rgb = await image.readRGB()
      plane = new Uint8Array(width * height * 4)
      for (let i = 0, n = width * height; i < n; i++) {
        plane[i * 4] = rgb[i * 3]
        plane[i * 4 + 1] = rgb[i * 3 + 1]
        plane[i * 4 + 2] = rgb[i * 3 + 2]
        plane[i * 4 + 3] = 255
      }
      previewDataUrl = await makeRgbaPreview(plane, width, height)
    } else {
      dtype = 'uint8'
      // Band-math path: >3 bands or deeper than 8-bit, so readRGB would divide
      // by the declared bit depth and render black (Sentinel-2 reflectance ~3000
      // over a 65535 range). Read only the bands the style names, stretch each
      // from its own decimated sample, compose.
      resolvedStyle = resolveRasterStyle(style, { bands, bitsPerSample, sampleFormat })
      const used = bandsUsedBy(resolvedStyle)
      const channels = await image.readRasters({ samples: used, interleave: false })

      // Ranges come from a DECIMATED sample per band, not the full plane: the
      // percentile needs a sort, and sorting 25 M values per channel to pick two
      // numbers is minutes of work for a result that a 10k sample fixes to well
      // within a pixel value.
      const ranges = []
      if (resolvedStyle.mode !== 'index') {
        for (let c = 0; c < used.length; c++) {
          const sample = await readDecimatedSample(image, nodata, 10000, used[c])
          const manual = resolvedStyle.manual?.[c] ?? null
          ranges.push(resolveRange(sample ?? channels[c], resolvedStyle, manual))
        }
      }
      resolvedStyle.ranges = ranges
      plane = composeStyledRgba({ width, height, style: resolvedStyle, channels, ranges, nodata })
      log(`Raster ${name}: ${describeStyle(resolvedStyle)}`
        + (ranges.length ? ` — range ${ranges.map((r) => r ? `${r[0].toPrecision(4)}…${r[1].toPrecision(4)}` : '—').join(', ')}` : ''))
      previewDataUrl = await makeRgbaPreview(plane, width, height)
    }

    // The vertical datum, defaulted from the geokey when it's there. `unknown` is
    // NOT a cosmetic default — ellipsoid-vs-geoid runs tens of metres in
    // Antarctica, so the store flags it and every report derived from it says so.
    const verticalDatum = readVerticalDatum(geoKeys)
    if (kind === 'dem' && verticalDatum === 'unknown') {
      log(`Raster ${name}: vertical datum not declared — elevations may be offset `
        + '(ellipsoid vs geoid is tens of metres in polar regions). Set it on the dataset row.', 'warn')
    }

    const meta = {
      name, kind, width, height, bands, dtype,
      bitsPerSample, sampleFormat,
      // null on the 8-bit fast path and on DEMs — "this raster has no band math"
      // is a meaningful state, distinct from "styled with the defaults".
      style: resolvedStyle,
      styleable: kind !== 'dem' && needsStyling({ bands, bitsPerSample, sampleFormat }),
      crs, geoTransform, nodata: kind === 'dem' ? null : nodata, // folded to NaN for DEMs
      zMin, zMax, verticalDatum,
      classification: { ...guess, forced: !!forceKind },
      previewDataUrl,
    }
    log(`Raster ${name}: parsed in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
    return { result: { meta, plane }, transfer: [plane.buffer] }
  }

  // Recompute ONLY the display preview for a new style, without ever
  // materialising the full-resolution plane.
  //
  // This is what makes restyling feel immediate. `parseRaster` re-decodes every
  // used band at full res (seconds on a 5000² uint16 scene, plus an OPFS write)
  // — but the map and the raster tab both draw `previewDataUrl`, a ≤1024 px PNG.
  // geotiff resamples on read, so asking for the bands directly at preview size
  // is the *whole* cost: tens of milliseconds, no full plane, no write.
  //
  // The full plane is not recomputed here — it's invalidated, and
  // useExternalStore.ensureRasterLoaded re-decodes it at full res on first
  // sample/readWindow. Sampling is the only consumer that needs it, and it is
  // already lazy by design.
  //
  // **The ranges must be resolved exactly as parseRaster resolves them** — from
  // a decimated sample of the FULL image, not from the preview-sized read. A
  // percentile over the downsampled preview is a different percentile, and the
  // preview would then not predict the plane the sampler later builds.
  // args: [{ buffer, name, style }] → { style, previewDataUrl }
  async function restyleRasterPreview([{ buffer, name, style }], { emit }) {
    const t0 = performance.now()
    const log = (m, l = 'info') => emit('log', [m, l, 'Import'])

    const tiff = await fromArrayBuffer(buffer)
    const image = await tiff.getImage()
    const fd = image.getFileDirectory()

    const width = image.getWidth()
    const height = image.getHeight()
    const bands = image.getSamplesPerPixel()
    const sampleFormat = (await readTiffTag(fd, 'SampleFormat'))?.[0] ?? 1
    const bitsPerSample = image.getBitsPerSample?.() ?? (await readTiffTag(fd, 'BitsPerSample'))?.[0] ?? 8
    const nodata = parseNodata(await readTiffTag(fd, 'GDAL_NODATA'))

    const resolvedStyle = resolveRasterStyle(style, { bands, bitsPerSample, sampleFormat })
    const used = bandsUsedBy(resolvedStyle)

    const step = Math.max(1, Math.ceil(Math.max(width, height) / PREVIEW_MAX))
    const pw = Math.max(1, Math.floor(width / step))
    const ph = Math.max(1, Math.floor(height / step))
    const channels = await image.readRasters({ samples: used, interleave: false, width: pw, height: ph })

    const ranges = []
    if (resolvedStyle.mode !== 'index') {
      for (let c = 0; c < used.length; c++) {
        const sample = await readDecimatedSample(image, nodata, 10000, used[c])
        const manual = resolvedStyle.manual?.[c] ?? null
        ranges.push(resolveRange(sample ?? channels[c], resolvedStyle, manual))
      }
    }
    resolvedStyle.ranges = ranges

    const rgba = composeStyledRgba({ width: pw, height: ph, style: resolvedStyle, channels, ranges, nodata })
    const previewDataUrl = await rasterToDataUrl(new Uint8ClampedArray(rgba), pw, ph)

    log(`Raster ${name}: preview restyled — ${describeStyle(resolvedStyle)}`
      + ` (${pw}×${ph}, ${(performance.now() - t0).toFixed(0)} ms)`)
    return { result: { style: resolvedStyle, previewDataUrl } }
  }

  return { parseCloud, parseRaster, restyleRasterPreview }
}

// ── helpers ───────────────────────────────────────────────────────────────────

// GDAL_NODATA is an ASCII string tag ("-9999", "nan").
function parseNodata(raw) {
  if (raw == null) return null
  const v = parseFloat(String(raw).trim())
  return Number.isFinite(v) ? v : null
}

// ModelTiepoint + ModelPixelScale, or an axis-aligned ModelTransformation.
// geotiff's accessors resolve both forms and preserve the north-up Y convention;
// non-axis-aligned matrices are rejected because the raster model has no affine
// cross-terms.
async function readGeoTransform(image, fd) {
  const matrix = await readTiffTag(fd, 'ModelTransformation')
  if (matrix?.length && !isAxisAlignedModelTransformation(matrix)) {
    throw new Error('rotated, sheared or perspective GeoTIFF transforms are not supported')
  }
  try {
    const [originX, originY] = image.getOrigin()
    const [scaleX, scaleY] = image.getResolution()
    if (![originX, originY, scaleX, scaleY].every(Number.isFinite) || !scaleX || !scaleY) return null
    return { originX, originY, scaleX, scaleY }
  } catch {
    return null // no tiepoint/pixelscale/transformation ⇒ not georeferenced
  }
}

// The horizontal CRS as an EPSG string. Projected wins over geographic; 32767
// ("user-defined") is not a real code. Resolving it to a proj4 definition is the
// *store's* job (core/crs.js `ensureProjection` may fetch a def over the
// network, which has no business happening inside a worker op).
function readCrs(geoKeys) {
  const code = geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey
  if (!code || code === 32767) return null
  return `EPSG:${code}`
}

// VerticalCSTypeGeoKey → a label we can warn on. The EGM codes are the ones that
// actually show up; anything else declared is recorded verbatim.
function readVerticalDatum(geoKeys) {
  const v = geoKeys.VerticalCSTypeGeoKey ?? geoKeys.VerticalDatumGeoKey
  if (v == null) return 'unknown'
  if (v === 5030 || v === 4979 || v === 7030) return 'ellipsoidal'
  if (v === 5773) return 'geoid:EGM96'
  if (v === 3855) return 'geoid:EGM2008'
  return `epsg:${v}`
}

// ~10k decimated values from one band (band 0 by default) for the classifier's
// histogram tier and the style stretch, with nodata stripped (a plane that is
// 60% -9999 would otherwise read as "elevation range -9999…2000" and defeat
// every range test — and would peg a percentile stretch to the nodata value).
async function readDecimatedSample(image, nodata, target = 10000, bandIndex = 0) {
  try {
    const w = image.getWidth(), h = image.getHeight()
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / target)))
    const sw = Math.max(1, Math.floor(w / step))
    const sh = Math.max(1, Math.floor(h / step))
    const [band] = await image.readRasters({ samples: [bandIndex], interleave: false, width: sw, height: sh })
    const out = []
    for (let i = 0; i < band.length; i++) {
      const v = band[i]
      if (!Number.isFinite(v)) continue
      if (nodata != null && v === nodata) continue
      out.push(v)
    }
    return out
  } catch {
    return null // classifier just skips the histogram tier
  }
}

// Downsample a value plane to ≤1024 px on the long side, then colourise. A
// full-res preview of a 40k×40k REMA tile is neither renderable nor storable.
const PREVIEW_MAX = 1024
async function makePreview(colourise, plane, width, height) {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / PREVIEW_MAX))
  const w = Math.max(1, Math.floor(width / step))
  const h = Math.max(1, Math.floor(height / step))
  const sub = new Float32Array(w * h)
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) sub[r * w + c] = plane[(r * step) * width + c * step]
  }
  return rasterToDataUrl(colourise(w, h, sub), w, h)
}

async function makeRgbaPreview(rgba, width, height) {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / PREVIEW_MAX))
  if (step === 1) return rasterToDataUrl(new Uint8ClampedArray(rgba), width, height)
  const w = Math.max(1, Math.floor(width / step))
  const h = Math.max(1, Math.floor(height / step))
  const sub = new Uint8ClampedArray(w * h * 4)
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const s = ((r * step) * width + c * step) * 4
      const d = (r * w + c) * 4
      sub[d] = rgba[s]; sub[d + 1] = rgba[s + 1]; sub[d + 2] = rgba[s + 2]; sub[d + 3] = rgba[s + 3]
    }
  }
  return rasterToDataUrl(sub, w, h)
}
