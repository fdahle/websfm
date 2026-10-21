// The OpenLayers handles of ONE built map (ViewerMap.vue's build()), in one place.
//
// ViewerMap rebuilds the whole map whenever its frame changes (OpenLayers can't
// change a View's projection in place), so every handle below is replaced on each
// build and nulled by destroy(). Code outside build() — watchers, event handlers,
// the extracted helpers — reads them through this object AT CALL TIME
// (`ctx.map`, never a copy taken earlier), so nothing keeps talking to a map
// that a rebuild has already torn down.
//
// Deliberately a plain object, never ref()/reactive(): Vue proxies around OL
// objects break identity checks and cost a proxy hop per access in render loops.
// Sealed, so a mistyped handle name throws (in strict-mode modules) instead of
// quietly creating a second field.
//
// The raster layer group and its id → layer index are owned by
// composables/useMapRasterLayers.js, which reads `ctx.map` from here.

const EMPTY = () => ({
  map: null, // ol/Map
  vSource: null, // image GPS markers
  vLayer: null,
  gcpSource: null,
  gcpLayer: null,
  gcpTranslate: null, // drag-to-place interaction (GCP edit mode)
  footprintSource: null,
  footprintLayer: null,
  poseSource: null,
  poseLayer: null,
  grid: null, // { layer, update(map) } — see mapGridLayer.js
})

export function createMapContext() {
  return Object.seal(EMPTY())
}

/** Drop every handle (destroy()); the caller detaches the map first. */
export function clearMapContext(ctx) {
  Object.assign(ctx, EMPTY())
}
