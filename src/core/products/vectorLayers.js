// The vector sets of stores/useFootprintsStore.js as the 2D map and the sidebar use
// them. A computed polygon set is the image footprints: camera geometry, drawn as an
// overlay above everything (View ▸ Map ▸ Footprints), with no sidebar row. Every
// other set is a map layer in the one stack the rasters use (core/products/mapOrder.js,
// View ▸ Map ▸ Layers): contour lines from the DEM sit in Products, an imported
// polygon file in Reference Data.

/** True for the computed image footprints (the overlay), false for a layer. */
export const isFootprintSet = (set) => set?.source === 'computed' && set?.kind !== 'lines'

/** The sidebar section a layer set belongs to: 'products' | 'reference', or null for the footprints. */
export function vectorSection(set) {
  if (isFootprintSet(set)) return null
  return set.source === 'imported' ? 'reference' : 'products'
}

/** A set's id in the map's layer stack (mapOrder.js), beside `product:dem` and raster ids. */
export const vectorLayerId = (setId) => `vector:${setId}`

/** 'lines' (contours) or 'polygons' (an imported file). */
export const vectorKind = (set) => (set.kind === 'lines' ? 'lines' : 'polygons')

// A number per feature list, so `rev` names the list without holding it.
const listIds = new WeakMap()
let nextListId = 0
function listId(list) {
  if (!listIds.has(list)) listIds.set(list, ++nextListId)
  return listIds.get(list)
}

/**
 * The layer sets that are on the map, as stack entries (bottom first, in list order):
 * { id, vector: true, kind, name, setId, opacity, rev, features() }. `features` is a
 * function so a deep watch on the entries never walks every coordinate; `rev` changes
 * when the feature list is replaced (a re-projection) or its image links change (an
 * imported polygon file links up later), and only then.
 */
export function vectorMapLayers(sets) {
  return sets
    .filter((s) => !isFootprintSet(s) && s.visible !== false)
    .map((s) => ({
      id: vectorLayerId(s.id),
      vector: true,
      kind: vectorKind(s),
      name: s.name,
      setId: s.id,
      opacity: s.opacity ?? 1,
      rev: `${listId(s.footprints)}:${s.footprints.reduce((n, fp) => n + (fp.imageId ? 1 : 0), 0)}`,
      features: () => s.footprints.map((fp) => ({ ...fp, setId: s.id, setName: s.name })),
    }))
}
