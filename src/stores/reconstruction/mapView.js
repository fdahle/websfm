// The 2D map's view state kept in reconstruction.json: each product's layer
// (visible, opacity), the layer stack, the unticked layers and the Photos layer.
//
// Moved verbatim from the store: what it shares comes in by name; names the store
// defines further down come in late (late.js).

import { ref, watch } from 'vue'
import { productMapBlocker } from '../../core/products/productLayers.js'
import { normalizeMapOrder } from '../../core/products/mapOrder.js'
import { IMAGE_LAYER_ID, normalizeImageLayer } from '../../core/products/imageOverlay.js'

export function createMapView({ dem, ortho, save }) {
  // Map-layer view state per computed product, by its id ({ 'dem-…': { visible,
  // opacity }, … }; core/products/productLayers.js). Kept in reconstruction.json, NOT
  // on the product record: saving a product rewrites its raster buffers, and a map
  // toggle must not. A rebuild in place keeps its id, so a DEM on the map stays there.
  const productLayers = ref({})
  // A new main product with no layer state yet (a new build, or Set as main on one
  // never shown) takes the place of the main one before it: on the map if that one
  // was, or if it is the first of its kind, as a new layer does in a GIS; the one
  // before leaves the map. One taken off the map has an entry, and stays off.
  for (const product of [dem, ortho]) {
    watch(product, (now, before) => {
      if (!now || productLayers.value[now.id] || productMapBlocker(now)) return
      const prev = before && before.id !== now.id ? productLayers.value[before.id] : null
      const next = {
        ...productLayers.value,
        [now.id]: { visible: prev ? prev.visible : true, opacity: prev?.opacity ?? 1 },
      }
      if (prev?.visible) next[before.id] = { ...prev, visible: false }
      productLayers.value = next
    })
  }
  // The 2D map's layer stack, top first (core/products/mapOrder.js): the ids of
  // reference rasters, `product:<product id>` and `vector:<set id>`. Empty =
  // the default.
  const mapOrder = ref([])
  function setMapOrder(ids) {
    mapOrder.value = normalizeMapOrder(ids)
    save()
  }
  // The ids of layers on the map that are unticked in View ▸ Map ▸ Layers: still
  // listed there, not drawn. Being on the map at all is the layer's own `visible`
  // (a raster record, productLayers, a vector set), which the sidebar sets.
  const mapHidden = ref([])
  function setMapLayerHidden(id, hidden) {
    const rest = mapHidden.value.filter((x) => x !== id)
    const next = hidden ? [...rest, id] : rest
    if (next.length === mapHidden.value.length) return
    mapHidden.value = next
    save()
  }
  // The Photos layer (View ▸ Map ▸ Photos, core/products/imageOverlay.js):
  // { visible, opacity, mode: 'selected' | 'all' }, null until first put on the map.
  const imageLayer = ref(null)
  function setImageLayer(patch) {
    const next = normalizeImageLayer({ visible: false, opacity: 1, mode: 'selected', ...imageLayer.value, ...patch })
    // Put back on the map, it is listed ticked, as any layer added from the sidebar.
    if (next.visible && !imageLayer.value?.visible) setMapLayerHidden(IMAGE_LAYER_ID, false)
    imageLayer.value = next
    save()
  }

  return { productLayers, mapOrder, setMapOrder, mapHidden, setMapLayerHidden, imageLayer, setImageLayer }
}
