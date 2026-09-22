<script setup>
import { ref, nextTick } from 'vue'
import { useContextMenu } from '../../../composables/useContextMenu.js'

// The cloud list rows, shared by the three provenance-split sections
// (Reconstruction / Products / Reference Data). Renders a fragment of <li>s so
// each section can drop it straight into its own <ul> alongside other row kinds
// (Products also lists DEM/ortho rasters). The section owns the header, the
// empty state and *which* clouds it passes; this owns row rendering, inline
// rename and the right-click menu.
const props = defineProps({
  clouds:          { type: Array, default: () => [] },
  selectedCloudId: { type: String, default: null },
  mainSparseId:    { type: String, default: null }, // sparse cloud downstream stages consume
})
const emit = defineEmits(['select-cloud', 'remove-cloud', 'rename-cloud', 'set-main-cloud', 'zoom-to-cloud'])

const cloudExpanded = ref({})
function toggleCloudExpand(id) {
  if (cloudExpanded.value[id]) delete cloudExpanded.value[id]
  else cloudExpanded.value[id] = true
}

const cloudKindLabel = (kind) => (kind === 'dense' ? 'Dense' : kind === 'mesh' ? 'Mesh' : 'Sparse')

// Tie-points = sparse points carrying at least one view-track. (Dense/mesh clouds
// have no tracks, so this is only shown for sparse clouds.)
function tiePointCount(cloud) {
  // Only sparse clouds carry tracks; dense/mesh clouds are flat (no per-point objects).
  return (cloud.kind === 'dense' || cloud.kind === 'mesh')
    ? 0 : cloud.points.reduce((n, p) => n + (p.views?.size > 0 ? 1 : 0), 0)
}

// Primary count across shapes: triangles for a mesh, points otherwise (sparse array
// vs dense flat { count }). Mesh `count` is the triangle count (nVerts is separate).
function pointCount(cloud) {
  if (cloud.kind === 'mesh') return cloud.count ?? 0
  return cloud.kind === 'dense' ? (cloud.count ?? 0) : cloud.points.length
}
// Label for the primary count row — "Triangles" for a mesh, "Points" otherwise.
const countLabel = (cloud) => (cloud.kind === 'mesh' ? 'Triangles' : 'Points')

function fmtCreated(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
}

// Inline rename. Only one cloud edits at a time. The input lives inside the cloud
// v-for, so a plain `ref="…"` would collect into an *array* (leaving `.focus()`
// a silent no-op — the field never focuses and never blurs, so the row appears
// stuck in rename mode). A function ref captures the single live element instead.
const editingCloudId = ref(null)
const editingName = ref('')
const renameInput = ref(null)

function setRenameInput(el) {
  if (el) renameInput.value = el
}

function startRename(cloud) {
  editingCloudId.value = cloud.id
  editingName.value = cloud.name
  nextTick(() => { renameInput.value?.focus(); renameInput.value?.select() })
}

function commitRename() {
  if (editingCloudId.value == null) return
  emit('rename-cloud', { id: editingCloudId.value, name: editingName.value })
  editingCloudId.value = null
}

function cancelRename() {
  editingCloudId.value = null
}

// Point cloud context menu (right-click). { x, y, cloud }
const { menu: cloudCtx, open: openCloudCtx, close: closeMenu } = useContextMenu()
function onCloudRightClick(e, cloud) {
  // "Set as main" adds a row for sparse clouds that aren't already main.
  const extra = cloud.kind === 'sparse' && cloud.id !== props.mainSparseId ? 28 : 0
  openCloudCtx(e, { cloud }, { w: 180, h: 128 + extra })
}
function ctxSetMain()      { emit('set-main-cloud', cloudCtx.value.cloud.id); closeMenu() }
function ctxZoomCloud()    { emit('zoom-to-cloud', cloudCtx.value.cloud.id); closeMenu() }
function ctxRenameCloud()  { startRename(cloudCtx.value.cloud); closeMenu() }
function ctxRemoveCloud()  { emit('remove-cloud', cloudCtx.value.cloud.id); closeMenu() }
</script>

<template>
  <template v-for="cloud in clouds" :key="cloud.id">
    <li
      class="list-item"
      :class="{ selected: cloud.id === selectedCloudId }"
      :title="cloud.name"
      @click="emit('select-cloud', cloud.id)"
      @contextmenu="onCloudRightClick($event, cloud)"
    >
      <button
        class="expand-btn"
        :class="{ open: cloudExpanded[cloud.id] }"
        @click.stop="toggleCloudExpand(cloud.id)"
        :title="cloudExpanded[cloud.id] ? 'Collapse' : 'Expand'"
      ></button>
      <input
        v-if="editingCloudId === cloud.id"
        :ref="setRenameInput"
        v-model="editingName"
        class="rename-input"
        @click.stop
        @dblclick.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="cancelRename"
        @blur="commitRename"
      />
      <span v-else class="item-name">{{ cloud.name }}</span>
      <span
        v-if="cloud.id === mainSparseId"
        class="main-badge"
        title="Main sparse cloud — used for dense / DEM / ortho / export"
      >main</span>
      <!-- Provenance chip: which of these you brought in is exactly the thing you
           forget three weeks later, and it's the difference between re-fusable
           and sacred. -->
      <!-- Independent of the main badge, not v-else-if: role and provenance are
           different questions, and a COLMAP import set as main answers both. -->
      <span
        v-if="cloud.imported"
        class="imported-badge"
        title="Imported — the pipeline never overwrites this cloud"
      >imported</span>
      <!-- Only sparse clouds carry cameras; dense/mesh hold an empty Map, so the
           badge would read a permanent, meaningless 0. -->
      <span
        v-if="cloud.kind === 'sparse'"
        class="obs-badge"
        :title="`${cloud.cameras.size} camera(s)`"
      >{{ cloud.cameras.size }}</span>
    </li>
    <li v-if="cloudExpanded[cloud.id]" class="img-details" @contextmenu.stop>
      <div class="detail-row">
        <span class="detail-label">Type</span>
        <span class="detail-value">{{ cloudKindLabel(cloud.kind) }}{{ cloud.imported ? ' (imported)' : '' }}</span>
      </div>
      <div v-if="cloud.kind === 'sparse'" class="detail-row">
        <span class="detail-label">Cameras</span>
        <span class="detail-value">{{ cloud.cameras.size }}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">{{ countLabel(cloud) }}</span>
        <span class="detail-value">{{ pointCount(cloud).toLocaleString() }}</span>
      </div>
      <div v-if="cloud.kind === 'mesh'" class="detail-row">
        <span class="detail-label">Vertices</span>
        <span class="detail-value">{{ (cloud.nVerts ?? 0).toLocaleString() }}</span>
      </div>
      <div v-if="cloud.kind === 'sparse'" class="detail-row">
        <span class="detail-label">Tie-points</span>
        <span class="detail-value">{{ tiePointCount(cloud).toLocaleString() }}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Created</span>
        <span class="detail-value">{{ fmtCreated(cloud.createdAt) }}</span>
      </div>
    </li>
  </template>

  <!-- Point cloud context menu -->
  <Teleport to="body">
    <div
      v-if="cloudCtx"
      class="ctx-menu"
      :style="{ left: cloudCtx.x + 'px', top: cloudCtx.y + 'px' }"
      @click.stop
    >
      <!-- Groups: go there → change it → destructive. Same order as the image and
           reference-raster menus. -->
      <button class="ctx-item" @click="ctxZoomCloud">Zoom to</button>
      <div class="ctx-sep"></div>
      <button
        v-if="cloudCtx.cloud.kind === 'sparse' && cloudCtx.cloud.id !== mainSparseId"
        class="ctx-item"
        @click="ctxSetMain"
      >Set as main</button>
      <button class="ctx-item" @click="ctxRenameCloud">Rename</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item danger" @click="ctxRemoveCloud">Remove</button>
    </div>
  </Teleport>
</template>

<style scoped src="./sidebar-sections.css"></style>
<style scoped>
/* Marks the sparse cloud downstream stages consume (MC). */
.main-badge {
  flex-shrink: 0;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--accent, #4a9eff);
  border: 1px solid var(--accent, #4a9eff);
  padding: 0 5px;
  border-radius: 8px;
  line-height: 15px;
}

/* Provenance chip on an imported cloud (muted — it's information, not a role). */
.imported-badge {
  flex-shrink: 0;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-dim, #8a8a8a);
  border: 1px solid var(--panel-border, #3a3a3a);
  padding: 0 5px;
  border-radius: 8px;
  line-height: 15px;
}
</style>
