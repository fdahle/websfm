<script setup>
import { storeToRefs } from 'pinia'
import { useFootprintsStore } from '../../../stores/useFootprintsStore.js'
import { useContextMenu } from '../../../composables/useContextMenu.js'
import { useExpandedSet } from '../../../composables/useExpandedSet.js'
import { useInlineRename } from '../../../composables/useInlineRename.js'
import ContextMenu from './ContextMenu.vue'
import { useSidebar } from './sidebarContext.js'
import { pluralize } from '../../../core/textFormat.js'

// Vector polygon layers ("shapefiles") — one row per SET (a computed footprint
// run, or an imported polygon file). Each set is managed as a unit, like an
// imported raster: show/hide on the map, rename, zoom to, delete. The polygons
// inside a set keep their own image link (used for spatial match preselection),
// shown in the expanded detail.
defineProps({
  open: { type: Boolean, default: true },
})
const emit = defineEmits(['toggle'])
const sidebar = useSidebar()
// [{ id, name, source, visible, footprints: [{ id, imageId, imageName, rings }] }]
const { sets } = storeToRefs(useFootprintsStore())

const { isExpanded, toggle: toggleExpand } = useExpandedSet()

const linkedCount = (set) => set.footprints.filter((fp) => fp.imageId).length
const sourceLabel = (set) =>
  set.source === 'imported' ? 'Imported' : set.kind === 'lines' ? 'Contours from the DEM' : 'Computed'
// A contour layer holds lines, every other layer polygons.
const featureNoun = (set) => (set.kind === 'lines' ? 'line' : 'polygon')

const {
  editingId,
  editingName,
  setInput: setRenameInput,
  start: startRename,
  commit: commitRename,
  cancel: cancelRename,
} = useInlineRename((id, name) => sidebar.renameShapefile({ id, name }))

const { menu: ctx, open: openCtx, close: closeMenu } = useContextMenu()
// Run a menu item against the row it was opened on, then close.
function fromMenu(fn) {
  const set = ctx.value.set
  closeMenu()
  fn(set)
}
</script>

<template>
  <div class="section">
    <button class="section-hd" @click="emit('toggle')">
      <span class="chevron">{{ open ? '▾' : '▸' }}</span>
      <span class="section-name">Shapefiles</span>
      <span v-if="sets.length" class="badge">{{ sets.length }}</span>
    </button>
    <ul v-if="open" class="item-list">
      <template v-for="set in sets" :key="set.id">
        <li
          class="list-item"
          :title="`${set.name} — double-click to zoom`"
          @dblclick="sidebar.zoomToShapefile(set.id)"
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
            :aria-label="`Show ${set.name} on the map`"
            title="Shown on the 2D map"
            @click.stop
            @change="sidebar.setShapefileVisible({ id: set.id, visible: $event.target.checked })"
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
          <span class="obs-badge" :title="`${pluralize(set.footprints.length, featureNoun(set))}`">{{
            set.footprints.length
          }}</span>
        </li>
        <li v-if="isExpanded(set.id)" class="img-details" @contextmenu.stop>
          <div class="detail-row">
            <span class="detail-label">Source</span>
            <span class="detail-value">{{ sourceLabel(set) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ set.kind === 'lines' ? 'Lines' : 'Polygons' }}</span>
            <span class="detail-value">{{ set.footprints.length.toLocaleString() }}</span>
          </div>
          <div v-if="set.kind !== 'lines'" class="detail-row">
            <span class="detail-label">Linked to images</span>
            <span class="detail-value">{{ linkedCount(set) }} / {{ set.footprints.length }}</span>
          </div>
          <button class="link-btn" @click.stop="sidebar.zoomToShapefile(set.id)">Zoom to</button>
        </li>
      </template>

      <li v-if="!sets.length" class="empty">No shapefiles — compute footprints from poses, or import a polygon file</li>
    </ul>

    <ContextMenu :menu="ctx">
      <template #default="{ menu }">
        <button
          class="ctx-item"
          @click="fromMenu((s) => sidebar.setShapefileVisible({ id: s.id, visible: s.visible === false }))"
        >
          {{ menu.set.visible === false ? 'Show on map' : 'Hide from map' }}
        </button>
        <button class="ctx-item" @click="fromMenu((s) => sidebar.zoomToShapefile(s.id))">Zoom to</button>
        <button class="ctx-item" @click="fromMenu((s) => sidebar.downloadShapefile(s.id))">Download GeoJSON</button>
        <button class="ctx-item" @click="fromMenu((s) => startRename(s.id, s.name))">Rename</button>
        <div class="ctx-sep"></div>
        <button class="ctx-item danger" @click="fromMenu((s) => sidebar.removeShapefile(s.id))">Remove</button>
      </template>
    </ContextMenu>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
