<script setup>
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import FloatingToolbox from '../FloatingToolbox.vue'
import Icon from '../../Icon.vue'
import { useExternalStore } from '../../../stores/useExternalStore.js'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useFootprintsStore } from '../../../stores/useFootprintsStore.js'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { productLabel, productLayerId, productMapBlocker } from '../../../core/products/productLayers.js'
import { mapLayerIds, moveMapLayer } from '../../../core/products/mapOrder.js'
import { isFootprintSet, vectorKind, vectorLayerId } from '../../../core/products/vectorLayers.js'
import { IMAGE_LAYER_ID } from '../../../core/products/imageOverlay.js'
import { t } from '../../../composables/useI18n.js'

// View ▸ Map ▸ Layers: the layers on the 2D map, as a GIS's layer list. The sidebar
// is the catalogue of everything the project holds; a layer is put on the map (and so
// listed here) with its sidebar checkbox or In Layers on its ribbon tab (the photos
// with View ▸ Map ▸ Photos), and a newly built DEM, orthophoto or contour set is put
// there on its own. Here the stack is
// arranged, whatever sidebar section a layer lives in:
//   • a row's checkbox hides the layer for a while and keeps it listed
//     (useReconstructionStore.mapHidden); its ✕ takes it off the map;
//   • the top of the list draws on top (core/products/mapOrder.js): drag a row by ⠿,
//     or move it with ▲ ▼;
//   • the selected row's settings (opacity, Zoom to) sit in one strip below the list,
//     so the rows stay one line each;
// The markers (footprints, GCPs, cameras) always draw above the stack, the basemap
// (chosen in the ribbon, View ▸ Map ▸ Basemap) under it.
const emit = defineEmits(['close', 'zoom-to'])
const external = useExternalStore()
const { rasters } = storeToRefs(external)
const recon = useReconstructionStore()
const { rasterProducts, productLayers, mapOrder, mapHidden, imageLayer } = storeToRefs(recon)
const { selectedId: selectedImageId } = storeToRefs(useImagesStore())
const vectors = useFootprintsStore()
const { sets: vectorSets } = storeToRefs(vectors)

const canMapRaster = (r) => !!r.previewDataUrl && !!r.crs && !r.crsUnresolved

// One row per layer on the map: { id, name, icon, kind, opacity, blocked, remove(),
// fade(opacity) }, and the Photos row's `mode` (which photos it draws).
const rowsById = computed(() => {
  const rows = new Map()
  for (const r of rasters.value) {
    if (!r.visible) continue
    rows.set(r.id, {
      id: r.id,
      name: r.name,
      icon: r.kind === 'dem' ? 'dem' : 'ortho',
      kind: t(r.kind === 'dem' ? 'mapLayers.kind.referenceDem' : 'mapLayers.kind.referenceOrtho'),
      opacity: r.opacity ?? 1,
      blocked: canMapRaster(r) ? '' : t('mapLayers.unplaced'),
      remove: () => external.setRasterVisible(r.id, false),
      fade: (opacity) => external.setRasterOpacity(r.id, opacity),
    })
  }
  for (const kind of ['dem', 'ortho'])
    for (const product of rasterProducts.value) {
      const layer = productLayers.value[product.id]
      if (product.kind !== kind || !layer?.visible) continue
      const id = productLayerId(product)
      rows.set(id, {
        id,
        name: productLabel(kind, product),
        icon: kind,
        kind: t(kind === 'dem' ? 'mapLayers.kind.dem' : 'mapLayers.kind.ortho'),
        opacity: layer.opacity ?? 1,
        blocked: productMapBlocker(product) ?? '',
        remove: () => recon.setProductVisible(product.id, false),
        fade: (opacity) => recon.setProductOpacity(product.id, opacity),
      })
    }
  for (const s of vectorSets.value) {
    if (isFootprintSet(s) || s.visible === false) continue
    const lines = vectorKind(s) === 'lines'
    rows.set(vectorLayerId(s.id), {
      id: vectorLayerId(s.id),
      name: s.name,
      icon: lines ? 'contours' : 'area',
      kind: t(lines ? 'mapLayers.kind.contours' : 'mapLayers.kind.polygons'),
      opacity: s.opacity ?? 1,
      blocked: '',
      remove: () => vectors.setSetVisible(s.id, false),
      fade: (opacity) => vectors.setSetOpacity(s.id, opacity),
    })
  }
  if (imageLayer.value?.visible) {
    rows.set(IMAGE_LAYER_ID, {
      id: IMAGE_LAYER_ID,
      name: t('mapLayers.photos'),
      icon: 'image',
      kind: t('mapLayers.kind.photos'),
      opacity: imageLayer.value.opacity ?? 1,
      blocked: '',
      mode: imageLayer.value.mode,
      remove: () => recon.setImageLayer({ visible: false }),
      fade: (opacity) => recon.setImageLayer({ opacity }),
    })
  }
  return rows
})
// Top first. The default order (bottom first) is the reference rasters, then the DEM,
// the orthophoto, the photos and the vector layers: what the map draws before anything
// is reordered.
const ids = computed(() => mapLayerIds([...rowsById.value.keys()], mapOrder.value))
const hidden = computed(() => new Set(mapHidden.value))
const rows = computed(() => ids.value.map((id) => ({ ...rowsById.value.get(id), shown: !hidden.value.has(id) })))

// The row whose settings the strip shows: the one clicked, else the top one.
const chosenId = ref(null)
const selected = computed(() => rows.value.find((r) => r.id === chosenId.value) ?? rows.value[0] ?? null)

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
    :title="t('mapLayers.title')"
    :width="268"
    :close-title="t('mapLayers.close')"
    @close="emit('close')"
  >
    <p v-if="!rows.length" class="layer-note">{{ t('mapLayers.empty') }}</p>
    <ul v-else class="item-list" :aria-label="t('mapLayers.list')">
      <li
        v-for="(row, i) in rows"
        :key="row.id"
        class="list-item layer-row"
        :class="{
          'selected': selected?.id === row.id,
          'dragging': dragId === row.id,
          'over': overId === row.id && dragId !== row.id,
          'layer-hidden': !row.shown,
        }"
        :title="row.blocked || t('mapLayers.row', { kind: row.kind })"
        @click="chosenId = row.id"
        @dragover="(e) => onDragOver(e, row.id)"
        @drop.prevent="onDrop(row.id)"
      >
        <span
          class="drag-handle"
          draggable="true"
          :title="t('mapLayers.drag')"
          aria-hidden="true"
          @dragstart="(e) => onDragStart(e, row.id)"
          @dragend="onDragEnd"
          >⠿</span
        >
        <input
          class="map-visibility"
          type="checkbox"
          :checked="row.shown"
          :aria-label="t('mapLayers.show.label', { name: row.name })"
          :title="t('mapLayers.show.title')"
          @click.stop
          @change="recon.setMapLayerHidden(row.id, !$event.target.checked)"
        />
        <span class="layer-icon" aria-hidden="true"><Icon :name="row.icon" /></span>
        <span class="item-name">{{ row.name }}</span>
        <span class="move-btns">
          <button
            class="move-btn"
            :disabled="i === 0"
            :aria-label="t('mapLayers.up.label', { name: row.name })"
            :title="t('mapLayers.up.title')"
            @click.stop="moveTo(row.id, i - 1)"
          >
            ▲
          </button>
          <button
            class="move-btn"
            :disabled="i === rows.length - 1"
            :aria-label="t('mapLayers.down.label', { name: row.name })"
            :title="t('mapLayers.down.title')"
            @click.stop="moveTo(row.id, i + 1)"
          >
            ▼
          </button>
        </span>
        <button
          class="remove-btn"
          :aria-label="t('mapLayers.remove.label', { name: row.name })"
          :title="t('mapLayers.remove.title')"
          @click.stop="row.remove()"
        >
          ✕
        </button>
      </li>
    </ul>

    <!-- The selected layer's settings: one strip, so the rows stay one line each. -->
    <div
      v-if="selected"
      class="layer-settings"
      :aria-label="t('mapLayers.settingsOf', { name: selected.name })"
      role="group"
    >
      <div class="settings-title">
        <span class="item-name">{{ selected.name }}</span>
        <span class="settings-kind">{{ selected.kind }}</span>
      </div>
      <div class="settings-row">
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          class="opacity-slider"
          :value="selected.opacity"
          :aria-label="t('mapLayers.opacity.label', { name: selected.name })"
          :title="t('mapLayers.opacity.title')"
          @input="selected.fade(Number($event.target.value))"
        />
        <span class="opacity-pct">{{ t('mapLayers.opacity.value', { v: selected.opacity }) }}</span>
        <button
          class="link-btn"
          :disabled="!selected.shown"
          :title="t(selected.shown ? 'mapLayers.zoomTo.title' : 'mapLayers.zoomTo.hidden')"
          @click="emit('zoom-to', selected.id)"
        >
          {{ t('mapLayers.zoomTo.label') }}
        </button>
      </div>
      <div v-if="selected.mode" class="settings-row">
        <label for="map-layers-photos" class="setting-label">{{ t('mapLayers.photosShow.label') }}</label>
        <select
          id="map-layers-photos"
          class="setting-select"
          :value="selected.mode"
          @change="recon.setImageLayer({ mode: $event.target.value })"
        >
          <option value="all">{{ t('mapLayers.photosShow.all') }}</option>
          <option value="selected">{{ t('mapLayers.photosShow.selected') }}</option>
        </select>
      </div>
      <p v-if="selected.mode === 'selected' && !selectedImageId" class="settings-hint">
        {{ t('mapLayers.photosShow.hint') }}
      </p>
    </div>

    <p class="layer-note">{{ t('mapLayers.above') }}</p>
  </FloatingToolbox>
</template>

<style scoped src="../../layout/sidebar/sidebar-sections.css"></style>
<style scoped>
.layer-row {
  gap: 4px;
  cursor: pointer;
}
.layer-row.selected {
  background: var(--hover-bg);
}
.layer-row.dragging {
  opacity: 0.45;
}
.layer-row.over {
  box-shadow: inset 0 2px 0 var(--accent);
}
.layer-row.layer-hidden .item-name,
.layer-row.layer-hidden .layer-icon {
  opacity: 0.45;
}
.layer-row .item-name {
  min-width: 0;
}
.drag-handle {
  flex-shrink: 0;
  cursor: grab;
  color: var(--text-dim);
  padding: 0 2px;
  user-select: none;
}
.layer-icon {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  color: var(--text-dim);
}
.move-btns {
  display: inline-flex;
  flex-direction: column;
  flex-shrink: 0;
}
.move-btn,
.remove-btn {
  padding: 0 4px;
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
}
.move-btn {
  font-size: 9px;
  line-height: 10px;
}
.remove-btn {
  flex-shrink: 0;
  font-size: 11px;
}
.move-btn:hover:not(:disabled) {
  color: var(--accent);
}
.remove-btn:hover {
  color: var(--danger, #d9534f);
}
.move-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.layer-settings {
  padding: 6px 8px;
  border-top: 1px solid var(--panel-border);
  font-size: 12px;
}
.settings-row .opacity-pct,
.settings-row .link-btn {
  flex-shrink: 0;
  font-size: 11px;
}
.settings-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
}
.settings-kind {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-dim);
}
.settings-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.settings-row .opacity-slider {
  flex: 1;
}
.settings-row .link-btn:disabled {
  color: var(--text-dim);
  cursor: default;
  text-decoration: none;
}
.settings-hint {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--text-dim);
}
.setting-label {
  color: var(--text-dim);
}
.setting-select {
  flex: 1;
  min-width: 0;
  font: inherit;
}
.layer-note {
  padding: 4px 8px 6px;
  font-size: 11px;
  color: var(--text-dim);
  margin: 0;
}
</style>
