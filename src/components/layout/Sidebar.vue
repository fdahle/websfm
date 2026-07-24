<script setup>
import { computed, ref, watch } from 'vue'
import { useProjectsStore } from '../../stores/useProjectsStore.js'
import ImagesSection from './sidebar/ImagesSection.vue'
import SensorsSection from './sidebar/SensorsSection.vue'
import MatchesSection from './sidebar/MatchesSection.vue'
import GcpsSection from './sidebar/GcpsSection.vue'
import ShapefilesSection from './sidebar/ShapefilesSection.vue'
import ReconstructionSection from './sidebar/ReconstructionSection.vue'
import ProductsSection from './sidebar/ProductsSection.vue'
import ReferenceSection from './sidebar/ReferenceSection.vue'

const props = defineProps({
  images:     { type: Array,  required: true },
  gcps:       { type: Array,  default: () => [] },
  gcpReport:  { type: Array,  default: () => [] },
  selectedGcpId: { type: String, default: null },
  sensors:    { type: Array,  default: () => [] },
  poses:      { type: Array,  default: () => [] },
  // Image footprint polygons (imported or computed from poses); the section only
  // renders when at least one exists.
  // Vector polygon layers ("shapefiles"): computed footprint sets + imported
  // polygon files. [{ id, name, source, onMap, footprints:[...] }]
  shapefiles: { type: Array,  default: () => [] },
  // Point clouds: [{ id, name, kind, createdAt, cameras: Map, points: [] }]
  clouds:     { type: Array,  default: () => [] },
  selectedCloudId: { type: String, default: null },
  mainSparseId:    { type: String, default: null },
  // Raster products (recomputable): DEM / orthophoto, or null when not built.
  dem:        { type: Object, default: null },
  ortho:      { type: Object, default: null },
  // Imported georeferenced rasters (useExternalStore) — metadata only, planes lazy.
  rasters:    { type: Array,  default: () => [] },
  // Transient rows created as soon as a reference GeoTIFF starts parsing.
  pendingRasters: { type: Array, default: () => [] },
  reconStatus: { type: String, default: 'idle' }, // 'idle'|'running'|'done'|'error'
  // Pairwise-match summary: { total, verified, running, error }
  matchStats: { type: Object, default: () => ({ total: 0, verified: 0, running: 0, error: 0 }) },
  // (sensorId) => number of images using that sensor
  sensorImageCount: { type: Function, default: () => 0 },
  // Set of sensor ids with no usable calibration (intrinsics fall back to a
  // default-FOV guess) — flagged with a ⚠ in the sensor list.
  incompleteSensorIds: { type: Object, default: () => new Set() },
  selectedId: { type: String, default: null },
  // UUIDs registered in the sparse model; `hasSparse` gates whether "not in this
  // set" means unaligned (vs. reconstruction simply not having run yet).
  alignedUuids: { type: Object, default: () => new Set() },
  hasSparse:    { type: Boolean, default: false },
  // Ids of the tabs currently open (useTabs.openTabIds), so an "Open in tab"
  // action can read "Switch to tab" when its target is already open.
  openTabIds:   { type: Object, default: () => new Set() },
})

const emit = defineEmits([
  'add-images', 'import-file', 'remove-image', 'convert-image-to-raster', 'remove-gcp', 'select-gcp',
  'jump-to-image', 'remove-gcp-observation', 'open-gcp',
  'remove-sensor', 'merge-sensors', 'open-sensor', 'assign-sensor', 'remove-pose',
  'remove-shapefile', 'rename-shapefile', 'set-shapefile-on-map', 'zoom-to-shapefile',
  'select', 'open', 'show-info', 'delete-keypoints', 'zoom-to-image',
  'select-cloud', 'remove-cloud', 'rename-cloud', 'set-main-cloud', 'reconstruct',
  'open-matches', 'open-product', 'zoom-to-cloud',
  'open-raster', 'remove-raster', 'set-raster-kind', 'style-raster',
  'set-raster-on-map', 'set-raster-opacity', 'convert-raster-to-image',
])

// The provenance+role split behind the three cloud sections. Sparse is the model
// (Reconstruction) regardless of whether it was computed or COLMAP-imported;
// everything else divides on the already-persisted `imported` flag — computed
// outputs the pipeline may replace (Products) vs. evidence it must never touch
// (Reference Data). Filtering here keeps the sections dumb.
const sparseClouds    = computed(() => props.clouds.filter((c) => c.kind === 'sparse'))
const productClouds   = computed(() => props.clouds.filter((c) => c.kind !== 'sparse' && !c.imported))
const referenceClouds = computed(() => props.clouds.filter((c) => c.kind !== 'sparse' && c.imported))

// Whole-sidebar drag-and-drop (counter avoids false dragleave on children)
const isDragging = ref(false)
let dragCounter = 0

function onDragEnter(e) {
  e.preventDefault()
  dragCounter++
  isDragging.value = true
}

function onDragLeave() {
  if (--dragCounter === 0) isDragging.value = false
}

function onDrop(e) {
  e.preventDefault()
  dragCounter = 0
  isDragging.value = false
  const all = [...e.dataTransfer.files]
  const images = all.filter((f) => f.type.startsWith('image/'))
  if (images.length) emit('add-images', images)
  // Route the first non-image file (e.g. a .csv/.txt list of GCPs or camera
  // positions) to the importer, which classifies it and opens the right modal.
  const other = all.find((f) => !f.type.startsWith('image/'))
  if (other) emit('import-file', other)
}

// Collapsible section open/close state (kept here; sections receive it as a prop
// and emit `toggle`). Each section owns its own row rendering + context menu.
// Sections start collapsed on load and re-collapse whenever a project is
// created/opened, so a new project always presents the same tidy sidebar.
function allClosed() {
  return {
    images: false, gcps: false, footprints: false, sensors: false, matches: false,
    reconstruction: false, products: false, reference: false,
  }
}

const open = ref(allClosed())

function toggle(key) {
  open.value[key] = !open.value[key]
}

// The sidebar stays mounted across project switches, so the initial value alone
// wouldn't reset it.
const projects = useProjectsStore()
watch(() => projects.currentProjectId, () => { open.value = allClosed() })
watch(() => props.pendingRasters.length, (count, previous) => {
  if (count > previous) open.value.reference = true
})
</script>

<template>
  <aside
    class="sidebar"
    :class="{ dragging: isDragging }"
    @dragover.prevent
    @dragenter="onDragEnter"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Drop overlay -->
    <div v-if="isDragging" class="drop-overlay">Drop images or a GCP file</div>

    <ImagesSection
      :open="open.images"
      :images="images"
      :sensors="sensors"
      :poses="poses"
      :selected-id="selectedId"
      :aligned-uuids="alignedUuids"
      :has-sparse="hasSparse"
      :open-tab-ids="openTabIds"
      @toggle="toggle('images')"
      @select="emit('select', $event)"
      @open="emit('open', $event)"
      @show-info="emit('show-info', $event)"
      @zoom-to-image="emit('zoom-to-image', $event)"
      @delete-keypoints="emit('delete-keypoints', $event)"
      @remove-image="emit('remove-image', $event)"
      @convert-to-raster="emit('convert-image-to-raster', $event)"
    />

    <SensorsSection
      :open="open.sensors"
      :sensors="sensors"
      :sensor-image-count="sensorImageCount"
      :incomplete-sensor-ids="incompleteSensorIds"
      @toggle="toggle('sensors')"
      @remove-sensor="emit('remove-sensor', $event)"
      @merge-sensors="emit('merge-sensors', $event)"
      @open-sensor="emit('open-sensor', $event)"
    />

    <MatchesSection
      :open="open.matches"
      :match-stats="matchStats"
      @toggle="toggle('matches')"
      @open-matches="emit('open-matches')"
    />

    <GcpsSection
      :open="open.gcps"
      :gcps="gcps"
      :report="gcpReport"
      :selected-gcp-id="selectedGcpId"
      @toggle="toggle('gcps')"
      @remove-gcp="emit('remove-gcp', $event)"
      @select="emit('select-gcp', $event)"
      @jump-to-image="emit('jump-to-image', $event)"
      @remove-observation="emit('remove-gcp-observation', $event)"
      @open-gcp="emit('open-gcp', $event)"
    />

    <!-- Shapefiles (vector polygon layers) are optional: only show when some exist. -->
    <ShapefilesSection
      v-if="shapefiles.length"
      :open="open.footprints"
      :sets="shapefiles"
      @toggle="toggle('footprints')"
      @remove-shapefile="emit('remove-shapefile', $event)"
      @rename-shapefile="emit('rename-shapefile', $event)"
      @set-shapefile-on-map="emit('set-shapefile-on-map', $event)"
      @zoom-to-shapefile="emit('zoom-to-shapefile', $event)"
      @jump-to-image="emit('jump-to-image', $event)"
    />

    <ReconstructionSection
      :open="open.reconstruction"
      :clouds="sparseClouds"
      :selected-cloud-id="selectedCloudId"
      :main-sparse-id="mainSparseId"
      :recon-status="reconStatus"
      @toggle="toggle('reconstruction')"
      @select-cloud="emit('select-cloud', $event)"
      @remove-cloud="emit('remove-cloud', $event)"
      @rename-cloud="emit('rename-cloud', $event)"
      @set-main-cloud="emit('set-main-cloud', $event)"
      @reconstruct="emit('reconstruct')"
      @zoom-to-cloud="emit('zoom-to-cloud', $event)"
    />

    <ProductsSection
      :open="open.products"
      :clouds="productClouds"
      :selected-cloud-id="selectedCloudId"
      :dem="dem"
      :ortho="ortho"
      :open-tab-ids="openTabIds"
      @toggle="toggle('products')"
      @open-product="emit('open-product', $event)"
      @select-cloud="emit('select-cloud', $event)"
      @remove-cloud="emit('remove-cloud', $event)"
      @rename-cloud="emit('rename-cloud', $event)"
      @zoom-to-cloud="emit('zoom-to-cloud', $event)"
    />

    <!-- Only shown once something imported exists — an always-empty section is
         noise in a sidebar this dense. -->
    <ReferenceSection
      v-if="referenceClouds.length || rasters.length || pendingRasters.length"
      :open="open.reference"
      :clouds="referenceClouds"
      :selected-cloud-id="selectedCloudId"
      :rasters="rasters"
      :pending-rasters="pendingRasters"
      :open-tab-ids="openTabIds"
      @toggle="toggle('reference')"
      @select-cloud="emit('select-cloud', $event)"
      @remove-cloud="emit('remove-cloud', $event)"
      @rename-cloud="emit('rename-cloud', $event)"
      @zoom-to-cloud="emit('zoom-to-cloud', $event)"
      @open-raster="emit('open-raster', $event)"
      @remove-raster="emit('remove-raster', $event)"
      @set-raster-kind="emit('set-raster-kind', $event)"
      @style-raster="emit('style-raster', $event)"
      @set-raster-on-map="emit('set-raster-on-map', $event)"
      @set-raster-opacity="emit('set-raster-opacity', $event)"
      @convert-to-image="emit('convert-raster-to-image', $event)"
    />
  </aside>
</template>

<style scoped>
.sidebar {
  width: 220px;
  flex-shrink: 0;
  height: 100%;
  background: var(--panel);
  border-right: 1px solid var(--panel-border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  position: relative;
}

/* Drop overlay */
.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: none;
  background: rgba(14, 99, 156, 0.12);
  border: 2px dashed var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
}
</style>
