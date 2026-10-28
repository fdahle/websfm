<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useContextMenu } from '../../../composables/useContextMenu.js'
import { useExpandedSet } from '../../../composables/useExpandedSet.js'
import { useInlineRename } from '../../../composables/useInlineRename.js'
import ContextMenu from './ContextMenu.vue'
import { useSidebar } from './sidebarContext.js'
import { pluralize } from '../../../core/textFormat.js'

// The cloud list rows, shared by the three provenance-split sections
// (Reconstruction / Products / Reference Data). Renders a fragment of <li>s so
// each section can drop it straight into its own <ul> alongside other row kinds
// (Products also lists DEM/ortho rasters). The section owns the header, the
// empty state and *which* clouds it passes; this owns row rendering, inline
// rename and the right-click menu.
const props = defineProps({
  clouds: { type: Array, default: () => [] },
})
const sidebar = useSidebar()
const recon = useReconstructionStore()
const { selectedCloudId, clouds: allClouds } = storeToRefs(recon)

// The main one of each kind is what the next step uses (mainSparseId for the model,
// mainProductIds for dense and mesh). Its badge only tells products apart: a sparse
// model always shows it (it was always there), a dense cloud or mesh once there are two.
const rowState = computed(() => {
  const out = new Map()
  for (const cloud of props.clouds) {
    const main = recon.isMainProduct(cloud)
    const many = cloud.kind === 'sparse' || allClouds.value.filter((c) => c.kind === cloud.kind).length > 1
    const status = recon.productStatus(cloud)
    out.set(cloud.id, { main, showMain: main && many, outdated: status.outdated ? status.reason : null })
  }
  return out
})
const MAIN_TITLE = {
  sparse: 'Main sparse cloud — used for dense / DEM / ortho / export',
  dense: 'Main dense cloud — the next DEM, mesh or ortho uses this one',
  mesh: 'Main mesh — a mesh-surface orthophoto uses this one',
}

const { isExpanded: isCloudExpanded, toggle: toggleCloudExpand } = useExpandedSet()

const cloudKindLabel = (kind) => (kind === 'dense' ? 'Dense' : kind === 'mesh' ? 'Mesh' : 'Sparse')

// Tie-points = sparse points carrying at least one view-track. (Dense/mesh clouds
// have no tracks, so this is only shown for sparse clouds.)
function tiePointCount(cloud) {
  if (cloud.kind === 'dense' || cloud.kind === 'mesh') return 0
  const pts = cloud.points
  let n = 0
  for (let i = 0; i < pts.length; i++) if (pts.vcount[i] > 0) n++
  return n
}

// Primary count across shapes: triangles for a mesh, points otherwise (sparse
// SparsePoints vs dense flat { count }). Mesh `count` is the triangle count (nVerts is separate).
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

// Inline rename. Only one cloud edits at a time.
const {
  editingId: editingCloudId,
  editingName,
  setInput: setRenameInput,
  start: startRename,
  commit: commitRename,
  cancel: cancelRename,
} = useInlineRename((id, name) => sidebar.renameCloud({ id, name }))

// Point cloud context menu (right-click). { x, y, cloud }
const { menu: cloudCtx, open: openCloudCtx, close: closeMenu } = useContextMenu()
// Run a menu item against the cloud it was opened on, then close.
function fromMenu(fn) {
  const cloud = cloudCtx.value.cloud
  closeMenu()
  fn(cloud)
}
</script>

<template>
  <template v-for="cloud in clouds" :key="cloud.id">
    <li
      class="list-item"
      :class="{ selected: cloud.id === selectedCloudId }"
      :title="cloud.name"
      @click="sidebar.selectCloud(cloud.id)"
      @contextmenu="openCloudCtx($event, { cloud })"
    >
      <button
        class="expand-btn"
        :class="{ open: isCloudExpanded(cloud.id) }"
        @click.stop="toggleCloudExpand(cloud.id)"
        :title="isCloudExpanded(cloud.id) ? 'Collapse' : 'Expand'"
      ></button>
      <input
        class="cloud-visibility"
        type="checkbox"
        :checked="cloud.visible !== false"
        :aria-label="`Show ${cloud.name} in 3D`"
        title="Visible in 3D"
        @click.stop
        @change="sidebar.cloudVisibility({ id: cloud.id, visible: $event.target.checked })"
      />
      <input
        v-if="editingCloudId === cloud.id"
        :ref="setRenameInput"
        v-model="editingName"
        class="rename-input"
        @click.stop
        @dblclick.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent.stop="cancelRename"
        @blur="commitRename"
      />
      <span v-else class="item-name">{{ cloud.name }}</span>
      <span v-if="rowState.get(cloud.id)?.showMain" class="main-badge" :title="MAIN_TITLE[cloud.kind]">main</span>
      <span
        v-if="rowState.get(cloud.id)?.outdated"
        class="outdated-badge"
        :title="`Outdated: ${rowState.get(cloud.id).outdated}`"
        >outdated</span
      >
      <!-- Provenance chip: which of these you brought in is exactly the thing you
           forget three weeks later, and it's the difference between re-fusable
           and sacred. -->
      <!-- Independent of the main badge, not v-else-if: role and provenance are
           different questions, and a COLMAP import set as main answers both. -->
      <span v-if="cloud.imported" class="imported-badge" title="Imported — the pipeline never overwrites this cloud"
        >imported</span
      >
      <span
        v-if="cloud.kind === 'dense' && cloud.lod && !cloud.pos && cloud.lod.format === 'copc'"
        class="imported-badge"
        :title="`Read in place from its COPC file — the file's own level-of-detail octree, never loaded whole${cloud.lod.file?.crs ? ` (${cloud.lod.file.crs})` : ''}; tools that need every point in memory leave it out`"
        >COPC</span
      >
      <span
        v-else-if="cloud.kind === 'dense' && cloud.lod && !cloud.pos"
        class="imported-badge"
        title="Streamed — too large to hold in memory, drawn from its level-of-detail octree; tools that need every point in memory leave it out"
        >streamed</span
      >
      <!-- Only sparse clouds carry cameras; dense/mesh hold an empty Map, so the
           badge would read a permanent, meaningless 0. -->
      <span v-if="cloud.kind === 'sparse'" class="obs-badge" :title="`${pluralize(cloud.cameras.size, 'camera')}`">{{
        cloud.cameras.size
      }}</span>
    </li>
    <li v-if="isCloudExpanded(cloud.id)" class="img-details" @contextmenu.stop>
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
  <ContextMenu :menu="cloudCtx">
    <template #default="{ menu }">
      <!-- Groups: go there → change it → destructive. Same order as the image and
           reference-raster menus. -->
      <button class="ctx-item" @click="fromMenu((c) => sidebar.zoomToCloud(c.id))">Zoom to</button>
      <button class="ctx-item" @click="fromMenu((c) => sidebar.showProductInfo({ cloudId: c.id }))">
        Show information
      </button>
      <button class="ctx-item" @click="fromMenu((c) => sidebar.cloudSymbology(c.id))">Symbology…</button>
      <!-- The export dialog (format, georeference, …) aimed at this cloud. -->
      <button class="ctx-item" @click="fromMenu((c) => sidebar.downloadCloud(c.id))">Download…</button>
      <div class="ctx-sep"></div>
      <button
        v-if="!rowState.get(menu.cloud.id)?.main"
        class="ctx-item"
        @click="fromMenu((c) => sidebar.setMainCloud(c.id))"
      >
        Set as main
      </button>
      <button class="ctx-item" @click="fromMenu((c) => startRename(c.id, c.name))">Rename</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item danger" @click="fromMenu((c) => sidebar.removeCloud(c.id))">Remove</button>
    </template>
  </ContextMenu>
</template>

<style scoped src="./sidebar-sections.css"></style>
<style scoped>
.cloud-visibility {
  flex-shrink: 0;
  margin: 0 6px 0 0;
  accent-color: var(--accent);
}
</style>
