<script setup>
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import FloatingToolbox from '../FloatingToolbox.vue'
import { useExternalStore } from '../../../stores/useExternalStore.js'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { productLabel, productMapBlocker } from '../../../core/products/productLayers.js'
import { mapLayerIds, moveMapLayer } from '../../../core/products/mapOrder.js'

// View ▸ Map ▸ Layers: a floating panel over the 2D map listing every raster the map
// can draw, in one stack whatever sidebar section it lives in: the imported reference
// rasters and the computed DEM / orthophoto. Top of the list draws on top
// (core/products/mapOrder.js); a row is dragged (or moved with ↑ ↓) to restack, and
// carries the same map checkbox and opacity as its own sidebar row. Vectors
// (contours, footprints, GCPs, cameras) always draw above every raster.
const emit = defineEmits(['close'])
const external = useExternalStore()
const { rasters } = storeToRefs(external)
const recon = useReconstructionStore()
const { dem, ortho, productLayers, mapOrder } = storeToRefs(recon)

const canMapRaster = (r) => !!r.previewDataUrl && !!r.crs && !r.crsUnresolved
const kindLabel = (k) => (k === 'dem' ? 'DEM' : 'Ortho')

// One row per layer: { id, name, kind, visible, opacity, blocked, set(visible), fade(opacity) }.
const rowsById = computed(() => {
  const rows = new Map()
  for (const r of rasters.value) {
    rows.set(r.id, {
      id: r.id,
      name: r.name,
      badge: kindLabel(r.kind),
      visible: !!r.visible,
      opacity: r.opacity ?? 1,
      blocked: canMapRaster(r) ? '' : 'No coordinate system or preview: the map cannot place it',
      set: (visible) => external.setRasterVisible(r.id, visible),
      fade: (opacity) => external.setRasterOpacity(r.id, opacity),
    })
  }
  for (const [kind, product] of [
    ['dem', dem.value],
    ['ortho', ortho.value],
  ]) {
    if (!product) continue
    const layer = productLayers.value[kind]
    rows.set(`product:${kind}`, {
      id: `product:${kind}`,
      name: productLabel(kind, product),
      badge: kindLabel(kind),
      visible: !!layer?.visible,
      opacity: layer?.opacity ?? 1,
      blocked: productMapBlocker(product) ?? '',
      set: (visible) => recon.setProductVisible(kind, visible),
      fade: (opacity) => recon.setProductOpacity(kind, opacity),
    })
  }
  return rows
})
// Top first. The default order (bottom first) is the reference rasters, then the DEM,
// then the orthophoto: what the map drew before anything was reordered.
const ids = computed(() => mapLayerIds([...rowsById.value.keys()], mapOrder.value))
const rows = computed(() => ids.value.map((id) => rowsById.value.get(id)))

function moveTo(id, index) {
  recon.setMapOrder(moveMapLayer(ids.value, id, index))
}

// Drag a row by its handle; dropping on another row puts it in that row's place.
const dragId = ref(null)
const overId = ref(null)
function onDragStart(e, id) {
  dragId.value = id
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', id)
}
function onDragOver(e, id) {
  if (!dragId.value) return
  e.preventDefault()
  overId.value = id
}
function onDrop(id) {
  if (dragId.value && dragId.value !== id) moveTo(dragId.value, ids.value.indexOf(id))
  onDragEnd()
}
function onDragEnd() {
  dragId.value = null
  overId.value = null
}
</script>

<template>
  <FloatingToolbox
    id="map-layers"
    title="Layers"
    :width="268"
    close-title="Close the layers panel"
    @close="emit('close')"
  >
    <p v-if="!rows.length" class="layer-note">
      Nothing to stack yet: build a DEM or an orthophoto, or import a raster.
    </p>
    <ul v-else class="item-list" aria-label="Map layers, top first">
      <li
        v-for="(row, i) in rows"
        :key="row.id"
        class="list-item layer-row"
        :class="{ dragging: dragId === row.id, over: overId === row.id && dragId !== row.id }"
        @dragover="(e) => onDragOver(e, row.id)"
        @drop.prevent="onDrop(row.id)"
      >
        <span
          class="drag-handle"
          draggable="true"
          title="Drag to restack: the top of the list draws on top"
          aria-hidden="true"
          @dragstart="(e) => onDragStart(e, row.id)"
          @dragend="onDragEnd"
          >⠿</span
        >
        <input
          class="map-visibility"
          type="checkbox"
          :checked="row.visible"
          :disabled="!!row.blocked && !row.visible"
          :aria-label="`Show ${row.name} on the map`"
          :title="row.blocked && !row.visible ? row.blocked : 'Shown on the 2D map'"
          @change="row.set($event.target.checked)"
        />
        <span class="item-name" :title="row.name">{{ row.name }}</span>
        <span class="obs-badge">{{ row.badge }}</span>
        <span class="move-btns">
          <button
            class="move-btn"
            :disabled="i === 0"
            :aria-label="`Move ${row.name} up`"
            title="Up: draw above the layer over it"
            @click="moveTo(row.id, i - 1)"
          >
            ▲
          </button>
          <button
            class="move-btn"
            :disabled="i === rows.length - 1"
            :aria-label="`Move ${row.name} down`"
            title="Down: draw below the layer under it"
            @click="moveTo(row.id, i + 1)"
          >
            ▼
          </button>
        </span>
        <!-- Second line: the panel is too narrow for a slider beside the name. -->
        <div class="layer-opacity">
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            class="opacity-slider"
            :value="row.opacity"
            :aria-label="`Opacity of ${row.name}`"
            title="Opacity on the map"
            @input="row.fade(Number($event.target.value))"
          />
          <span class="opacity-pct">{{ Math.round(row.opacity * 100) }}%</span>
        </div>
      </li>
      <li class="layer-note">
        Top draws on top. Contours, footprints, GCPs and cameras always draw above the rasters.
      </li>
    </ul>
  </FloatingToolbox>
</template>

<style scoped src="../../layout/sidebar/sidebar-sections.css"></style>
<style scoped>
.layer-row {
  height: auto;
  min-height: 24px;
  gap: 2px 4px;
  flex-wrap: wrap;
  padding-top: 4px;
  padding-bottom: 4px;
  cursor: default;
}
.layer-opacity {
  flex-basis: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 30px; /* under the name, past the handle and checkbox */
}
.layer-row.dragging {
  opacity: 0.45;
}
.layer-row.over {
  box-shadow: inset 0 2px 0 var(--accent);
}
.drag-handle {
  flex-shrink: 0;
  cursor: grab;
  color: var(--text-dim);
  padding: 0 2px;
  user-select: none;
}
.layer-row .item-name {
  min-width: 0;
}
.move-btns {
  display: inline-flex;
  flex-direction: column;
  flex-shrink: 0;
}
.move-btn {
  padding: 0 4px;
  font-size: 9px;
  line-height: 10px;
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
}
.move-btn:hover:not(:disabled) {
  color: var(--accent);
}
.move-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.layer-note {
  padding: 4px 8px 6px;
  font-size: 11px;
  color: var(--text-dim);
  list-style: none;
}
</style>
