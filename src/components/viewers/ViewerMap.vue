<script setup>
import 'ol/ol.css'
import { onMounted, onBeforeUnmount, ref, computed, watch } from 'vue'
// Aliased: a bare `Map` import shadows the global Map constructor.
import OlMap from 'ol/Map'
import View from 'ol/View'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Polygon from 'ol/geom/Polygon'
import { get as getOlProjection, addProjection } from 'ol/proj'
import Projection from 'ol/proj/Projection'
import { Attribution } from 'ol/control'
import Translate from 'ol/interaction/Translate'
import DoubleClickZoom from 'ol/interaction/DoubleClickZoom'
import { createEmpty, extend, isEmpty as extentIsEmpty } from 'ol/extent'
import { ensureProjection, transform, crsInfo } from '../../core/crs.js'
import { createGeneration } from '../../utils/generation.js'
import { productDescriptor } from '../../core/io/rasterSource.js'
import { chooseBasemap } from '../../core/basemapChoice.js'
import {
  gpsImagesOf, plottedGcps, modelMarkerGcps, gcpPlacement, plottedFootprints, plottedPoses, modelCameraPoses,
  isUnaligned, hoverText, linkedImageOf,
} from '../../core/mapData.js'
import { useContextMenu } from '../../composables/useContextMenu.js'
import { copyToClipboard } from '../../composables/useToasts.js'
import { useMapSettings } from '../../composables/useMapSettings.js'
import { useMapRasterLayers } from '../../composables/useMapRasterLayers.js'
import { createMapContext, clearMapContext } from './map/mapContext.js'
import { imageStyle, gcpStyle, poseStyle, footprintStyle } from './map/mapStyles.js'
import { projectLonLat, makeImageFeature, makeGcpFeature, makeFootprintFeature, makePoseFeature } from './map/mapFeatures.js'
import { makeBasemapLayer, makeGibsLayer } from './map/mapBasemaps.js'
import { watchTileFailures } from '../../utils/tileFailures.js'
import { online } from '../../composables/useOnlineStatus.js'
import { makeGridLayer } from './map/mapGridLayer.js'
import ViewerContextMenu from './ViewerContextMenu.vue'
import GcpToolbar from './GcpToolbar.vue'
import RasterMeasurements from './RasterMeasurements.vue'

// Module map (this file keeps the lifecycle, interactions and watchers):
//   map/mapContext.js              the built map's OL handles (`ctx`)
//   map/mapStyles.js               marker styles
//   map/mapFeatures.js             marker features
//   map/mapBasemaps.js             base layers      (choice: core/basemapChoice.js)
//   map/mapGridLayer.js            grid layer       (lines/labels: core/mapGrid.js)
//   composables/useMapRasterLayers raster layer reconcile
//   core/mapData.js                what gets plotted, hover text

const { basemap, satelliteUrl, satelliteAttribution } = useMapSettings()

const props = defineProps({
  images:     { type: Array,  default: () => [] },
  gcps:       { type: Array,  default: () => [] },
  footprints: { type: Array,  default: () => [] },
  poses:      { type: Array,  default: () => [] },
  selectedId: { type: String, default: null },
  // Id of the currently-selected GCP (shared with the table + image view); in edit
  // mode a click on empty map sets this GCP's ground position, else adds a new one.
  selectedGcpId: { type: String, default: null },
  // UUIDs registered in the sparse model; `hasSparse` gates whether "not in this
  // set" means unaligned (vs. reconstruction simply not having run yet).
  alignedUuids: { type: Object, default: () => new Set() },
  hasSparse:    { type: Boolean, default: false },
  crs:        { type: String, default: 'EPSG:4326' },
  showFootprints: { type: Boolean, default: true },
  showGrid:       { type: Boolean, default: true },
  // Raster layers flagged "On map", in the order they should stack: imported
  // reference rasters and computed DEM/ortho (`product: true`) alike
  // (composables/useMapProducts.js). Metadata only — see useMapRasterLayers.
  rasters:    { type: Array, default: () => [] },
  // Status-bar value readout: a SYNC probe of the on-map layers (useMapProducts
  // probeAt, falling through to useExternalStore.probeRasterAt) plus the hydrator
  // behind the "load" button, injected by the host (WorkspaceView via useMapProducts).
  probeRaster: { type: Function, default: null },
  loadRaster:  { type: Function, default: null },
  // Non-null ⇒ the map shows the MODEL frame instead of the project CRS
  // (composables/useMapProducts.js): { code, unit, extent, key }. A plain metric
  // projection, no basemap; only `modelCameras` and the rasters placed in it are
  // drawn — GCPs, footprints, GPS and poses are CRS data and stay hidden.
  modelFrame:   { type: Object, default: null },
  modelCameras: { type: Array, default: () => [] },  // [{ imageId, imageName, x, y }]
  // One line per requested layer this frame cannot show (and the model-frame
  // notice), so nothing on the map disappears without a reason.
  notes:        { type: Array, default: () => [] },
  // The raster the Measure tools run against (composables/useMapProducts.js):
  // { layer, product, source, kind, frameStatus } | null. The tools measure in that
  // raster's OWN frame; this viewer only maps their geometry onto the screen.
  measureTarget: { type: Object, default: null },
  // Markers (role 'marker') triangulated into the model frame: [{ id, name, x, y }].
  modelMarkers: { type: Array, default: () => [] },
})
const isModel = computed(() => !!props.modelFrame)

// 'command' bubbles ribbon command ids to App (toggles/fit live there).
// The gcp-* events drive absolute (ground) GCP editing from the map.
// 'open-image' opens a linked image's tab (context menu on a footprint, pose or
// GPS marker). Right-click only: footprints cover most of an aerial block, so a
// double-click handler would take double-click zoom away over all of it.
const emit = defineEmits([
  'select', 'command', 'select-gcp', 'set-gcp-position', 'add-gcp-at', 'delete-gcp', 'open-image',
])

// GCP edit mode: shows the target-selector toolbox, makes markers draggable, and
// turns map clicks into position edits. Entered from the ribbon (View ▸ Map ▸ Edit
// GCPs), left from there or the toolbox's ×, so App owns it (v-model:gcp-edit).
const editMode = defineModel('gcpEdit', { type: Boolean, default: false })
const allGcpsBrief = computed(() => props.gcps.map((g) => ({ id: g.id, name: g.name })))
const positionedGcpIds = computed(() =>
  props.gcps.filter((g) => Number.isFinite(g.x) && Number.isFinite(g.y)).map((g) => g.id)
)

const mapEl = ref(null)
const basemapNote = ref('')

// Basemap reachability, shown as a note so a blank or coarse map reads as
// "offline" rather than "broken". Offline, the service worker still serves the
// low-zoom tiles viewed before (core/offlineCache.js).
const hasBasemap = ref(false)
const tilesFailing = ref(false)
let basemapSource = null
const tileStatus = computed(() => {
  if (!hasBasemap.value) return ''
  if (!online.value) return 'Offline: the basemap shows only areas viewed before, at lower detail.'
  if (tilesFailing.value) return 'Basemap tiles are not loading. The tile server may be unreachable.'
  return ''
})

function resetBasemapState() {
  hasBasemap.value = false
  tilesFailing.value = false
  basemapSource = null
}

function addBasemap(map, layer) {
  map.getLayers().insertAt(0, layer)
  hasBasemap.value = true
  basemapSource = layer.getSource()
  watchTileFailures(basemapSource, (failing) => { if (ctx.map === map) tilesFailing.value = failing })
}
const hover = ref(null)   // { text, x, y }

// Every OpenLayers handle of the current build (map, sources, layers, the grid,
// the GCP drag interaction): replaced by build(), nulled by destroy(), and read
// as `ctx.<handle>` at call time everywhere else — see map/mapContext.js.
const ctx = createMapContext()

// Raster layers (imported + computed), reconciled against `props.rasters`.
const rasterLayers = useMapRasterLayers(ctx, {
  rasters: () => props.rasters,
  modelCode: () => props.modelFrame?.code,
})

// ── Status bar ────────────────────────────────────────────────────────────────
// Cursor position in the PROJECT CRS (the map's view projection) + the value of
// the topmost reference raster under it. Mirrors the image view's status bar.
const cursor = ref(null)  // { x, y } | null
const axes = computed(() => (isModel.value ? ['X', 'Y'] : crsInfo(props.crs).axes))
// Degrees need more decimals than metres to be useful at all; model units are
// usually small numbers.
const coordDigits = computed(() => (isModel.value ? 3 : crsInfo(props.crs).geographic ? 6 : 2))
const fmt = (v) => v.toFixed(coordDigits.value)

const cursorRaster = computed(() => {
  if (!cursor.value || !props.probeRaster) return null
  return props.probeRaster(cursor.value.x, cursor.value.y)
})

async function loadCursorRaster() {
  const hit = cursorRaster.value
  if (hit && !hit.loaded) await props.loadRaster?.(hit.id)
}

// ── Right-click context menu ────────────────────────────────────────────────────
const { menu: ctxMenu, open: openCtx, close: closeCtx } = useContextMenu()
// [x, y] map-projection coordinate under the last right-click. A ref, not a plain
// `let`: `ctxItems` reads it, and a non-reactive one leaves both entries stuck at
// the disabled state they had when the computed first evaluated (i.e. always).
const ctxCoord = ref(null)
// Loaded image linked to the feature under the right-click, or null.
const ctxImage = ref(null)
function onContextMenu(e) {
  ctxCoord.value = ctx.map ? ctx.map.getEventCoordinate(e) : null
  const hit = ctx.map && !measuring.value ? pickFeature(ctx.map.getEventPixel(e)) : null
  ctxImage.value = hit ? linkedImageOf(hit, props.images) : null
  openCtx(e)
}
const ctxItems = computed(() => [
  ...(ctxImage.value ? [
    { id: 'open-image', label: `Open image ${ctxImage.value.name}` },
    { separator: true },
  ] : []),
  // A GCP is stored in the project CRS; the model frame has no CRS position.
  { id: 'add-gcp-here', label: isModel.value ? 'Add GCP here (project CRS only)' : 'Add GCP here',
    disabled: !ctxCoord.value || isModel.value },
  { id: 'copy-coords', label: 'Copy coordinates', disabled: !ctxCoord.value },
])
function onCtxSelect(id) {
  closeCtx()
  const coord = ctxCoord.value
  if (id === 'open-image' && ctxImage.value) {
    emit('open-image', ctxImage.value.id)
  } else if (id === 'add-gcp-here' && coord) {
    // Map coordinates are already in the project CRS (= GCP storage CRS).
    emit('add-gcp-at', { x: coord[0], y: coord[1] })
  } else if (id === 'copy-coords' && coord) {
    // Coordinates are in the project CRS (the map view projection).
    copyToClipboard(`${coord[0].toFixed(3)}, ${coord[1].toFixed(3)}`, 'coordinate')
  }
}

// ── Raster measuring ─────────────────────────────────────────────────
// The same RasterMeasurements the raster tab hosts. Its geometry lives in the
// target raster's own world frame; this adapter takes it to the screen through
// the model-frame offset or a CRS transform, then OL's pixel mapping. `viewRev`
// ticks per rendered frame so the overlay follows pan/zoom.
const measurements = ref(null)
const viewRev = ref(0)
const measureDesc = computed(() => productDescriptor(props.measureTarget?.product))
const measureView = computed(() => {
  viewRev.value // eslint-disable-line no-unused-expressions -- re-evaluate per frame
  const t = props.measureTarget
  if (!t || !ctx.map) return null
  const off = t.layer?.offset
  const from = t.layer?.crs, to = props.modelFrame?.code ?? props.crs
  const same = !off && from === to
  const toMap = (x, y) => (off ? [x + off[0], y + off[1]] : same ? [x, y] : transform([x, y], from, to))
  const fromMap = (x, y) => (off ? [x - off[0], y - off[1]] : same ? [x, y] : transform([x, y], to, from))
  return {
    toScreen(wx, wy) {
      const p = ctx.map?.getPixelFromCoordinate(toMap(wx, wy))
      return p ? { x: p[0], y: p[1] } : { x: NaN, y: NaN }
    },
    fromScreen(sx, sy) {
      const c = ctx.map?.getCoordinateFromPixel([sx, sy])
      if (!c) return null
      const [x, y] = fromMap(c[0], c[1])
      return { x, y }
    },
  }
})
const measuring = computed(() => !!measurements.value?.active)
const measureState = computed(() => measurements.value?.state ?? null)
function setMeasureTool(tool) { measurements.value?.setTool(tool) }
function toggleSavedMeasurements() { measurements.value?.toggleSaved() }

// ── What is plotted (core/mapData.js) ─────────────────────────────────────────
// Each computed reads only the current frame's inputs. GCPs, footprints and poses
// are in the project CRS already (= the map view CRS); image GPS is WGS84 and is
// projected by the feature factory.

const gpsImages = computed(() => isModel.value ? [] : gpsImagesOf(props.images, props.poses))

const mapGcps = computed(() => isModel.value ? modelMarkerGcps(props.modelMarkers) : plottedGcps(props.gcps))
const hasGcps = computed(() => mapGcps.value.length > 0)

const mapFootprints = computed(() => isModel.value ? [] : plottedFootprints(props.footprints))
const hasFootprints = computed(() => mapFootprints.value.length > 0)

// On the model map the cameras are the SfM centres in the model frame instead.
const mapPoses = computed(() => (isModel.value ? modelCameraPoses(props.modelCameras) : plottedPoses(props.poses)))
const hasPoses = computed(() => mapPoses.value.length > 0)

// Read by the style functions at render time.
const featureUnaligned = (feature) => isUnaligned(feature.get('uuid'), props.hasSparse, props.alignedUuids)
const imageFeature = (img) => makeImageFeature(img, props.crs)

// ── Marker refresh ────────────────────────────────────────────────────────────

function refreshFeatures() {
  if (!ctx.vSource) return
  ctx.vSource.clear(true)
  ctx.vSource.addFeatures(gpsImages.value.map(imageFeature))
  fitToMarkers()
}

// Placement (core/mapData.js gcpPlacement) of the markers on the map: a rename or
// role change restyles them, only a moved/added/removed point re-fits.
let gcpPlacementKey = ''

function refreshGcps() {
  if (!ctx.gcpSource) return
  ctx.gcpSource.clear(true)
  ctx.gcpSource.addFeatures(mapGcps.value.map(makeGcpFeature))
  const placement = gcpPlacement(mapGcps.value)
  const moved = placement !== gcpPlacementKey
  gcpPlacementKey = placement
  // While editing, a drag/place already keeps the point in view — re-fitting the
  // whole extent on every position tweak would yank the map around.
  if (moved && !editMode.value) fitToMarkers()
}

function refreshFootprints() {
  if (!ctx.footprintSource) return
  ctx.footprintSource.clear(true)
  ctx.footprintSource.addFeatures(mapFootprints.value.map(makeFootprintFeature))
  fitToMarkers()
}

function refreshPoses() {
  if (!ctx.poseSource) return
  ctx.poseSource.clear(true)
  ctx.poseSource.addFeatures(mapPoses.value.map(makePoseFeature))
  fitToMarkers()
}

// Fit View: every marker AND every on-map raster, so a project whose only map
// content is a DEM or orthophoto still has something to fit to.
function fitToMarkers() {
  const map = ctx.map
  if (!map) return
  const features = [
    ...(ctx.vSource?.getFeatures() || []), ...(ctx.gcpSource?.getFeatures() || []),
    ...(ctx.footprintSource?.getFeatures() || []), ...(ctx.poseSource?.getFeatures() || []),
  ]
  const rasters = rasterLayers.extents()
  if (!features.length && !rasters.length) return
  const geom = features.length === 1 && !rasters.length ? features[0].getGeometry() : null
  if (geom?.getType() === 'Point') {
    map.getView().animate({ center: geom.getCoordinates(), zoom: 17, duration: 300 })
    return
  }
  let extent = createEmpty()
  for (const f of features) extend(extent, f.getGeometry().getExtent())
  for (const e of rasters) extend(extent, e)
  map.getView().fit(extent, { padding: [48, 48, 48, 48], maxZoom: 18, duration: 300 })
}

// Feature under the cursor, ignoring the grid. Grid lines and labels are decor,
// not targets: hit-testing them turned every line into a pointer cursor plus an
// empty hover box (they carry none of the name properties the tooltip reads).
function pickFeature(pixel) {
  const gridLayer = ctx.grid?.layer ?? null
  return ctx.map.forEachFeatureAtPixel(pixel, (f) => f, { layerFilter: (l) => l !== gridLayer })
}

// ── Map (re)build ─────────────────────────────────────────────────────────────
// OpenLayers can't change a View's projection in place, so we rebuild the map
// whenever the project CRS changes.

// The model frame as an OpenLayers projection: plain metric units (OL needs a
// unit for its resolution maths; the labels say "model units" when unscaled), an
// extent from the cameras, no geographic meaning and no basemap.
function modelProjection(frame) {
  const projection = new Projection({ code: frame.code, units: 'm', extent: frame.extent })
  addProjection(projection)
  return projection
}

// Builds overlap (a frame change while the CRS definition is still loading, a
// basemap change, unmount mid-build): only the newest may create the map, or two
// OlMaps would share the element (the loser leaking its render loop and tiles), an
// older CRS build could replace a newer model-frame one, or a map would be created
// on a detached element. destroy() invalidates any build still awaiting.
const mapBuild = createGeneration()

async function build() {
  const token = mapBuild.next()
  const model = props.modelFrame
  if (!model) await ensureProjection(props.crs).catch(() => {})
  if (!mapBuild.isCurrent(token) || !mapEl.value) return
  // Synchronous from here on: nothing below awaits, so the handles this build
  // writes into `ctx` are never interleaved with another build's.
  const info = model
    ? { geographic: false, basemap: null, extent: model.extent, gridUnit: model.unit, gridAxes: ['X', 'Y'] }
    : crsInfo(props.crs)
  const projection = model ? modelProjection(model) : getOlProjection(props.crs)
  // crs.js gives every projection an extent; fall back to the catalog value.
  const viewExtent = projection?.getExtent() || info.extent || null
  basemapNote.value = ''
  resetBasemapState()

  ctx.vSource = new VectorSource({ features: gpsImages.value.map(imageFeature) })
  ctx.gcpSource = new VectorSource({ features: mapGcps.value.map(makeGcpFeature) })
  gcpPlacementKey = gcpPlacement(mapGcps.value)
  ctx.footprintSource = new VectorSource({ features: mapFootprints.value.map(makeFootprintFeature) })
  ctx.footprintLayer = new VectorLayer({
    source: ctx.footprintSource, style: (f) => footprintStyle(f, props.selectedId), visible: props.showFootprints,
  })
  ctx.poseSource = new VectorSource({ features: mapPoses.value.map(makePoseFeature) })
  ctx.gcpLayer = new VectorLayer({ source: ctx.gcpSource, style: gcpStyle })

  ctx.grid = makeGridLayer(info, projection, props.showGrid)

  // Raster layers sit above the basemap but below everything the project owns, so
  // GCPs/footprints/poses always stay legible on top of them.
  const rasterGroup = rasterLayers.createGroup()

  ctx.map = new OlMap({
    target: mapEl.value,
    layers: [
      rasterGroup,
      ctx.grid.layer,
      ctx.footprintLayer,
      new VectorLayer({ source: ctx.vSource, style: (f) => imageStyle(f, props.selectedId, featureUnaligned) }),
      ctx.gcpLayer,
      new VectorLayer({ source: ctx.poseSource, style: (f) => poseStyle(f, props.selectedId) }),
    ],
    view: new View({
      projection: projection || 'EPSG:3857',
      center: viewExtent
        ? [(viewExtent[0] + viewExtent[2]) / 2, (viewExtent[1] + viewExtent[3]) / 2]
        : [0, 0],
      zoom: viewExtent ? 3 : 2,
      // A CRS view stays inside the CRS's validity area; the model frame has no
      // such edge, and its projection extent is only the zoom-out bound.
      extent: model ? undefined : (info.extent || undefined),
    }),
    controls: [new Attribution({ collapsible: true })],
  })
  const builtMap = ctx.map

  // Add the selected basemap below the grid (index 0); core/basemapChoice.js.
  const { kind, note } = chooseBasemap(basemap.value, info, !!model)
  if (note) basemapNote.value = note
  if (kind === 'gibs') {
    // Async: only the map that asked may receive it (a rebuild replaces ctx.map).
    makeGibsLayer(info)
      .then((layer) => { if (ctx.map === builtMap) addBasemap(builtMap, layer) })
      .catch(() => {
        if (ctx.map !== builtMap) return
        basemapNote.value = online.value
          ? 'Polar basemap unavailable — showing grid only.'
          : 'Offline: the polar basemap is unavailable until you reconnect. Showing grid only.'
      })
  } else if (kind) {
    addBasemap(builtMap, makeBasemapLayer(kind, { url: satelliteUrl.value, attribution: satelliteAttribution.value }))
  }

  rasterLayers.sync()

  // The projected grid is view-dependent (spacing + edge-pinned labels follow the
  // view), so it regenerates per frame while the map moves; its update self-skips
  // an unchanged view, and is a no-op for the geographic graticule layer.
  builtMap.on('postrender', () => { ctx.grid?.update(ctx.map); viewRev.value++ })
  ctx.grid.update(ctx.map)
  viewRev.value++

  fitToMarkers()

  // Drag GCP markers to set their ground position (edit mode only). On drop, read
  // the new project-CRS coordinate straight off the geometry.
  ctx.gcpTranslate = new Translate({ layers: [ctx.gcpLayer] })
  ctx.gcpTranslate.setActive(editMode.value)
  ctx.gcpTranslate.on('translateend', (e) => {
    e.features.forEach((f) => {
      const id = f.get('gcpId')
      const [x, y] = f.getGeometry().getCoordinates()
      if (id) emit('set-gcp-position', { id, x, y })
    })
  })
  builtMap.addInteraction(ctx.gcpTranslate)
  syncDoubleClickZoom()

  builtMap.on('click', onMapClick)
  builtMap.on('pointermove', onPointerMove)
}

function onMapClick(e) {
  // A measuring tool owns the click: it adds a vertex, nothing gets selected.
  if (measurements.value?.active) { measurements.value.pick(e.pixel[0], e.pixel[1]); return }
  const hit = pickFeature(e.pixel)
  if (hit) {
    const gcpId = hit.get('gcpId')
    if (gcpId) { emit('select-gcp', gcpId); return }
    const imgId = hit.get('imgId')
    if (imgId) emit('select', imgId)
    return
  }
  // Empty-map click while editing: place the selected GCP here, or add a new one.
  if (editMode.value) {
    const [x, y] = e.coordinate
    if (props.selectedGcpId) emit('set-gcp-position', { id: props.selectedGcpId, x, y })
    else emit('add-gcp-at', { x, y })
  }
}

function onPointerMove(e) {
  cursor.value = { x: e.coordinate[0], y: e.coordinate[1] }
  const hit = measuring.value ? null : pickFeature(e.pixel)
  ctx.map.getViewport().style.cursor = measuring.value ? 'crosshair' : hit ? 'pointer' : ''
  hover.value = hit ? { text: hoverText(hit, featureUnaligned(hit)), x: e.pixel[0], y: e.pixel[1] } : null
}

function destroy() {
  mapBuild.invalidate()
  ctx.map?.setTarget(null)
  clearMapContext(ctx)
  rasterLayers.dispose()
  resetBasemapState()
  hover.value = null
  cursor.value = null
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

// Show/hide the footprint layer from the ribbon toggle.
watch(() => props.showFootprints, (v) => ctx.footprintLayer?.setVisible(v))

// Show/hide the grid from the ribbon toggle.
watch(() => props.showGrid, (v) => ctx.grid?.layer.setVisible(v))

// Re-style on selection change without rebuilding features
watch(() => props.selectedId, () => { ctx.vSource?.changed(); ctx.footprintSource?.changed(); ctx.poseSource?.changed() })

// Re-style image markers when the registered set changes (reconstruction finished
// or a different cloud was selected) — the features themselves don't move.
watch(() => props.alignedUuids, () => ctx.vSource?.changed())

// Enable/disable marker dragging with edit mode.
watch(editMode, (on) => ctx.gcpTranslate?.setActive(on))

// While measuring, a quick second click adds a vertex — it must not zoom. Also
// applied by build(): a rebuilt map comes with a fresh, active DoubleClickZoom.
function syncDoubleClickZoom() {
  ctx.map?.getInteractions().forEach((i) => { if (i instanceof DoubleClickZoom) i.setActive(!measuring.value) })
}
watch(measuring, syncDoubleClickZoom)

// Add/remove/restack raster layers and follow opacity changes. Deep, because
// `opacity` is edited in place on the raster record (the id list alone wouldn't
// change when the slider moves).
watch(() => props.rasters, rasterLayers.sync, { deep: true })

// Rebuild the whole map when its frame changes: the project CRS, a switch to or
// from the model frame, or a new model frame (`key`).
watch(() => props.modelFrame?.key ?? props.crs, async () => {
  if (isModel.value) editMode.value = false // GCPs are CRS data
  destroy()
  await build()
  ctx.map?.updateSize()
})

// A basemap preference change is immediately visible in an already-open map;
// so is a new satellite source while Satellite is showing.
async function rebuild() {
  destroy()
  await build()
  ctx.map?.updateSize()
}
watch(basemap, rebuild)
// Back online: retry the tiles that failed meanwhile (OpenLayers does not on its own).
watch(online, (isOnline) => { if (isOnline) basemapSource?.refresh() })
watch([satelliteUrl, satelliteAttribution], () => { if (basemap.value === 'satellite') rebuild() })

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let resizeObserver = null

onMounted(async () => {
  await build()
  if (!mapEl.value) return // unmounted while the first build awaited
  resizeObserver = new ResizeObserver(() => ctx.map?.updateSize())
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
  if (!ctx.map) return
  let coord = null
  const cam = isModel.value ? props.modelCameras.find((c) => c.imageId === imgId) : null
  const pose = isModel.value ? null : props.poses.find((p) => p.imageId === imgId && Number.isFinite(p.x) && Number.isFinite(p.y))
  if (cam) {
    coord = [cam.x, cam.y]
  } else if (isModel.value) {
    return
  } else if (pose) {
    coord = [pose.x, pose.y]
  } else {
    const img = props.images.find((i) => i.id === imgId)
    if (img?.meta?.gpsLat != null && img?.meta?.gpsLon != null) {
      coord = projectLonLat(img.meta.gpsLon, img.meta.gpsLat, props.crs)
    }
  }
  if (!coord) return
  ctx.map.getView().animate({ center: coord, zoom: 17, duration: 300 })
}

// Fit the view to one shapefile set's polygons (its combined extent). `polygons`
// is the set's flat polygon list ([{ rings }]); ignores any without geometry.
function zoomToFootprints(polygons) {
  if (!ctx.map || !polygons?.length) return
  let extent = createEmpty()
  for (const p of polygons) {
    if (p.rings?.length) extend(extent, new Polygon(p.rings).getExtent())
  }
  if (!extentIsEmpty(extent)) {
    ctx.map.getView().fit(extent, { padding: [48, 48, 48, 48], maxZoom: 18, duration: 300 })
  }
}

defineExpose({ zoomToImage, fitView: fitToMarkers, zoomToFootprints, measureState, setMeasureTool, toggleSavedMeasurements })
</script>

<template>
  <div class="map-viewer" @contextmenu.prevent="onContextMenu">
    <div class="map-body" @pointerleave="cursor = null">
      <div ref="mapEl" class="ol-map" />
      <ViewerContextMenu :menu="ctxMenu" :items="ctxItems" @select="onCtxSelect" />
      <!-- Keyed by layer: a new target starts a fresh drawing (the tab does the same
           when its raster changes). -->
      <RasterMeasurements v-if="measureTarget" :key="measureTarget.layer.id" ref="measurements"
        :product="measureTarget.product" :source="measureTarget.source" :descriptor="measureDesc"
        :frame-status="measureTarget.frameStatus" :kind="measureTarget.kind" :view="measureView"
        pan-hint="drag pans" />

      <GcpToolbar
        v-if="editMode"
        noun="map"
        :all-gcps="allGcpsBrief"
        :selected-id="selectedGcpId"
        :marked-ids="positionedGcpIds"
        @select="(id) => emit('select-gcp', id)"
        @delete="(id) => emit('delete-gcp', id)"
        @close="editMode = false"
      />
      <div v-if="basemapNote || tileStatus || notes.length" class="basemap-note">
        <div v-if="tileStatus" class="tile-status"><span class="tile-status-dot" />{{ tileStatus }}</div>
        <div v-if="basemapNote">{{ basemapNote }}</div>
        <div v-for="(n, i) in notes" :key="i">{{ n }}</div>
      </div>

      <div v-if="hover" class="hover-label" :style="{ left: hover.x + 12 + 'px', top: hover.y + 12 + 'px' }">
        {{ hover.text }}
      </div>

      <div v-if="hasGcps || hasFootprints || hasPoses" class="legend">
        <span v-if="!isModel" class="legend-item"><span class="legend-dot img"></span>Image GPS</span>
        <span v-if="hasGcps && !isModel" class="legend-item"><span class="legend-dot gcp"></span>GCP</span>
        <span v-if="hasGcps && isModel" class="legend-item"><span class="legend-dot marker"></span>Marker</span>
        <span v-if="hasPoses" class="legend-item"><span class="legend-dot pose"></span>Camera</span>
        <span v-if="hasFootprints" class="legend-item"><span class="legend-dot footprint"></span>Footprint</span>
      </div>
    </div>

    <div class="status-bar">
      <template v-if="cursor">
        <span class="coord">{{ axes[0] }}&nbsp;{{ fmt(cursor.x) }}</span>
        <span class="sep">|</span>
        <span class="coord">{{ axes[1] }}&nbsp;{{ fmt(cursor.y) }}</span>
        <template v-if="cursorRaster">
          <span class="sep">|</span>
          <span class="raster-name">{{ cursorRaster.name }}</span>
          <button
            v-if="!cursorRaster.loaded"
            class="load-raster"
            title="Pixel data is not in memory yet — click to load it"
            @click="loadCursorRaster"
          >load</button>
          <span v-else-if="cursorRaster.kind !== 'dem'" class="value dim">RGB</span>
          <span v-else-if="cursorRaster.value == null" class="value dim">no data</span>
          <span v-else class="value">{{ cursorRaster.value.toFixed(2) }}</span>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.map-viewer {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

/* Positioning context for every map overlay (toolbar, legend, hover label), so
   they sit above the map but never over the status bar. */
.map-body {
  position: relative;
  flex: 1;
  min-height: 0;
}

.ol-map {
  width: 100%;
  height: 100%;
}


/* Cursor readout — same shape as the image view's status bar. */
.status-bar {
  flex-shrink: 0;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  font-size: 11px;
  font-family: ui-monospace, 'Cascadia Code', 'Fira Mono', monospace;
  color: var(--text);
  background: var(--panel);
  border-top: 1px solid var(--panel-border);
}

.coord       { color: var(--text); letter-spacing: 0.02em; }
.sep         { color: var(--panel-border); }
.raster-name { color: var(--text-dim); }
.value       { color: var(--text); letter-spacing: 0.02em; }
.value.dim   { color: var(--text-dim); }

.load-raster {
  padding: 0 6px;
  font: inherit;
  color: var(--accent);
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 3px;
  cursor: pointer;
}
.load-raster:hover { background: var(--hover-bg); }

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
  /* Frame notes are sentences; wrap inside the map rather than run off it. */
  max-width: min(640px, calc(100% - 40px));
  width: max-content;
  text-align: center;
}

.tile-status { display: flex; align-items: center; justify-content: center; gap: 7px; }
.tile-status-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: #e0a000;
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
.legend-dot.marker { background: #e0a030; transform: rotate(45deg); }
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
