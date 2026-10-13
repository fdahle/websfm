// Computed DEM/orthophoto as map layers (CLAUDE.md ▸ useExternalStore, map raster layers).
// Pure: the store keeps the per-product layer state, this turns a product + that
// state into the same layer descriptor ViewerMap draws for an imported raster, so
// the map has one raster-layer concept whoever made the raster.

import { productDescriptor, productTiledMeta } from '../io/rasterSource.js'
import { MODEL_MAP_CRS, frameOffset } from './modelMap.js'

export const PRODUCT_KINDS = ['dem', 'ortho']

// The persisted per-product view state: { dem: { onMap, opacity }, ortho: … }.
// Unknown kinds and malformed values are dropped, so an old or hand-edited
// reconstruction.json can never put a layer on the map by accident.
export function normalizeProductLayers(raw) {
  const out = {}
  for (const kind of PRODUCT_KINDS) {
    const v = raw?.[kind]
    if (!v || typeof v !== 'object') continue
    const opacity = Number(v.opacity)
    out[kind] = { onMap: v.onMap === true, opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1 }
  }
  return out
}

// Why a product can never be drawn on a map, or null. Its FRAME is not a reason:
// "On Map" is a request, honoured whenever the map's current frame can place the
// product (placeProductLayer) and explained on the map when it cannot.
export function productMapBlocker(product) {
  if (!product) return 'Build the product first'
  if (!product.previewUrl) return 'This product has no preview image — rebuild it'
  if (!productDescriptor(product)) return 'This product has no recorded geometry — rebuild it'
  return null
}

export const productLabel = (kind, product) => product?.name || (kind === 'ortho' ? 'Orthophoto' : 'DEM')

// Place an on-map product in the map's current frame.
//   view: { mode: 'crs' } | { mode: 'model', frame, stale: Set<kind> }
//         — `frame` is the map's local frame (frameSpec.js), `stale` the products
//           built on an older sparse model (productFrameStatus).
// → null (not requested) | { reason } (requested, cannot be drawn here) |
//   { layer } — the descriptor ViewerMap consumes, the same fields as an imported
//   raster's RasterMeta; `product: true` means no tiled original behind it.
//
// CRS map: a CRS product draws in its own CRS (OL reprojects); a local one has no
// CRS position — placing it would need the georeference's rotation, and a static
// image layer cannot rotate. Model map: a local product is translated by its
// frame's origin offset (modelMap.js frameOffset); a CRS one cannot be placed.
export function placeProductLayer(kind, product, state, view) {
  if (!state?.onMap) return null
  const blocker = productMapBlocker(product)
  if (blocker) return { reason: blocker }
  const local = !product.crs || product.crs === 'local'
  const desc = productDescriptor(product)
  let crs = product.crs, gt = desc.geoTransform, offset = null
  if (view.mode === 'crs') {
    if (local) return { reason: 'it is in the model frame — turn on Map ▸ Model Frame to see it' }
  } else {
    if (view.stale?.has(kind)) return { reason: 'it was built on an older sparse model — rebuild it' }
    const off = frameOffset(product.frame, view.frame)
    if (off.reason) return { reason: off.reason }
    crs = MODEL_MAP_CRS
    gt = { ...gt, originX: gt.originX + off.dx, originY: gt.originY + off.dy }
    offset = [off.dx, off.dy]
  }
  // A computed ortho draws its stored COG as GPU tiles, like an imported raster. The
  // tiles carry the file's own geotransform, so a model-map layer shifted by a frame
  // offset falls back to the preview image, which can be placed anywhere.
  const tiled = productTiledMeta(kind, product)
  const cog = tiled && !(offset && (offset[0] || offset[1])) ? product.cog : null
  return { layer: {
    id: `product:${kind}`,
    product: true,
    kind,
    name: productLabel(kind, product),
    crs,
    width: desc.width,
    height: desc.height,
    geoTransform: gt,
    // The map's raster layer takes any URL: a computed product's is a blob: URL.
    previewDataUrl: product.previewUrl,
    opacity: state.opacity ?? 1,
    // Model map only: product coords = map coords − offset (the status-bar probe).
    offset,
    ...(cog && { cog, fileKey: tiled.fileKey, bands: tiled.bands, bitsPerSample: 8, sampleFormat: 1,
      photometric: tiled.photometric, alphaBand: tiled.alphaBand }),
  } }
}
