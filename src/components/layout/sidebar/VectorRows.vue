<script setup>
import { useContextMenu } from '../../../composables/useContextMenu.js'
import { useExpandedSet } from '../../../composables/useExpandedSet.js'
import { useInlineRename } from '../../../composables/useInlineRename.js'
import ContextMenu from './ContextMenu.vue'
import { useSidebar } from './sidebarContext.js'
import { pluralize } from '../../../core/textFormat.js'

// The vector layer rows, shared by Products (contour lines from the DEM) and
// Reference Data (imported polygon files), as CloudRows is for clouds. Renders a
// fragment of <li>s for the section's own <ul>. Each set is managed as a unit, like
// a raster: on the map (in its Layers) or not, opacity, zoom to, download, rename, remove. The
// polygons of an imported file keep their own image link (used for spatial match
// preselection), counted in the details. The image footprints are not a layer and
// have no row (core/products/vectorLayers.js).
defineProps({
  // [{ id, name, source, kind?, visible, opacity, footprints }]
  sets: { type: Array, default: () => [] },
})
const sidebar = useSidebar()

const { isExpanded, toggle: toggleExpand } = useExpandedSet()

const isLines = (set) => set.kind === 'lines'
const linkedCount = (set) => set.footprints.filter((fp) => fp.imageId).length
const featureNoun = (set) => (isLines(set) ? 'line' : 'polygon')
const sourceLabel = (set) => (set.source === 'imported' ? 'Imported' : 'Contours from the DEM')

const {
  editingId,
  editingName,
  setInput: setRenameInput,
  start: startRename,
  commit: commitRename,
  cancel: cancelRename,
} = useInlineRename((id, name) => sidebar.renameVectorSet({ id, name }))

const { menu: ctx, open: openCtx, close: closeMenu } = useContextMenu()
// Run a menu item against the row it was opened on, then close.
function fromMenu(fn) {
  const set = ctx.value.set
  closeMenu()
  fn(set)
}
</script>

<template>
  <template v-for="set in sets" :key="set.id">
    <li
      class="list-item"
      :title="`${set.name} — double-click to zoom`"
      @dblclick="sidebar.zoomToVectorSet(set.id)"
      @contextmenu="openCtx($event, { set })"
    >
      <button
        class="expand-btn"
        :class="{ open: isExpanded(set.id) }"
        @click.stop="toggleExpand(set.id)"
        :title="isExpanded(set.id) ? 'Collapse' : 'Expand'"
      ></button>
      <input
        class="map-visibility"
        type="checkbox"
        :checked="set.visible !== false"
        :aria-label="`Add ${set.name} to the map's layers`"
        :title="'On the 2D map, listed in View ▸ Map ▸ Layers'"
        @click.stop
        @change="sidebar.setVectorVisible({ id: set.id, visible: $event.target.checked })"
      />
      <input
        v-if="editingId === set.id"
        :ref="setRenameInput"
        v-model="editingName"
        class="rename-input"
        @click.stop
        @dblclick.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent.stop="cancelRename"
        @blur="commitRename"
      />
      <span v-else class="item-name">{{ set.name }}</span>
      <span class="obs-badge" :title="pluralize(set.footprints.length, featureNoun(set))">{{
        isLines(set) ? 'Lines' : 'Polygons'
      }}</span>
    </li>
    <li v-if="isExpanded(set.id)" class="img-details" @contextmenu.stop>
      <div class="detail-row">
        <span class="detail-label">Source</span>
        <span class="detail-value">{{ sourceLabel(set) }}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">{{ isLines(set) ? 'Lines' : 'Polygons' }}</span>
        <span class="detail-value">{{ set.footprints.length.toLocaleString() }}</span>
      </div>
      <div v-if="!isLines(set)" class="detail-row">
        <span class="detail-label">Linked to images</span>
        <span class="detail-value">{{ linkedCount(set) }} / {{ set.footprints.length }}</span>
      </div>
      <!-- Opacity only matters while the layer is up (same rule as the rasters). -->
      <div v-if="set.visible !== false" class="detail-row">
        <span class="detail-label">Opacity</span>
        <span class="detail-value opacity-cell">
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            :value="set.opacity ?? 1"
            class="opacity-slider"
            @click.stop
            @input="sidebar.setVectorOpacity({ id: set.id, opacity: Number($event.target.value) })"
          />
          <span class="opacity-pct">{{ Math.round((set.opacity ?? 1) * 100) }}%</span>
        </span>
      </div>
      <button class="link-btn" @click.stop="sidebar.zoomToVectorSet(set.id)">Zoom to</button>
    </li>
  </template>

  <ContextMenu :menu="ctx">
    <template #default="{ menu }">
      <!-- Groups: get at it / how it's displayed → change it → destructive, as the
           raster and cloud menus. -->
      <button class="ctx-item" @click="fromMenu((s) => sidebar.zoomToVectorSet(s.id))">Zoom to</button>
      <button
        class="ctx-item"
        @click="fromMenu((s) => sidebar.setVectorVisible({ id: s.id, visible: s.visible === false }))"
      >
        {{ menu.set.visible === false ? 'Add to Layers' : 'Remove from Layers' }}
      </button>
      <button class="ctx-item" @click="fromMenu((s) => sidebar.showProductInfo({ vectorSetId: s.id }))">
        Show information
      </button>
      <button class="ctx-item" @click="fromMenu((s) => sidebar.downloadVectorSet(s.id))">Download…</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" @click="fromMenu((s) => startRename(s.id, s.name))">Rename</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item danger" @click="fromMenu((s) => sidebar.removeVectorSet(s.id))">Remove</button>
    </template>
  </ContextMenu>
</template>

<style scoped src="./sidebar-sections.css"></style>
