// The RasterSource boundary.
//
// Every consumer of an imported reference raster (GCP Z fill, the raster tab,
// the map layer, the reconstruction-vs-reference diff) goes through this
// interface and NEVER touches a public `data[]`:
//
//   {
//     meta,                          // RasterMeta (see useExternalStore)
//     sampleAt(x, y),                // native-CRS world coords → value | null
//     readWindow(rect, level),       // { col, row, width, height } → { data, width, height }
//     previewDataUrl(),              // small pre-rendered preview, or null
//   }
//
// That indirection is the entire reason A-7 (remote COG, lazily pulling
// overviews and tiles over HTTP range requests) can land as a second
// implementation behind the same shape rather than a rewrite of every call
// site. `FlatRasterSource` (below) is the eager one: the whole plane decoded
// once into a typed array and persisted as an OPFS sidecar.

import { sampleRaster, worldToPixel, pixelToWorld, rasterBounds } from './rasterSample.js'

// meta: RasterMeta — { width, height, bands, dtype, nodata, geoTransform, … }
// data: the single-band plane (Float32Array for a DEM; for an ortho this is the
//       band-0 plane and `rgba` carries the display pixels).
export function createFlatRasterSource(meta, data, { rgba = null, previewDataUrl = null } = {}) {
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
    // Pixel-space read. `level` is accepted and ignored — a flat source has only
    // full resolution; a COG source will use it to pick an overview.
    readWindow({ col = 0, row = 0, width = meta.width, height = meta.height } = {}, _level = 0) {
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
