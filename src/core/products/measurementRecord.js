// Preserve the source identity, numeric frame and units; display styling never
// invalidates a measurement. Coordinates and sampled heights are snapshots.
// An imported reference raster (useExternalStore) carries a geoTransform; a computed DEM
// or orthophoto (useReconstructionStore) its originX/originY/gsd. Not the id: since a
// project may hold several of each, computed products have ids too.
export const isReferenceRaster = (p) => !!p?.geoTransform

export function measurementSource(kind, p) {
  return isReferenceRaster(p) ? `reference:${p.id}` : `product:${kind}`
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
