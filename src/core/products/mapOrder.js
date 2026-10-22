// The stacking order of the 2D map's raster layers (Sidebar ▸ Map layers). Imported
// reference rasters and the computed DEM / orthophoto stack in one list, whatever
// sidebar section they belong to. `order` is the user's list of layer ids, top first,
// kept in reconstruction.json. A layer it does not name keeps its default place and
// goes above the ordered ones: with no order at all the map stacks as it always has
// (reference rasters, then the DEM, then the orthophoto on top), and a layer added
// after a reorder lands on top, where it is seen.

// `defaultIds`: every layer's id in its default order, bottom first.
// → the ids top first, as the Map layers list shows them.
export function mapLayerIds(defaultIds, order = []) {
  const present = new Set(defaultIds)
  const named = order.filter((id) => present.has(id))
  const listed = new Set(named)
  const unnamed = defaultIds.filter((id) => !listed.has(id)).reverse()
  return [...unnamed, ...named]
}

// The layers in drawing order, bottom first (what the map adds to its raster group).
export function stackMapLayers(layers, order = []) {
  const byId = new Map(layers.map((l) => [l.id, l]))
  return mapLayerIds(
    layers.map((l) => l.id),
    order,
  )
    .reverse()
    .map((id) => byId.get(id))
}

// The list (top first) with `id` moved to `index`, clamped to the list.
export function moveMapLayer(ids, id, index) {
  const from = ids.indexOf(id)
  if (from < 0) return ids
  const out = ids.filter((x) => x !== id)
  out.splice(Math.max(0, Math.min(out.length, index)), 0, id)
  return out
}

// A stored order from reconstruction.json: an array of distinct strings, else empty.
export function normalizeMapOrder(raw) {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((id) => typeof id === 'string' && id))]
}
