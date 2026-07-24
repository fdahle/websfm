<script setup>
import { ref, nextTick } from 'vue'
import { useContextMenu } from '../../../composables/useContextMenu.js'

// Vector polygon layers ("shapefiles") — one row per SET (a computed footprint
// run, or an imported polygon file). Each set is managed as a unit, like an
// imported raster: show/hide on the map, rename, zoom to, delete. The polygons
// inside a set keep their own image link (used for spatial match preselection),
// shown in the expanded detail.
const props = defineProps({
  open: { type: Boolean, default: true },
  // [{ id, name, source, onMap, footprints: [{ id, imageId, imageName, rings }] }]
  sets: { type: Array, default: () => [] },
})
const emit = defineEmits([
  'toggle', 'remove-shapefile', 'rename-shapefile', 'set-shapefile-on-map',
  'zoom-to-shapefile', 'jump-to-image',
])

const expanded = ref({})
function toggleExpand(id) {
  if (expanded.value[id]) delete expanded.value[id]
  else expanded.value[id] = true
}

const linkedCount = (set) => set.footprints.filter((fp) => fp.imageId).length
const sourceLabel = (set) => (set.source === 'imported' ? 'Imported' : 'Computed')

// Inline rename. Only one set edits at a time; a function ref captures the single
// live input element (a plain ref inside the v-for would collect into an array).
const editingId = ref(null)
const editingName = ref('')
const renameInput = ref(null)
function setRenameInput(el) { if (el) renameInput.value = el }
function startRename(set) {
  editingId.value = set.id
  editingName.value = set.name
  nextTick(() => { renameInput.value?.focus(); renameInput.value?.select() })
}
function commitRename() {
  if (editingId.value == null) return
  emit('rename-shapefile', { id: editingId.value, name: editingName.value })
  editingId.value = null
}
function cancelRename() { editingId.value = null }

const { menu: ctx, open: openCtx, close: closeMenu } = useContextMenu()
function onRightClick(e, set) { openCtx(e, { set }, { w: 180, h: 156 }) }
function ctxToggleMap() {
  const s = ctx.value.set
  emit('set-shapefile-on-map', { id: s.id, onMap: s.onMap === false })
  closeMenu()
}
function ctxZoom()   { emit('zoom-to-shapefile', ctx.value.set.id); closeMenu() }
function ctxRename() { startRename(ctx.value.set); closeMenu() }
function ctxRemove() { emit('remove-shapefile', ctx.value.set.id); closeMenu() }
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
          @dblclick="emit('zoom-to-shapefile', set.id)"
          @contextmenu="onRightClick($event, set)"
        >
          <button
            class="expand-btn"
            :class="{ open: expanded[set.id] }"
            @click.stop="toggleExpand(set.id)"
            :title="expanded[set.id] ? 'Collapse' : 'Expand'"
          ></button>
          <input
            v-if="editingId === set.id"
            :ref="setRenameInput"
            v-model="editingName"
            class="rename-input"
            @click.stop
            @dblclick.stop
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename"
          />
          <span v-else class="item-name">{{ set.name }}</span>
          <span
            v-if="set.onMap !== false"
            class="map-flag"
            title="Shown on the map — right-click to hide"
          >◉</span>
          <span class="obs-badge" :title="`${set.footprints.length} polygon(s)`">{{ set.footprints.length }}</span>
        </li>
        <li v-if="expanded[set.id]" class="img-details" @contextmenu.stop>
          <div class="detail-row">
            <span class="detail-label">Source</span>
            <span class="detail-value">{{ sourceLabel(set) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Polygons</span>
            <span class="detail-value">{{ set.footprints.length.toLocaleString() }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Linked to images</span>
            <span class="detail-value">{{ linkedCount(set) }} / {{ set.footprints.length }}</span>
          </div>
          <button class="link-btn" @click.stop="emit('zoom-to-shapefile', set.id)">Zoom to layer</button>
        </li>
      </template>

      <li v-if="!sets.length" class="empty">
        No shapefiles — compute footprints from poses, or import a polygon file
      </li>
    </ul>

    <Teleport to="body">
      <div
        v-if="ctx"
        class="ctx-menu"
        :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item" @click="ctxToggleMap">
          {{ ctx.set.onMap === false ? 'Display on map' : 'Hide from map' }}
        </button>
        <button class="ctx-item" @click="ctxZoom">Zoom to layer</button>
        <button class="ctx-item" @click="ctxRename">Rename…</button>
        <div class="ctx-sep"></div>
        <button class="ctx-item danger" @click="ctxRemove">Remove</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
<style scoped>
.map-flag {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 15px;
  color: var(--accent, #4a9eff);
}
</style>
