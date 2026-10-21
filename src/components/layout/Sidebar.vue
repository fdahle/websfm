<script setup>
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useExternalStore } from '../../stores/useExternalStore.js'
import { useFootprintsStore } from '../../stores/useFootprintsStore.js'
import { useProjectsStore } from '../../stores/useProjectsStore.js'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'
import ImagesSection from './sidebar/ImagesSection.vue'
import SensorsSection from './sidebar/SensorsSection.vue'
import MatchesSection from './sidebar/MatchesSection.vue'
import GcpsSection from './sidebar/GcpsSection.vue'
import ShapefilesSection from './sidebar/ShapefilesSection.vue'
import ReconstructionSection from './sidebar/ReconstructionSection.vue'
import ProductsSection from './sidebar/ProductsSection.vue'
import ReferenceSection from './sidebar/ReferenceSection.vue'
import { useSidebar } from './sidebar/sidebarContext.js'

// The sections read their data from the stores and act through the sidebar
// context App.vue provides (sidebar/sidebarContext.js); this shell only owns
// which sections are open, the cloud split between three of them, and drops.
const sidebar = useSidebar()
const { clouds } = storeToRefs(useReconstructionStore())
const { sets: shapefiles } = storeToRefs(useFootprintsStore())
const { rasters, pendingRasters } = storeToRefs(useExternalStore())

// The provenance+role split behind the three cloud sections. Sparse is the model
// (Reconstruction) regardless of whether it was computed or COLMAP-imported;
// everything else divides on the already-persisted `imported` flag — computed
// outputs the pipeline may replace (Products) vs. evidence it must never touch
// (Reference Data). Filtering here keeps the sections dumb.
const sparseClouds = computed(() => clouds.value.filter((c) => c.kind === 'sparse'))
const productClouds = computed(() => clouds.value.filter((c) => c.kind !== 'sparse' && !c.imported))
const referenceClouds = computed(() => clouds.value.filter((c) => c.kind !== 'sparse' && c.imported))

// Whole-sidebar drag-and-drop (counter avoids false dragleave on children).
// Only a drag carrying files is an import: dragging image rows between groups
// inside the list must not raise the drop overlay.
const isDragging = ref(false)
let dragCounter = 0
const isFileDrag = (e) => !!e.dataTransfer?.types?.includes('Files')

function onDragEnter(e) {
  if (!isFileDrag(e)) return
  e.preventDefault()
  dragCounter++
  isDragging.value = true
}

function onDragLeave(e) {
  if (!isFileDrag(e)) return
  if (--dragCounter === 0) isDragging.value = false
}

function onDrop(e) {
  e.preventDefault()
  dragCounter = 0
  isDragging.value = false
  const all = [...e.dataTransfer.files]
  const images = all.filter((f) => f.type.startsWith('image/'))
  if (images.length) sidebar.addImages(images)
  // Route the first non-image file (e.g. a .csv/.txt list of GCPs or camera
  // positions) to the importer, which classifies it and opens the right modal.
  const other = all.find((f) => !f.type.startsWith('image/'))
  if (other) sidebar.importFile(other)
}

// Collapsible section open/close state (kept here; sections receive it as a prop
// and emit `toggle`). Each section owns its own row rendering + context menu.
// Sections start collapsed on load and re-collapse whenever a project is
// created/opened, so a new project always presents the same tidy sidebar.
function allClosed() {
  return {
    images: false,
    gcps: false,
    footprints: false,
    sensors: false,
    matches: false,
    reconstruction: false,
    products: false,
    reference: false,
  }
}

const open = ref(allClosed())

function toggle(key) {
  open.value[key] = !open.value[key]
}

// The sidebar stays mounted across project switches, so the initial value alone
// wouldn't reset it.
const projects = useProjectsStore()
watch(
  () => projects.currentProjectId,
  () => {
    open.value = allClosed()
  },
)
watch(
  () => pendingRasters.value.length,
  (count, previous) => {
    if (count > previous) open.value.reference = true
  },
)
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
    <div v-if="isDragging" class="drop-overlay">Drop images, a video or data files to import</div>

    <ImagesSection :open="open.images" @toggle="toggle('images')" />
    <SensorsSection :open="open.sensors" @toggle="toggle('sensors')" />
    <MatchesSection :open="open.matches" @toggle="toggle('matches')" />
    <GcpsSection :open="open.gcps" @toggle="toggle('gcps')" />

    <!-- Shapefiles (vector polygon layers) are optional: only show when some exist. -->
    <ShapefilesSection v-if="shapefiles.length" :open="open.footprints" @toggle="toggle('footprints')" />

    <ReconstructionSection :open="open.reconstruction" :clouds="sparseClouds" @toggle="toggle('reconstruction')" />
    <ProductsSection :open="open.products" :clouds="productClouds" @toggle="toggle('products')" />

    <!-- Only shown once something imported exists — an always-empty section is
         noise in a sidebar this dense. -->
    <ReferenceSection
      v-if="referenceClouds.length || rasters.length || pendingRasters.length"
      :open="open.reference"
      :clouds="referenceClouds"
      @toggle="toggle('reference')"
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
