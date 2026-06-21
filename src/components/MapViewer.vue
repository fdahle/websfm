<script setup>
import { onMounted, onBeforeUnmount, ref, computed, watch } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import OSM from 'ol/source/OSM'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import Point from 'ol/geom/Point'
import { Style, Circle as CircleStyle, Fill, Stroke } from 'ol/style'
import { fromLonLat } from 'ol/proj'
import { Attribution } from 'ol/control'
import { createEmpty, extend } from 'ol/extent'

const props = defineProps({
  images:     { type: Array,  default: () => [] },
  selectedId: { type: String, default: null },
})

const emit = defineEmits(['select'])

const mapEl = ref(null)

let map     = null
let vSource = null

// ── Styles ────────────────────────────────────────────────────────────────────

const normalStyle = new Style({
  image: new CircleStyle({
    radius: 6,
    fill:   new Fill({ color: '#0e639c' }),
    stroke: new Stroke({ color: '#fff', width: 1.5 }),
  }),
})

const selectedStyle = new Style({
  image: new CircleStyle({
    radius: 8,
    fill:   new Fill({ color: '#f0a500' }),
    stroke: new Stroke({ color: '#fff', width: 2 }),
  }),
})

function styleFor(feature) {
  return feature.get('imgId') === props.selectedId ? selectedStyle : normalStyle
}

// ── GPS extraction ────────────────────────────────────────────────────────────

const gpsImages = computed(() =>
  props.images.filter((img) => img.meta?.gpsLat != null && img.meta?.gpsLon != null)
)

const hasGps = computed(() => gpsImages.value.length > 0)

// ── Features ──────────────────────────────────────────────────────────────────

function makeFeature({ id, name, meta }) {
  const f = new Feature({ geometry: new Point(fromLonLat([meta.gpsLon, meta.gpsLat])) })
  f.set('imgId', id)
  f.set('name', name)
  return f
}

function refreshFeatures() {
  if (!vSource) return
  vSource.clear(true)
  vSource.addFeatures(gpsImages.value.map(makeFeature))
  fitToMarkers()
}

function fitToMarkers() {
  if (!map || !vSource) return
  const features = vSource.getFeatures()
  if (!features.length) return
  if (features.length === 1) {
    map.getView().animate({ center: features[0].getGeometry().getCoordinates(), zoom: 17, duration: 300 })
    return
  }
  let extent = createEmpty()
  for (const f of features) extend(extent, f.getGeometry().getExtent())
  map.getView().fit(extent, { padding: [48, 48, 48, 48], maxZoom: 18, duration: 300 })
}

// ── OL init ───────────────────────────────────────────────────────────────────

function init() {
  vSource = new VectorSource({ features: gpsImages.value.map(makeFeature) })

  map = new Map({
    target: mapEl.value,
    layers: [
      new TileLayer({ source: new OSM() }),
      new VectorLayer({ source: vSource, style: styleFor }),
    ],
    view: new View({ center: [0, 0], zoom: 2 }),
    controls: [new Attribution({ collapsible: true })],
  })

  fitToMarkers()

  map.on('click', (e) => {
    const hit = map.forEachFeatureAtPixel(e.pixel, (f) => f)
    if (hit) emit('select', hit.get('imgId'))
  })

  map.on('pointermove', (e) => {
    map.getViewport().style.cursor = map.hasFeatureAtPixel(e.pixel) ? 'pointer' : ''
  })
}

// ── Watchers ──────────────────────────────────────────────────────────────────

// gpsImages reruns whenever any image's meta changes (Vue tracks .gpsLat/.gpsLon access)
watch(gpsImages, refreshFeatures)

// Re-style on selection change without rebuilding features
watch(() => props.selectedId, () => vSource?.changed())

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let resizeObserver = null

onMounted(() => {
  init()
  resizeObserver = new ResizeObserver(() => map?.updateSize())
  resizeObserver.observe(mapEl.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  map?.setTarget(null)
})
</script>

<template>
  <div class="map-viewer">
    <div ref="mapEl" class="ol-map" />
    <div v-if="!hasGps" class="no-gps-hint">
      No GPS coordinates found — images with geotags will appear as markers here.
    </div>
  </div>
</template>

<style scoped>
.map-viewer {
  position: absolute;
  inset: 0;
  background: var(--bg);
}

.ol-map {
  width: 100%;
  height: 100%;
}

.no-gps-hint {
  position: absolute;
  bottom: 40px;
  left: 50%;
  transform: translateX(-50%);
  padding: 7px 14px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-dim);
  pointer-events: none;
  white-space: nowrap;
}
</style>

<style>
/* OL attribution — blend with dark theme */
[data-theme="dark"] .ol-attribution button,
[data-theme="dark"] .ol-attribution ul {
  background: rgba(20, 20, 20, 0.8);
  color: #aaa;
}
[data-theme="dark"] .ol-attribution a { color: #6ba3d6; }
</style>
