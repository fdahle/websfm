<script setup>
import { computed, ref, nextTick } from 'vue'
import CloudRows from './CloudRows.vue'
import { useContextMenu } from '../../../composables/useContextMenu.js'
import { productMapBlocker } from '../../../core/products/productLayers.js'

// Deliverables the app produced: computed dense/mesh clouds plus the DEM/ortho
// rasters. Split from Reference Data by *provenance*, not data type — everything
// here is re-derivable from the model, so a re-fuse/re-mesh/rebuild may replace it.
const props = defineProps({
  open:  { type: Boolean, default: true },
  // Computed (non-imported) kind:'dense' | 'mesh' clouds.
  clouds: { type: Array, default: () => [] },
  selectedCloudId: { type: String, default: null },
  dem:   { type: Object, default: null },
  ortho: { type: Object, default: null },
  openTabIds: { type: Object, default: () => new Set() },
  // Map-layer state per raster product ({ dem: { onMap, opacity }, … }), the
  // store's productLayers — the same controls Reference Data has for its rasters.
  productLayers: { type: Object, default: () => ({}) },
})
const emit = defineEmits([
  'toggle', 'open-product', 'remove-product', 'rename-product', 'set-product-on-map', 'set-product-opacity', 'product-symbology',
  'cloud-symbology', 'cloud-visibility', 'select-cloud', 'remove-cloud', 'rename-cloud', 'zoom-to-cloud', 'download-cloud',
  'download-product',
])

// One row per built raster; opening (double-click) shows it in a tab like an image.
const productRows = computed(() => {
  const rows = []
  for (const [kind, product, fallback] of [['dem', props.dem, 'DEM'], ['ortho', props.ortho, 'Orthophoto']]) {
    if (!product) continue
    const layer = props.productLayers[kind]
    rows.push({ kind, name: product.name || fallback, product, onMap: !!layer?.onMap,
      opacity: layer?.opacity ?? 1, mapBlocked: productMapBlocker(product) })
  }
  return rows
})

const isEmpty = computed(() => !productRows.value.length && !props.clouds.length)
const badgeCount = computed(() => productRows.value.length + props.clouds.length)

const productExpanded = ref({})
function toggleProductExpand(kind) {
  if (productExpanded.value[kind]) delete productExpanded.value[kind]
  else productExpanded.value[kind] = true
}

// Tab id per useTabs.openProductTab. The emit focuses an existing tab either way;
// only the wording changes.
const openLabel = (kind) =>
  (props.openTabIds.has(`product:${kind}`) ? 'Switch to tab' : 'Open in tab')

const productUnit = (p) => (p?.unit && p.unit !== 'model' ? p.unit : 'model units')
const productCrs = (p) => (p?.crs === 'local' || !p?.crs ? 'Local' : p.crs)

const editingKind = ref(null)
const editingName = ref('')
const renameInput = ref(null)
function setRenameInput(el) { if (el) renameInput.value = el }
function startRename(row) {
  editingKind.value = row.kind
  editingName.value = row.name
  nextTick(() => { renameInput.value?.focus(); renameInput.value?.select() })
}
function commitRename() {
  if (editingKind.value == null) return
  emit('rename-product', { kind: editingKind.value, name: editingName.value })
  editingKind.value = null
}
function cancelRename() { editingKind.value = null }

const { menu: productCtx, open: openProductCtx, close: closeProductCtx } = useContextMenu()
function onProductRightClick(e, row) { openProductCtx(e, { row }, { w: 190, h: 204 }) }
const ctxOpenLabel = computed(() => productCtx.value
  ? openLabel(productCtx.value.row.kind)
  : 'Open in tab')
function ctxOpen() {
  emit('open-product', productCtx.value.row.kind)
  closeProductCtx()
}
function ctxRename() { startRename(productCtx.value.row); closeProductCtx() }
function ctxSymbology() { emit('product-symbology', productCtx.value.row.kind); closeProductCtx() }
function ctxDownload() { emit('download-product', productCtx.value.row.kind); closeProductCtx() }
// A greyed entry keeps its place and names why (.ctx-disabled swallows pointer
// events, so a title tooltip would never show).
// The product's frame never blocks the toggle: the map explains when its current
// frame cannot place a product (useMapProducts notes).
function mapCtxLabel(row) {
  if (row.mapBlocked) return 'Display on map (rebuild first)'
  return row.onMap ? 'Hide from map' : 'Display on map'
}
function ctxToggleMap() {
  const row = productCtx.value.row
  if (!row.mapBlocked) emit('set-product-on-map', { kind: row.kind, onMap: !row.onMap })
  closeProductCtx()
}
function ctxRemove() {
  emit('remove-product', productCtx.value.row.kind)
  closeProductCtx()
}
</script>

<template>
  <div class="section">
    <button class="section-hd" @click="emit('toggle')">
      <span class="chevron">{{ open ? '▾' : '▸' }}</span>
      <span class="section-name">Products</span>
      <span v-if="badgeCount" class="badge">{{ badgeCount }}</span>
    </button>
    <ul v-if="open" class="item-list">
      <CloudRows
        :clouds="clouds"
        :selected-cloud-id="selectedCloudId"
        @select-cloud="emit('select-cloud', $event)"
        @cloud-symbology="emit('cloud-symbology', $event)"
        @cloud-visibility="emit('cloud-visibility', $event)"
        @remove-cloud="emit('remove-cloud', $event)"
        @rename-cloud="emit('rename-cloud', $event)"
        @zoom-to-cloud="emit('zoom-to-cloud', $event)"
        @download-cloud="emit('download-cloud', $event)"
      />
      <template v-for="row in productRows" :key="row.kind">
        <li
          class="list-item"
          :title="`${row.name} — double-click to open`"
          @dblclick="emit('open-product', row.kind)"
          @contextmenu="onProductRightClick($event, row)"
        >
          <button
            class="expand-btn"
            :class="{ open: productExpanded[row.kind] }"
            @click.stop="toggleProductExpand(row.kind)"
            :title="productExpanded[row.kind] ? 'Collapse' : 'Expand'"
          ></button>
          <input
            v-if="editingKind === row.kind"
            :ref="setRenameInput"
            v-model="editingName"
            class="rename-input"
            @click.stop
            @dblclick.stop
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename"
          />
          <span v-else class="item-name">{{ row.name }}</span>
          <span v-if="row.onMap" class="map-flag" title="Shown on the map — right-click to hide">◉</span>
          <span class="obs-badge" :title="`${row.product.width}×${row.product.height} px`">
            {{ row.product.width }}×{{ row.product.height }}
          </span>
        </li>
        <li v-if="productExpanded[row.kind]" class="img-details" @contextmenu.stop>
          <div class="detail-row">
            <span class="detail-label">Frame</span>
            <span class="detail-value">{{ productCrs(dem || row.product) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Size</span>
            <span class="detail-value">{{ row.product.width }} × {{ row.product.height }} px</span>
          </div>
          <template v-if="row.kind === 'dem'">
            <div class="detail-row">
              <span class="detail-label">GSD</span>
              <span class="detail-value">{{ row.product.gsd?.toPrecision(3) }} {{ productUnit(row.product) }}/px</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Elevation</span>
              <span class="detail-value">{{ row.product.zMin?.toPrecision(4) }}–{{ row.product.zMax?.toPrecision(4) }}</span>
            </div>
          </template>
          <div v-else-if="row.product.covered != null" class="detail-row">
            <span class="detail-label">Coverage</span>
            <span class="detail-value">{{ Math.round(100 * row.product.covered / (row.product.width * row.product.height)) }}%</span>
          </div>
          <!-- Opacity only matters while the layer is up (same rule as Reference Data). -->
          <div v-if="row.onMap" class="detail-row">
            <span class="detail-label">Opacity</span>
            <span class="detail-value opacity-cell">
              <input
                type="range" min="0" max="1" step="0.05"
                :value="row.opacity"
                class="opacity-slider"
                @click.stop
                @input="emit('set-product-opacity', { kind: row.kind, opacity: Number($event.target.value) })"
              />
              <span class="opacity-pct">{{ Math.round(row.opacity * 100) }}%</span>
            </span>
          </div>
          <button class="link-btn products-open" @click.stop="emit('open-product', row.kind)">{{ openLabel(row.kind) }}</button>
        </li>
      </template>
      <li v-if="isEmpty" class="empty">No products — densify, or build a DEM or orthophoto</li>
    </ul>

    <Teleport to="body">
      <div
        v-if="productCtx"
        class="ctx-menu"
        :style="{ left: productCtx.x + 'px', top: productCtx.y + 'px' }"
        @click.stop
      >
        <!-- Groups: go there / display → change it → destructive. Same order as
             the cloud and reference-raster menus. -->
        <button class="ctx-item" @click="ctxOpen">{{ ctxOpenLabel }}</button>
        <!-- Greyed with the reason (not hidden) when the product has no map position. -->
        <button class="ctx-item" :class="{ 'ctx-disabled': !!productCtx.row.mapBlocked }"
          :disabled="!!productCtx.row.mapBlocked" @click="ctxToggleMap">{{ mapCtxLabel(productCtx.row) }}</button>
        <button class="ctx-item" @click="ctxSymbology">Symbology…</button>
        <button class="ctx-item" @click="ctxDownload">Download…</button>
        <div class="ctx-sep"></div>
        <button class="ctx-item" @click="ctxRename">Rename</button>
        <div class="ctx-sep"></div>
        <button class="ctx-item danger" @click="ctxRemove">Remove</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
