<script setup>
import { ref } from 'vue'
import ImagesSection from './sidebar/ImagesSection.vue'
import SensorsSection from './sidebar/SensorsSection.vue'
import MatchesSection from './sidebar/MatchesSection.vue'
import GcpsSection from './sidebar/GcpsSection.vue'
import FootprintsSection from './sidebar/FootprintsSection.vue'
import CloudsSection from './sidebar/CloudsSection.vue'
import ProductsSection from './sidebar/ProductsSection.vue'

defineProps({
  images:     { type: Array,  required: true },
  gcps:       { type: Array,  default: () => [] },
  gcpReport:  { type: Array,  default: () => [] },
  selectedGcpId: { type: String, default: null },
  sensors:    { type: Array,  default: () => [] },
  poses:      { type: Array,  default: () => [] },
  // Image footprint polygons (imported or computed from poses); the section only
  // renders when at least one exists.
  footprints: { type: Array,  default: () => [] },
  // Point clouds: [{ id, name, kind, createdAt, cameras: Map, points: [] }]
  clouds:     { type: Array,  default: () => [] },
  selectedCloudId: { type: String, default: null },
  // Raster products (recomputable): DEM / orthophoto, or null when not built.
  dem:        { type: Object, default: null },
  ortho:      { type: Object, default: null },
  reconStatus: { type: String, default: 'idle' }, // 'idle'|'running'|'done'|'error'
  // Pairwise-match summary: { total, verified, running, error }
  matchStats: { type: Object, default: () => ({ total: 0, verified: 0, running: 0, error: 0 }) },
  // (sensorId) => number of images using that sensor
  sensorImageCount: { type: Function, default: () => 0 },
  selectedId: { type: String, default: null },
  // UUIDs registered in the sparse model; `hasSparse` gates whether "not in this
  // set" means unaligned (vs. reconstruction simply not having run yet).
  alignedUuids: { type: Object, default: () => new Set() },
  hasSparse:    { type: Boolean, default: false },
})

const emit = defineEmits([
  'add-images', 'import-file', 'remove-image', 'remove-gcp', 'select-gcp',
  'jump-to-image', 'remove-gcp-observation',
  'remove-sensor', 'merge-sensors', 'assign-sensor', 'remove-pose',
  'remove-footprint',
  'select', 'open', 'show-info', 'delete-keypoints', 'zoom-to-image',
  'select-cloud', 'remove-cloud', 'rename-cloud', 'reconstruct',
  'open-matches', 'open-product', 'zoom-to-cloud',
])

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
const open = ref({ images: true, gcps: true, footprints: true, sensors: false, matches: true, clouds: true, products: true })

function toggle(key) {
  open.value[key] = !open.value[key]
}
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
      @toggle="toggle('images')"
      @select="emit('select', $event)"
      @open="emit('open', $event)"
      @show-info="emit('show-info', $event)"
      @zoom-to-image="emit('zoom-to-image', $event)"
      @delete-keypoints="emit('delete-keypoints', $event)"
      @remove-image="emit('remove-image', $event)"
      @assign-sensor="emit('assign-sensor', $event)"
    />

    <SensorsSection
      :open="open.sensors"
      :sensors="sensors"
      :sensor-image-count="sensorImageCount"
      @toggle="toggle('sensors')"
      @remove-sensor="emit('remove-sensor', $event)"
      @merge-sensors="emit('merge-sensors', $event)"
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
    />

    <!-- Footprints are optional: only show the section when some exist. -->
    <FootprintsSection
      v-if="footprints.length"
      :open="open.footprints"
      :footprints="footprints"
      @toggle="toggle('footprints')"
      @remove-footprint="emit('remove-footprint', $event)"
      @jump-to-image="emit('jump-to-image', $event)"
    />

    <CloudsSection
      :open="open.clouds"
      :clouds="clouds"
      :selected-cloud-id="selectedCloudId"
      :recon-status="reconStatus"
      @toggle="toggle('clouds')"
      @select-cloud="emit('select-cloud', $event)"
      @remove-cloud="emit('remove-cloud', $event)"
      @rename-cloud="emit('rename-cloud', $event)"
      @reconstruct="emit('reconstruct')"
      @zoom-to-cloud="emit('zoom-to-cloud', $event)"
    />

    <ProductsSection
      :open="open.products"
      :dem="dem"
      :ortho="ortho"
      @toggle="toggle('products')"
      @open-product="emit('open-product', $event)"
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
