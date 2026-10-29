// Preserve the source identity, numeric frame and units; display styling never
// invalidates a measurement. Coordinates and sampled heights are snapshots.
// An imported reference raster (useExternalStore) carries a geoTransform; a computed DEM
// or orthophoto (useReconstructionStore) its originX/originY/gsd. Not the id: since a
// project may hold several of each, computed products have ids too.
export const isReferenceRaster = (p) => !!p?.geoTransform

export function measurementSource(kind, p) {
  return isReferenceRaster(p) ? `reference:${p.id}` : `product:${p?.id ?? kind}`
}
// Whether a saved record was measured on `p`. One saved before measurements named
// the product by id names its kind (`product:dem`), and stands for the main one.
export function measuredOn(record, kind, p, isMain = false) {
  if (record.source === measurementSource(kind, p)) return true
  return !!isMain && !isReferenceRaster(p) && record.source === `product:${kind}`
}
// The computed product a `product:` source names, or null: by id, or a kind
// (an older record) for the main one of that kind.
export function productOfSource(source, { productById, mainOf }) {
  if (!source?.startsWith('product:')) return null
  const key = source.slice('product:'.length)
  return key === 'dem' || key === 'ortho' ? mainOf(key) : productById(key)
}
export function measurementStamp(p) {
  if (!p) return null
  return JSON.stringify([
    p.createdAt ?? p.importedAt ?? null,
    p.width,
    p.height,
    p.geoTransform ?? [p.originX, p.originY, p.gsd],
    p.crs,
    p.unit,
    p.verticalUnit,
    p.frameStamp ?? p.frame ?? null,
    p.vOffset ?? 0,
  ])
}
export function measurementStale(record, product, frameStatus) {
  return !product || !!frameStatus?.stale || record.stamp !== measurementStamp(product)
}
