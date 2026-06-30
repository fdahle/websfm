<script setup>
import { onMounted, onBeforeUnmount, ref, computed, watch } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import OSM from 'ol/source/OSM'
import WMTS, { optionsFromCapabilities } from 'ol/source/WMTS'
import WMTSCapabilities from 'ol/format/WMTSCapabilities'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Graticule from 'ol/layer/Graticule'
import Feature from 'ol/Feature'
import Point from 'ol/geom/Point'
import Polygon from 'ol/geom/Polygon'
import { Style, Circle as CircleStyle, RegularShape, Fill, Stroke } from 'ol/style'
import { get as getOlProjection } from 'ol/proj'
import { Attribution } from 'ol/control'
import { createEmpty, extend } from 'ol/extent'
import { ensureProjection, transform, crsInfo } from '../../core/crs.js'

const props = defineProps({
  images:     { type: Array,  default: () => [] },
  gcps:       { type: Array,  default: () => [] },
  footprints: { type: Array,  default: () => [] },
  poses:      { type: Array,  default: () => [] },
  selectedId: { type: String, default: null },
  crs:        { type: String, default: 'EPSG:4326' },
})

const emit = defineEmits(['select'])

const mapEl = ref(null)
const basemapNote = ref('')
const hover = ref(null)   // { text, x, y }

let map             = null
let vSource         = null
let gcpSource       = null
let footprintSource = null
let poseSource      = null

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

// GCP markers: green diamond, visually distinct from the blue image-GPS circles.
const gcpStyle = new Style({
  image: new RegularShape({
    points: 4,
    radius: 7,
    angle: Math.PI / 4,
    fill:   new Fill({ color: '#3fae6a' }),
    stroke: new Stroke({ color: '#fff', width: 1.5 }),
  }),
})

// Camera-position markers: purple triangle, distinct from GPS circles and GCP diamonds.
const poseStyle = new Style({
  image: new RegularShape({
    points: 3,
    radius: 7,
    fill:   new Fill({ color: '#b06ad9' }),
    stroke: new Stroke({ color: '#fff', width: 1.5 }),
  }),
})

const poseSelectedStyle = new Style({
  image: new RegularShape({
    points: 3,
    radius: 9,
    fill:   new Fill({ color: '#f0a500' }),
    stroke: new Stroke({ color: '#fff', width: 2 }),
  }),
})

function poseStyleFor(feature) {
  return feature.get('imgId') === props.selectedId ? poseSelectedStyle : poseStyle
}

// Footprint polygons: translucent fill + stroke; brighter when the linked image is selected.
const footprintStyle = new Style({
  fill:   new Fill({ color: 'rgba(14, 99, 156, 0.12)' }),
  stroke: new Stroke({ color: 'rgba(14, 99, 156, 0.8)', width: 1.5 }),
})

const footprintSelectedStyle = new Style({
  fill:   new Fill({ color: 'rgba(240, 165, 0, 0.22)' }),
  stroke: new Stroke({ color: '#f0a500', width: 2.5 }),
})

function footprintStyleFor(feature) {
  return feature.get('imgId') && feature.get('imgId') === props.selectedId
    ? footprintSelectedStyle
    : footprintStyle
}

// ── GPS extraction ────────────────────────────────────────────────────────────

const gpsImages = computed(() =>
  props.images.filter((img) => img.meta?.gpsLat != null && img.meta?.gpsLon != null)
)

const hasGps = computed(() => gpsImages.value.length > 0)

// GCPs are stored in the project CRS already (= the map view CRS), so they need
// no transform. Only enabled points with a valid position are plotted.
const mapGcps = computed(() =>
  props.gcps.filter((g) => g.enabled !== false && Number.isFinite(g.x) && Number.isFinite(g.y))
)
const hasGcps = computed(() => mapGcps.value.length > 0)

// Footprints are stored in the project CRS already (= the map view CRS), no transform.
const mapFootprints = computed(() =>
  props.footprints.filter((f) => f.enabled !== false && f.rings?.length)
)
const hasFootprints = computed(() => mapFootprints.value.length > 0)

// Camera poses are stored in the project CRS already (= the map view CRS), no transform.
const mapPoses = computed(() =>
  props.poses.filter((p) => p.enabled !== false && Number.isFinite(p.x) && Number.isFinite(p.y))
)
const hasPoses = computed(() => mapPoses.value.length > 0)

// ── Features ──────────────────────────────────────────────────────────────────
// Image GPS is always WGS84 (from EXIF); project it into the current view CRS.

function projectLonLat(lon, lat) {
  return transform([lon, lat], 'EPSG:4326', props.crs)
}

function makeFeature({ id, name, meta }) {
  const f = new Feature({ geometry: new Point(projectLonLat(meta.gpsLon, meta.gpsLat)) })
  f.set('imgId', id)
  f.set('name', name)
  return f
}

function makeGcpFeature(g) {
  const f = new Feature({ geometry: new Point([g.x, g.y]) })
  f.set('gcpName', g.name)
  return f
}

function makeFootprintFeature(fp) {
  const f = new Feature({ geometry: new Polygon(fp.rings) })
  f.set('footprintName', fp.name)
  if (fp.imageId) f.set('imgId', fp.imageId)
  return f
}

function makePoseFeature(p) {
  const f = new Feature({ geometry: new Point([p.x, p.y]) })
  f.set('poseName', p.imageName)
  if (p.imageId) f.set('imgId', p.imageId)
  return f
}

function refreshFeatures() {
  if (!vSource) return
  vSource.clear(true)
  vSource.addFeatures(gpsImages.value.map(makeFeature))
  fitToMarkers()
}

function refreshGcps() {
  if (!gcpSource) return
  gcpSource.clear(true)
  gcpSource.addFeatures(mapGcps.value.map(makeGcpFeature))
  fitToMarkers()
}

function refreshFootprints() {
  if (!footprintSource) return
  footprintSource.clear(true)
  footprintSource.addFeatures(mapFootprints.value.map(makeFootprintFeature))
  fitToMarkers()
}

function refreshPoses() {
  if (!poseSource) return
  poseSource.clear(true)
  poseSource.addFeatures(mapPoses.value.map(makePoseFeature))
  fitToMarkers()
}

function fitToMarkers() {
  if (!map) return
  const features = [...(vSource?.getFeatures() || []), ...(gcpSource?.getFeatures() || []), ...(footprintSource?.getFeatures() || []), ...(poseSource?.getFeatures() || [])]
  if (!features.length) return
  const geom = features.length === 1 ? features[0].getGeometry() : null
  if (geom?.getType() === 'Point') {
    map.getView().animate({ center: geom.getCoordinates(), zoom: 17, duration: 300 })
    return
  }
  let extent = createEmpty()
  for (const f of features) extend(extent, f.getGeometry().getExtent())
  map.getView().fit(extent, { padding: [48, 48, 48, 48], maxZoom: 18, duration: 300 })
}

// ── Basemap ─────────────────────────────────────────────────────────────────
// OSM (auto-reprojected by OL) for Mercator-compatible CRS; NASA GIBS WMTS for
// polar CRS. A graticule is always drawn so any CRS is usable even without tiles.

function makeOsmLayer() {
  return new TileLayer({ source: new OSM() })
}

async function addGibsLayer(info) {
  // Fetch + parse capabilities, then build the WMTS source for the configured layer.
  const url = `${info.gibs.endpoint}?SERVICE=WMTS&REQUEST=GetCapabilities`
  const text = await (await fetch(url)).text()
  const caps = new WMTSCapabilities().read(text)
  const opts = optionsFromCapabilities(caps, {
    layer: info.gibs.layer,
    matrixSet: info.gibs.matrixSet,
  })
  if (!opts) throw new Error('GIBS layer not found in capabilities')
  return new TileLayer({ source: new WMTS(opts) })
}

// ── Map (re)build ─────────────────────────────────────────────────────────────
// OpenLayers can't change a View's projection in place, so we rebuild the map
// whenever the project CRS changes.

async function build() {
  await ensureProjection(props.crs).catch(() => {})
  const info = crsInfo(props.crs)
  const projection = getOlProjection(props.crs)
  // crs.js gives every projection an extent; fall back to the catalog value.
  const viewExtent = projection?.getExtent() || info.extent || null
  basemapNote.value = ''

  vSource = new VectorSource({ features: gpsImages.value.map(makeFeature) })
  gcpSource = new VectorSource({ features: mapGcps.value.map(makeGcpFeature) })
  footprintSource = new VectorSource({ features: mapFootprints.value.map(makeFootprintFeature) })
  poseSource = new VectorSource({ features: mapPoses.value.map(makePoseFeature) })

  const graticule = new Graticule({
    strokeStyle: new Stroke({ color: 'rgba(140,140,140,0.45)', width: 1 }),
    showLabels: true,
    wrapX: false,
  })

  map = new Map({
    target: mapEl.value,
    layers: [
      graticule,
      new VectorLayer({ source: footprintSource, style: footprintStyleFor }),
      new VectorLayer({ source: vSource, style: styleFor }),
      new VectorLayer({ source: gcpSource, style: gcpStyle }),
      new VectorLayer({ source: poseSource, style: poseStyleFor }),
    ],
    view: new View({
      projection: projection || 'EPSG:3857',
      center: viewExtent
        ? [(viewExtent[0] + viewExtent[2]) / 2, (viewExtent[1] + viewExtent[3]) / 2]
        : [0, 0],
      zoom: viewExtent ? 3 : 2,
      extent: info.extent || undefined,
    }),
    controls: [new Attribution({ collapsible: true })],
  })

  // Add the basemap below the graticule (index 0).
  if (info.basemap === 'osm') {
    map.getLayers().insertAt(0, makeOsmLayer())
  } else if (info.basemap === 'gibs') {
    addGibsLayer(info)
      .then((layer) => { if (map) map.getLayers().insertAt(0, layer) })
      .catch(() => { basemapNote.value = 'Polar basemap unavailable — showing graticule only.' })
  }

  fitToMarkers()

  map.on('click', (e) => {
    const hit = map.forEachFeatureAtPixel(e.pixel, (f) => f)
    const imgId = hit?.get('imgId')
    if (imgId) emit('select', imgId)
  })

  map.on('pointermove', (e) => {
    const hit = map.forEachFeatureAtPixel(e.pixel, (f) => f)
    map.getViewport().style.cursor = hit ? 'pointer' : ''
    if (hit) {
      const gcpName = hit.get('gcpName')
      const fpName = hit.get('footprintName')
      const poseName = hit.get('poseName')
      const text = gcpName ? `GCP: ${gcpName}`
        : fpName ? `Footprint: ${fpName}`
        : poseName ? `Camera: ${poseName}`
        : hit.get('name')
      hover.value = { text, x: e.pixel[0], y: e.pixel[1] }
    } else {
      hover.value = null
    }
  })
}

function destroy() {
  map?.setTarget(null)
  map = null
  vSource = null
  gcpSource = null
  footprintSource = null
  poseSource = null
  hover.value = null
}

// ── Watchers ──────────────────────────────────────────────────────────────────

// gpsImages reruns whenever any image's meta changes (Vue tracks .gpsLat/.gpsLon access)
watch(gpsImages, refreshFeatures)

// Rebuild GCP markers when the GCP list changes
watch(mapGcps, refreshGcps)

// Rebuild footprint polygons when the footprint list changes (deep: imageId may
// be re-resolved in place by retroactive matching)
watch(mapFootprints, refreshFootprints, { deep: true })

// Rebuild pose markers when the pose list changes (deep: imageId may be
// re-resolved in place by retroactive matching)
watch(mapPoses, refreshPoses, { deep: true })

// Re-style on selection change without rebuilding features
watch(() => props.selectedId, () => { vSource?.changed(); footprintSource?.changed(); poseSource?.changed() })

// Rebuild the whole map when the project CRS changes
watch(() => props.crs, async () => {
  destroy()
  await build()
  map?.updateSize()
})

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let resizeObserver = null

onMounted(async () => {
  await build()
  resizeObserver = new ResizeObserver(() => map?.updateSize())
  resizeObserver.observe(mapEl.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  destroy()
})

// ── Imperative API ────────────────────────────────────────────────────────────

// Centre the view on an image's position — its imported pose if present,
// otherwise its EXIF GPS. No-op if the image has neither.
function zoomToImage(imgId) {
  if (!map) return
  let coord = null
  const pose = props.poses.find((p) => p.imageId === imgId && Number.isFinite(p.x) && Number.isFinite(p.y))
  if (pose) {
    coord = [pose.x, pose.y]
  } else {
    const img = props.images.find((i) => i.id === imgId)
    if (img?.meta?.gpsLat != null && img?.meta?.gpsLon != null) {
      coord = projectLonLat(img.meta.gpsLon, img.meta.gpsLat)
    }
  }
  if (!coord) return
  map.getView().animate({ center: coord, zoom: 17, duration: 300 })
}

defineExpose({ zoomToImage, fitView: fitToMarkers })
</script>

<template>
  <div class="map-viewer">
    <div ref="mapEl" class="ol-map" />
    <div v-if="!hasGps && !hasGcps && !hasFootprints && !hasPoses" class="no-gps-hint">
      No coordinates found — images with geotags, imported GCPs, or camera positions appear as markers here.
    </div>
    <div v-if="basemapNote" class="basemap-note">{{ basemapNote }}</div>

    <div v-if="hover" class="hover-label" :style="{ left: hover.x + 12 + 'px', top: hover.y + 12 + 'px' }">
      {{ hover.text }}
    </div>

    <div v-if="hasGcps || hasFootprints || hasPoses" class="legend">
      <span class="legend-item"><span class="legend-dot img"></span>Image GPS</span>
      <span v-if="hasGcps" class="legend-item"><span class="legend-dot gcp"></span>GCP</span>
      <span v-if="hasPoses" class="legend-item"><span class="legend-dot pose"></span>Camera</span>
      <span v-if="hasFootprints" class="legend-item"><span class="legend-dot footprint"></span>Footprint</span>
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

.basemap-note {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 12px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-dim);
  pointer-events: none;
  white-space: nowrap;
}

.hover-label {
  position: absolute;
  padding: 3px 7px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  font-size: 11px;
  color: var(--text);
  pointer-events: none;
  white-space: nowrap;
  z-index: 2;
}

.legend {
  position: absolute;
  bottom: 10px;
  left: 10px;
  display: flex;
  gap: 12px;
  padding: 6px 10px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-dim);
  pointer-events: none;
}

.legend-item { display: flex; align-items: center; gap: 5px; }

.legend-dot { width: 9px; height: 9px; display: inline-block; }
.legend-dot.img { background: #0e639c; border-radius: 50%; }
.legend-dot.gcp { background: #3fae6a; transform: rotate(45deg); }
.legend-dot.pose { width: 0; height: 0; background: none; border-left: 5px solid transparent; border-right: 5px solid transparent; border-bottom: 9px solid #b06ad9; }
.legend-dot.footprint { background: rgba(14, 99, 156, 0.2); border: 1.5px solid rgba(14, 99, 156, 0.8); }
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
