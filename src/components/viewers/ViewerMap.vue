<script setup>
import { onMounted, onBeforeUnmount, ref, computed, watch } from 'vue'
// Aliased: a bare `Map` import shadows the global Map constructor, and this file
// keeps id→layer lookups in real JS Maps.
import OlMap from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import OSM from 'ol/source/OSM'
import WMTS, { optionsFromCapabilities } from 'ol/source/WMTS'
import WMTSCapabilities from 'ol/format/WMTSCapabilities'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import ImageLayer from 'ol/layer/Image'
import Static from 'ol/source/ImageStatic'
import LayerGroup from 'ol/layer/Group'
import Graticule from 'ol/layer/Graticule'
import Feature from 'ol/Feature'
import Point from 'ol/geom/Point'
import Polygon from 'ol/geom/Polygon'
import LineString from 'ol/geom/LineString'
import { Style, Circle as CircleStyle, RegularShape, Fill, Stroke, Text } from 'ol/style'
import { get as getOlProjection } from 'ol/proj'
import { Attribution } from 'ol/control'
import Translate from 'ol/interaction/Translate'
import { createEmpty, extend, buffer, getIntersection, isEmpty as extentIsEmpty } from 'ol/extent'
import { ensureProjection, transform, crsInfo } from '../../core/crs.js'
import { rasterBounds } from '../../core/io/rasterSample.js'
import { useContextMenu } from '../../composables/useContextMenu.js'
import { copyToClipboard } from '../../composables/useToasts.js'
import ViewerContextMenu from './ViewerContextMenu.vue'
import GcpToolbar from './GcpToolbar.vue'
import { useMapSettings } from '../../composables/useMapSettings.js'

const { basemap } = useMapSettings()

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
  // Imported reference rasters flagged "Display on map" (useExternalStore.mapRasters),
  // in the order they should stack. Metadata only — see makeRasterLayer.
  rasters:    { type: Array, default: () => [] },
  // Status-bar value readout: a SYNC probe of already-hydrated reference rasters
  // (useExternalStore.probeRasterAt) plus the hydrator behind the "load" button.
  // Kept as injected functions so this viewer stays store-free like its siblings.
  probeRaster: { type: Function, default: null },
  loadRaster:  { type: Function, default: null },
})

// 'command' bubbles ribbon command ids to App (toggles/fit live there).
// The gcp-* events drive absolute (ground) GCP editing from the map.
const emit = defineEmits([
  'select', 'command', 'select-gcp', 'set-gcp-position', 'add-gcp-at', 'delete-gcp',
])

// GCP edit mode: shows the target-selector toolbar, makes markers draggable, and
// turns map clicks into position edits. Local to the map tab.
const editMode = ref(false)
const allGcpsBrief = computed(() => props.gcps.map((g) => ({ id: g.id, name: g.name })))
const positionedGcpIds = computed(() =>
  props.gcps.filter((g) => Number.isFinite(g.x) && Number.isFinite(g.y)).map((g) => g.id)
)

const mapEl = ref(null)
const basemapNote = ref('')
const hover = ref(null)   // { text, x, y }

// ── Status bar ────────────────────────────────────────────────────────────────
// Cursor position in the PROJECT CRS (the map's view projection) + the value of
// the topmost reference raster under it. Mirrors the image view's status bar.
const cursor = ref(null)  // { x, y } | null
const axes = computed(() => crsInfo(props.crs).axes)
// Degrees need more decimals than metres to be useful at all.
const coordDigits = computed(() => (crsInfo(props.crs).geographic ? 6 : 2))
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
function onContextMenu(e) {
  ctxCoord.value = map ? map.getEventCoordinate(e) : null
  openCtx(e, {}, { w: 190, h: 90 })
}
const ctxItems = computed(() => [
  { id: 'add-gcp-here', label: 'Add GCP here', disabled: !ctxCoord.value },
  { id: 'copy-coords', label: 'Copy coordinates', disabled: !ctxCoord.value },
])
function onCtxSelect(id) {
  closeCtx()
  const coord = ctxCoord.value
  if (id === 'add-gcp-here' && coord) {
    // Map coordinates are already in the project CRS (= GCP storage CRS).
    emit('add-gcp-at', { x: coord[0], y: coord[1] })
  } else if (id === 'copy-coords' && coord) {
    // Coordinates are in the project CRS (the map view projection).
    copyToClipboard(`${coord[0].toFixed(3)}, ${coord[1].toFixed(3)}`, 'coordinate')
  }
}

let map             = null
let vSource         = null
let gcpSource        = null
let gcpLayer         = null
let gcpTranslate     = null
let footprintSource = null
let footprintLayer  = null
let gridLayer       = null
let gridSource      = null // non-null only for the projected-grid variant (see below)
let gridExtent      = null
let gridUnits       = 'm'  // the projection's own linear unit; labels are in it, unscaled
let gridViewKey     = ''   // last center/resolution the grid was generated for
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

// Faded marker for an image that failed to register into the sparse model.
const unalignedStyle = new Style({
  image: new CircleStyle({
    radius: 6,
    fill:   new Fill({ color: 'rgba(120, 130, 140, 0.5)' }),
    stroke: new Stroke({ color: 'rgba(255, 255, 255, 0.6)', width: 1.5 }),
  }),
})

// True once a sparse model exists but this image's uuid wasn't registered into it.
function featureUnaligned(feature) {
  const uuid = feature.get('uuid')
  return props.hasSparse && uuid != null && !props.alignedUuids.has(uuid)
}

function styleFor(feature) {
  if (feature.get('imgId') === props.selectedId) return selectedStyle
  return featureUnaligned(feature) ? unalignedStyle : normalStyle
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

function makeFeature({ id, uuid, name, meta }) {
  const f = new Feature({ geometry: new Point(projectLonLat(meta.gpsLon, meta.gpsLat)) })
  f.set('imgId', id)
  f.set('uuid', uuid)
  f.set('name', name)
  return f
}

function makeGcpFeature(g) {
  const f = new Feature({ geometry: new Point([g.x, g.y]) })
  f.set('gcpName', g.name)
  f.set('gcpId', g.id)
  return f
}

function makeFootprintFeature(fp) {
  const f = new Feature({ geometry: new Polygon(fp.rings) })
  // Hover label: the image the polygon belongs to, else the layer name.
  f.set('footprintName', fp.imageName ?? fp.setName ?? fp.name)
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
  // While editing, a drag/place already keeps the point in view — re-fitting the
  // whole extent on every position tweak would yank the map around.
  if (!editMode.value) fitToMarkers()
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
// polar CRS. A grid is always drawn so any CRS is usable even without tiles.

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

// ── Reference raster layers (A-4) ─────────────────────────────────────────────
// Imported DEMs/orthos drawn under the project's own vectors. Two things make
// this cheap enough to be a toggle rather than a heavyweight mode:
//
//  1. **It renders `previewDataUrl`, never the pixel plane.** The ≤1024 px PNG is
//     already in the index from restore, so showing a REMA tile costs no decode
//     and no memory — `ensureRasterLoaded` is deliberately NOT called here. On a
//     basemap-zoom view the tile is a few hundred screen pixels wide anyway; the
//     full plane exists for *sampling*, and that's a different question.
//  2. **The raster keeps its native CRS** (store invariant 2). We hand OpenLayers
//     the extent in the raster's own projection and let it reproject the image on
//     the fly, so this survives `handleSetCrs` with no resampling — the same
//     reason the sampler reprojects the query instead of warping the raster.
let rasterGroup = null
const rasterLayers = new Map() // id → ImageLayer

function makeRasterLayer(r) {
  const bounds = rasterBounds({ width: r.width, height: r.height, geoTransform: r.geoTransform })
  if (!bounds) return null
  const projection = getOlProjection(r.crs)
  if (!projection) return null
  const layer = new ImageLayer({
    source: new Static({
      url: r.previewDataUrl,
      imageExtent: bounds,
      projection,
      // The preview is a decimated view of the raster, so let OL scale it up
      // rather than refuse to draw past its native size.
      imageSmoothing: true,
    }),
    opacity: r.opacity ?? 1,
  })
  // Which PNG this layer was built from. An ImageStatic's url is fixed at
  // construction, so a restyle (which swaps previewDataUrl on the same raster
  // record) can only reach the map by rebuilding the source — see syncRasterLayers.
  layer.set('previewUrl', r.previewDataUrl)
  return layer
}

// Reconcile the group against `props.rasters`. Diffed rather than rebuilt so that
// dragging the opacity slider re-renders instead of tearing the image down and
// reloading it on every input event.
async function syncRasterLayers() {
  if (!map || !rasterGroup) return
  const want = props.rasters ?? []
  for (const r of want) {
    if (r.crs) await ensureProjection(r.crs).catch(() => {})
  }

  const seen = new Set()
  for (const r of want) {
    seen.add(r.id)
    const existing = rasterLayers.get(r.id)
    if (existing) {
      existing.setOpacity(r.opacity ?? 1)
      // Opacity is a live property; the image itself is not. A restyle (or a
      // kind flip) replaces previewDataUrl in place on the same record, so an
      // unchanged url is the ONLY case that may keep its source — otherwise the
      // layer would keep painting the pre-restyle PNG until the view is torn
      // down, which is exactly the "reload the view to see it" bug.
      if (existing.get('previewUrl') === r.previewDataUrl) continue
      existing.getSource()?.dispose?.()
      rasterLayers.delete(r.id)
    }
    const layer = makeRasterLayer(r)
    if (layer) rasterLayers.set(r.id, layer)
  }
  for (const [id, layer] of [...rasterLayers]) {
    if (seen.has(id)) continue
    layer.getSource()?.dispose?.()
    rasterLayers.delete(id)
  }

  // Rewrite the collection in list order — the sidebar's order IS the draw order,
  // so a raster moved in the list restacks on the map.
  const ordered = want.map((r) => rasterLayers.get(r.id)).filter(Boolean)
  rasterGroup.getLayers().clear()
  for (const layer of ordered) rasterGroup.getLayers().push(layer)
}

// ── Grid ──────────────────────────────────────────────────────────────────────
// `ol/layer/Graticule` is hardcoded to EPSG:4326 meridians and parallels — it
// draws *geographic* lines whatever the view projection is, and there is no
// option to switch it to the view's units. On EPSG:3031 that means lines
// converging on the pole: useful for knowing where you are, useless for reading
// a distance off the map. So for a projected CRS we draw our own grid instead —
// straight lines at round intervals in the view's own units (10 km squares over
// Antarctica). A geographic CRS keeps OL's graticule layer: there the projected
// grid and the meridians/parallels are the same lines, so drawing ours would be
// a worse-labelled duplicate. Both answer to the one `showGrid` toggle via
// `gridLayer`.

const GRID_STROKE = new Stroke({ color: 'rgba(140,140,140,0.45)', width: 1 })
const GRID_LINE_STYLE = new Style({ stroke: GRID_STROKE })
// Desired on-screen gap between grid lines. Full coordinates are wide labels
// ("E -1,300,000 m" ≈ 85 px at 11 px type), so the spacing has to clear one.
const GRID_TARGET_PX = 150
const GRID_MAX_LINES = 400  // per axis; a stale resolution can't hang the renderer

// Round spacing (1/2/5 × 10ⁿ) no smaller than `target` map units.
function niceGridSpacing(target) {
  if (!(target > 0)) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(target)))
  const norm = target / pow
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow
}

// Labels are the **full projected coordinate** in the CRS's own units, the number
// you would type into a GCP row — for Adelaide Island on EPSG:3031 that is
// "E -1,300,000 m", not "-1,300 km". Abbreviating to km reads as a *distance from
// somewhere*, which is exactly what a projected easting/northing is not; and near
// the projection origin it degenerates to "0 km / 200 km" whatever the CRS.
// Decimals only appear if the spacing is sub-metre (a metre grid never needs them).
function formatGridLabel(v, spacing, axis) {
  const dec = spacing >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(spacing)))
  const num = v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
  return `${axis} ${num} ${gridUnits}`
}

function makeGridLabel(coord, text, align) {
  const f = new Feature(new Point(coord))
  f.setStyle(new Style({
    text: new Text({
      text,
      font: '11px sans-serif',
      textAlign: align,
      textBaseline: 'bottom',
      offsetX: align === 'left' ? 4 : 0,
      offsetY: -3,
      fill: new Fill({ color: 'rgba(140,140,140,0.95)' }),
      // Halo: the grid runs over basemap imagery, which can be any brightness.
      stroke: new Stroke({ color: 'rgba(0,0,0,0.55)', width: 3 }),
    }),
  }))
  return f
}

// Feature under the cursor, ignoring the grid. Grid lines and labels are decor,
// not targets: hit-testing them turned every line into a pointer cursor plus an
// empty hover box (they carry none of the name properties the tooltip reads).
function pickFeature(pixel) {
  return map.forEachFeatureAtPixel(pixel, (f) => f, { layerFilter: (l) => l !== gridLayer })
}

// Regenerate the grid for the current view. Driven from `postrender`, i.e. once
// per animation frame while the map moves, so the edge-pinned labels track the
// pan/zoom continuously instead of jumping at `moveend` — the same feel as OL's
// own graticule. `gridViewKey` makes an unchanged view a no-op, so an idle map
// costs nothing. Because it re-runs every frame the generation buffer only has to
// cover the frame's own motion, not half a screen.
function updateGrid() {
  if (!map || !gridSource) return
  const view = map.getView()
  const resolution = view.getResolution()
  const size = map.getSize()
  if (!resolution || !size) return

  const center = view.getCenter() || [0, 0]
  const key = `${center[0]}|${center[1]}|${resolution}|${size[0]}x${size[1]}`
  if (key === gridViewKey) return
  gridViewKey = key

  const view0 = view.calculateExtent(size)
  let bounds = buffer(view0, Math.max(size[0], size[1]) * resolution * 0.1)
  // Stop at the CRS validity edge — beyond it the coordinates aren't meaningful.
  if (gridExtent) bounds = getIntersection(bounds, gridExtent)
  if (extentIsEmpty(bounds)) { gridSource.clear(true); return }

  const spacing = niceGridSpacing(resolution * GRID_TARGET_PX)
  const features = []
  // Labels ride the edge of the *visible* viewport, not the buffered generation
  // area — anchoring them to the buffer parks them off-screen, and the grid then
  // reads as unlabelled at anything but the widest zoom.
  const labelX = Math.max(view0[0], bounds[0]) + resolution * 2
  const labelY = Math.max(view0[1], bounds[1]) + resolution * 2

  let n = 0
  for (let x = Math.ceil(bounds[0] / spacing) * spacing; x <= bounds[2] && n < GRID_MAX_LINES; x += spacing, n++) {
    features.push(new Feature(new LineString([[x, bounds[1]], [x, bounds[3]]])))
    features.push(makeGridLabel([x, labelY], formatGridLabel(x, spacing, 'E'), 'center'))
  }
  n = 0
  for (let y = Math.ceil(bounds[1] / spacing) * spacing; y <= bounds[3] && n < GRID_MAX_LINES; y += spacing, n++) {
    features.push(new Feature(new LineString([[bounds[0], y], [bounds[2], y]])))
    features.push(makeGridLabel([labelX, y], formatGridLabel(y, spacing, 'N'), 'left'))
  }

  gridSource.clear(true)
  gridSource.addFeatures(features)
}

// Build whichever of the two the CRS calls for, and leave `gridSource` non-null
// only in the projected case (updateGrid is a no-op without it).
function makeGridLayer(info, projection) {
  gridSource = null
  gridExtent = null
  if (info.geographic || projection?.getUnits() === 'degrees') {
    return new Graticule({
      strokeStyle: GRID_STROKE,
      showLabels: true,
      wrapX: false,
      visible: props.showGrid,
    })
  }
  gridSource = new VectorSource({ features: [], wrapX: false })
  gridExtent = projection?.getExtent() || info.extent || null
  // Label suffix. OL reports 'm' for metric projections, 'ft'/'us-ft' for the
  // handful in feet; coordinates are printed in that unit as-is, never rescaled.
  gridUnits = projection?.getUnits() === 'us-ft' ? 'ft' : (projection?.getUnits() || 'm')
  gridViewKey = ''
  return new VectorLayer({
    source: gridSource,
    style: GRID_LINE_STYLE,       // labels carry their own per-feature style
    visible: props.showGrid,
    updateWhileAnimating: true,   // the grid should track the map, not snap in after it
    updateWhileInteracting: true,
  })
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
  footprintLayer = new VectorLayer({ source: footprintSource, style: footprintStyleFor, visible: props.showFootprints })
  poseSource = new VectorSource({ features: mapPoses.value.map(makePoseFeature) })
  gcpLayer = new VectorLayer({ source: gcpSource, style: gcpStyle })

  const grid = makeGridLayer(info, projection)
  gridLayer = grid

  // Reference rasters sit above the basemap but below everything the project
  // owns, so GCPs/footprints/poses always stay legible on top of them. A Group
  // (rather than loose layers) keeps that position fixed no matter when the
  // async basemap resolves and inserts itself at index 0.
  rasterLayers.clear()
  rasterGroup = new LayerGroup({ layers: [] })

  map = new OlMap({
    target: mapEl.value,
    layers: [
      rasterGroup,
      grid,
      footprintLayer,
      new VectorLayer({ source: vSource, style: styleFor }),
      gcpLayer,
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
  const builtMap = map

  // Add the selected basemap below the grid (index 0). "Automatic" preserves
  // the CRS-aware polar layers; an explicit street layer uses OSM everywhere.
  if (basemap.value === 'streets' || (basemap.value === 'auto' && info.basemap === 'osm')) {
    map.getLayers().insertAt(0, makeOsmLayer())
  } else if (basemap.value === 'auto' && info.basemap === 'gibs') {
    addGibsLayer(info)
      .then((layer) => { if (map === builtMap) builtMap.getLayers().insertAt(0, layer) })
      .catch(() => {
        if (map === builtMap) basemapNote.value = 'Polar basemap unavailable — showing grid only.'
      })
  }

  syncRasterLayers()

  // The projected grid is view-dependent (spacing + edge-pinned labels follow the
  // view), so it regenerates per frame while the map moves — see updateGrid, which
  // self-skips an unchanged view. No-op for the geographic graticule layer, which
  // OL keeps up to date itself.
  map.on('postrender', updateGrid)
  updateGrid()

  fitToMarkers()

  // Drag GCP markers to set their ground position (edit mode only). On drop, read
  // the new project-CRS coordinate straight off the geometry.
  gcpTranslate = new Translate({ layers: [gcpLayer] })
  gcpTranslate.setActive(editMode.value)
  gcpTranslate.on('translateend', (e) => {
    e.features.forEach((f) => {
      const id = f.get('gcpId')
      const [x, y] = f.getGeometry().getCoordinates()
      if (id) emit('set-gcp-position', { id, x, y })
    })
  })
  map.addInteraction(gcpTranslate)

  map.on('click', (e) => {
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
  })

  map.on('pointermove', (e) => {
    cursor.value = { x: e.coordinate[0], y: e.coordinate[1] }
    const hit = pickFeature(e.pixel)
    map.getViewport().style.cursor = hit ? 'pointer' : ''
    if (hit) {
      const gcpName = hit.get('gcpName')
      const fpName = hit.get('footprintName')
      const poseName = hit.get('poseName')
      const imgName = hit.get('name')
      const text = gcpName ? `GCP: ${gcpName}`
        : fpName ? `Footprint: ${fpName}`
        : poseName ? `Camera: ${poseName}`
        : featureUnaligned(hit) ? `${imgName} (not aligned)` : imgName
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
  gcpLayer = null
  gcpTranslate = null
  footprintSource = null
  footprintLayer = null
  gridLayer = null
  gridSource = null
  gridExtent = null
  poseSource = null
  // The Static sources hold a decoded image each; drop them with the map rather
  // than leaving them attached to a detached group across a CRS rebuild.
  for (const layer of rasterLayers.values()) layer.getSource()?.dispose?.()
  rasterLayers.clear()
  rasterGroup = null
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
watch(() => props.showFootprints, (v) => footprintLayer?.setVisible(v))

// Show/hide the grid from the ribbon toggle.
watch(() => props.showGrid, (v) => gridLayer?.setVisible(v))

// Re-style on selection change without rebuilding features
watch(() => props.selectedId, () => { vSource?.changed(); footprintSource?.changed(); poseSource?.changed() })

// Re-style image markers when the registered set changes (reconstruction finished
// or a different cloud was selected) — the features themselves don't move.
watch(() => props.alignedUuids, () => vSource?.changed())

// Enable/disable marker dragging with edit mode.
watch(editMode, (on) => gcpTranslate?.setActive(on))

// Add/remove/restack reference raster layers and follow opacity changes. Deep,
// because `opacity` is edited in place on the raster record (the id list alone
// wouldn't change when the slider moves).
watch(() => props.rasters, syncRasterLayers, { deep: true })

// Rebuild the whole map when the project CRS changes
watch(() => props.crs, async () => {
  destroy()
  await build()
  map?.updateSize()
})

// A basemap preference change is immediately visible in an already-open map.
watch(basemap, async () => {
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

// Fit the view to one shapefile set's polygons (its combined extent). `polygons`
// is the set's flat polygon list ([{ rings }]); ignores any without geometry.
function zoomToFootprints(polygons) {
  if (!map || !polygons?.length) return
  let extent = createEmpty()
  for (const p of polygons) {
    if (p.rings?.length) extend(extent, new Polygon(p.rings).getExtent())
  }
  if (!extentIsEmpty(extent)) {
    map.getView().fit(extent, { padding: [48, 48, 48, 48], maxZoom: 18, duration: 300 })
  }
}

defineExpose({ zoomToImage, fitView: fitToMarkers, zoomToFootprints })
</script>

<template>
  <div class="map-viewer" @contextmenu.prevent="onContextMenu">
    <div class="map-body" @pointerleave="cursor = null">
      <div ref="mapEl" class="ol-map" />
      <ViewerContextMenu :menu="ctxMenu" :items="ctxItems" @select="onCtxSelect" />

      <button
        class="gcp-edit-toggle"
        :class="{ active: editMode }"
        title="Edit GCP ground positions on the map"
        @click="editMode = !editMode"
      >✎ Edit GCPs</button>

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

.gcp-edit-toggle {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 3;
  padding: 5px 10px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}
.gcp-edit-toggle:hover { background: var(--hover-bg); }
.gcp-edit-toggle.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
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
