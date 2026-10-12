// The RasterSource boundary.
//
// Every consumer of an imported reference raster (GCP Z fill, the raster tab,
// the map layer, the reconstruction-vs-reference diff) goes through this
// interface and NEVER touches a public `data[]`:
//
//   {
//     meta,                          // RasterMeta (see useExternalStore)
//     sampleAt(x, y),                // native-CRS world coords → value | null
//     cellValueAt(x, y),             // the containing cell's value, no fallback
//     readWindow(rect, level),       // await → { data, width, height, … }
//     previewDataUrl(),              // small pre-rendered preview, or null
//   }
//
// That indirection is the entire reason A-7 (remote COG, lazily pulling
// overviews and tiles over HTTP range requests) can land as a second
// implementation behind the same shape rather than a rewrite of every call
// site. `FlatRasterSource` (below) is the eager one: the whole plane decoded
// once into a typed array and persisted as an OPFS sidecar.

import { sampleRaster, cellValue, worldToPixel, pixelToWorld, rasterBounds } from './rasterSample.js'

// One descriptor for both raster shapes: an imported raster carries a full
// `geoTransform`; a computed DEM/ortho carries { originX, originY, gsd } on a
// north-up grid with square cells (scaleX = gsd, scaleY = −gsd, origin at the
// top-left CORNER — dem.js `cellCenter` adds the half cell). Null when the record
// has no geometry.
export function productDescriptor(product) {
  if (!product) return null
  if (product.geoTransform) return { width: product.width, height: product.height, geoTransform: product.geoTransform }
  if (product.gsd == null) return null
  return {
    width: product.width,
    height: product.height,
    geoTransform: { originX: product.originX, originY: product.originY, scaleX: product.gsd, scaleY: -product.gsd },
  }
}

// A computed DEM/orthophoto behind the same RasterSource boundary as an imported
// raster, so tools never ask which kind they were handed. A DEM's value plane
// already marks nodata as NaN (its `mask` mirrors that, plus filled cells); an
// ortho has no value plane, only display RGBA.
export function createProductRasterSource(kind, product) {
  const desc = productDescriptor(product)
  if (!desc) return null
  const meta = { width: desc.width, height: desc.height, bands: kind === 'dem' ? 1 : 4,
    dtype: kind === 'dem' ? 'float32' : 'uint8', nodata: null, geoTransform: desc.geoTransform,
    crs: product.crs ?? null }
  return createFlatRasterSource(meta, kind === 'dem' ? (product.data ?? null) : null, {
    rgba: kind === 'dem' ? null : (product.rgba ?? null),
    previewDataUrl: product.previewUrl ?? null,
  })
}

// meta: RasterMeta — { width, height, bands, dtype, nodata, geoTransform, … }
// data: the single-band plane (Float32Array for a DEM; for an ortho this is the
//       band-0 plane and `rgba` carries the display pixels).
// Original-backed ortho reads are asynchronous and also return raw `channels`,
// pixel offsets and per-axis scales (bounded output may be downsampled).
export function createFlatRasterSource(meta, data, { rgba = null, previewDataUrl = null, readRawWindow = null } = {}) {
  // The descriptor the shared sampler wants. Built once — sampleAt is called per
  // GCP and, in the viewer, per cursor move.
  const desc = {
    width: meta.width,
    height: meta.height,
    data,
    nodata: meta.nodata ?? null,
    geoTransform: meta.geoTransform,
  }

  return {
    meta,
    kind: 'flat',
    // Native-CRS world coordinates in, value out. Callers holding a point in the
    // *project* CRS must reproject first (useExternalStore.sampleReferenceDem
    // does) — this deliberately knows nothing about the project CRS, so the
    // raster never has to be warped.
    sampleAt(x, y) {
      return sampleRaster(desc, x, y)
    },
    // The value of the cell containing (x, y), or null on nodata — never a
    // neighbour's. For cursor readouts (rasterSample.js cellValue).
    cellValueAt(x, y) {
      return cellValue(desc, x, y)
    },
    // Pixel-space read. `level` is accepted and ignored — a flat source has only
    // full resolution; a COG source will use it to pick an overview.
    readWindow({ col = 0, row = 0, width = meta.width, height = meta.height } = {}, _level = 0) {
      if (readRawWindow) return readRawWindow({ col, row, width, height }, _level)
      if (!data) throw new Error('Raw raster pixels are unavailable; re-import the original raster')
      const c0 = Math.max(0, Math.floor(col))
      const r0 = Math.max(0, Math.floor(row))
      const w = Math.min(meta.width - c0, Math.ceil(width))
      const h = Math.min(meta.height - r0, Math.ceil(height))
      if (w <= 0 || h <= 0) return { data: new Float32Array(0), width: 0, height: 0 }
      const out = new Float32Array(w * h)
      for (let r = 0; r < h; r++) {
        const src = (r0 + r) * meta.width + c0
        for (let c = 0; c < w; c++) out[r * w + c] = data[src + c]
      }
      return { data: out, width: w, height: h }
    },
    previewDataUrl() {
      return previewDataUrl
    },
    // Display pixels for an ortho (RGBA, full res), or null for a DEM — the DEM
    // tab renders through core/products/colormap.js from the value plane instead.
    rgba() {
      return rgba
    },
    // Geometry helpers, so callers don't reach for rasterSample.js themselves.
    worldToPixel: (x, y) => worldToPixel(desc, x, y),
    pixelToWorld: (col, row) => pixelToWorld(desc, col, row),
    bounds: () => rasterBounds(desc),
    // Raw plane access, deliberately named so it reads as an escape hatch at the
    // call site (the exporters and the diff need the whole plane at once).
    unsafePlane: () => data,
  }
}
