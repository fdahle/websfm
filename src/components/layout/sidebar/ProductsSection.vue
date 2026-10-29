<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useFootprintsStore } from '../../../stores/useFootprintsStore.js'
import { vectorSection } from '../../../core/products/vectorLayers.js'
import CloudRows from './CloudRows.vue'
import VectorRows from './VectorRows.vue'
import { useContextMenu } from '../../../composables/useContextMenu.js'
import { useExpandedSet } from '../../../composables/useExpandedSet.js'
import { useInlineRename } from '../../../composables/useInlineRename.js'
import { productMapBlocker } from '../../../core/products/productLayers.js'
import ContextMenu from './ContextMenu.vue'
import { useSidebar } from './sidebarContext.js'

// Deliverables the app produced: computed dense/mesh clouds, the DEM/ortho rasters
// and the contour lines traced from the DEM. Split from Reference Data by *provenance*, not data type — everything
// here is re-derivable from the model. A rebuild adds a new product (or replaces the
// main one, when its dialog says so). Each one opens in its own tab, goes on the map,
// is styled and downloaded; the main one of each kind is what the next step uses.
const props = defineProps({
  open: { type: Boolean, default: true },
  // Computed (non-imported) kind:'dense' | 'mesh' clouds.
  clouds: { type: Array, default: () => [] },
})
const emit = defineEmits(['toggle'])
const sidebar = useSidebar()
// productLayers: map-layer state per raster product ({ dem: { visible, opacity }, … })
// — the same controls Reference Data has for its rasters.
const recon = useReconstructionStore()
const { rasterProducts, productLayers } = storeToRefs(recon)
const { sets: vectorSets } = storeToRefs(useFootprintsStore())
const contourSets = computed(() => vectorSets.value.filter((s) => vectorSection(s) === 'products'))

// One row per built raster, DEMs first; opening (double-click) shows it in a tab of
// its own, like an image.
const productRows = computed(() => {
  const rows = []
  for (const kind of ['dem', 'ortho']) {
    const ofKind = rasterProducts.value.filter((p) => p.kind === kind)
    for (const product of ofKind) {
      const main = recon.isMainProduct(product)
      const layer = productLayers.value[product.id]
      const status = recon.productStatus(product)
      rows.push({
        id: product.id,
        kind,
        name: product.name || (kind === 'ortho' ? 'Orthophoto' : 'DEM'),
        product,
        main,
        // The badge only tells products apart: one DEM needs no "main".
        showMain: main && ofKind.length > 1,
        outdated: status.outdated ? status.reason : null,
        visible: !!layer?.visible,
        opacity: layer?.opacity ?? 1,
        mapBlocked: productMapBlocker(product),
      })
    }
  }
  return rows
})

const isEmpty = computed(() => !productRows.value.length && !props.clouds.length && !contourSets.value.length)
const badgeCount = computed(() => productRows.value.length + props.clouds.length + contourSets.value.length)

const { isExpanded: isProductExpanded, toggle: toggleProductExpand } = useExpandedSet()

// Tab id per useTabs.openProductTab. Opening focuses an existing tab either way;
// only the wording changes.
const openLabel = (id) => (sidebar.openTabIds.has(`product:${id}`) ? 'Switch to tab' : 'Open in tab')

const productUnit = (p) => (p?.unit && p.unit !== 'model' ? p.unit : 'model units')
const productCrs = (p) => (p?.crs === 'local' || !p?.crs ? 'Local' : p.crs)

const {
  editingId: editingKind,
  editingName,
  setInput: setRenameInput,
  start: startRename,
  commit: commitRename,
  cancel: cancelRename,
} = useInlineRename((id, name) => sidebar.renameProduct({ id, name }))

const { menu: productCtx, open: openProductCtx, close: closeProductCtx } = useContextMenu()
// Run a menu item against the row it was opened on, then close.
function fromMenu(fn) {
  const row = productCtx.value.row
  closeProductCtx()
  fn(row)
}
// A greyed entry keeps its place and names why (.ctx-disabled swallows pointer
// events, so a title tooltip would never show).
// The product's frame never blocks the toggle: the map explains when its current
// frame cannot place a product (useMapProducts notes).
function mapCtxLabel(row) {
  if (row.visible) return 'Remove from Layers'
  return row.mapBlocked ? 'Add to Layers (rebuild first)' : 'Add to Layers'
}
function toggleMap(row) {
  if (row.visible || !row.mapBlocked) sidebar.setProductVisible({ id: row.id, visible: !row.visible })
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
      <CloudRows :clouds="clouds" />
      <template v-for="row in productRows" :key="row.id">
        <li
          class="list-item"
          :title="`${row.name} — double-click to open`"
          @dblclick="sidebar.openProduct(row.id)"
          @contextmenu="openProductCtx($event, { row })"
        >
          <button
            class="expand-btn"
            :class="{ open: isProductExpanded(row.id) }"
            @click.stop="toggleProductExpand(row.id)"
            :title="isProductExpanded(row.id) ? 'Collapse' : 'Expand'"
          ></button>
          <input
            class="map-visibility"
            type="checkbox"
            :checked="row.visible"
            :disabled="row.mapBlocked && !row.visible"
            :aria-label="`Add ${row.name} to the map's layers`"
            :title="
              row.mapBlocked && !row.visible
                ? 'Rebuild it first to show it on the map'
                : 'On the 2D map, listed in View ▸ Map ▸ Layers'
            "
            @click.stop
            @change="sidebar.setProductVisible({ id: row.id, visible: $event.target.checked })"
          />
          <input
            v-if="editingKind === row.id"
            :ref="setRenameInput"
            v-model="editingName"
            class="rename-input"
            @click.stop
            @dblclick.stop
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent.stop="cancelRename"
            @blur="commitRename"
          />
          <span v-else class="item-name">{{ row.name }}</span>
          <span v-if="row.showMain" class="main-badge" title="Main — the next step uses this one">main</span>
          <span v-if="row.outdated" class="outdated-badge" :title="`Outdated: ${row.outdated}`">outdated</span>
          <span class="obs-badge product-size" :title="`${row.product.width}×${row.product.height} px`">
            {{ row.product.width }}×{{ row.product.height }}
          </span>
        </li>
        <li v-if="isProductExpanded(row.id)" class="img-details" @contextmenu.stop>
          <div class="detail-row">
            <span class="detail-label">Frame</span>
            <span class="detail-value">{{ productCrs(row.product) }}</span>
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
              <span class="detail-value"
                >{{ row.product.zMin?.toPrecision(4) }}–{{ row.product.zMax?.toPrecision(4) }}</span
              >
            </div>
          </template>
          <div v-else-if="row.product.covered != null" class="detail-row">
            <span class="detail-label">Coverage</span>
            <span class="detail-value"
              >{{ Math.round((100 * row.product.covered) / (row.product.width * row.product.height)) }}%</span
            >
          </div>
          <!-- Opacity only matters while the layer is up (same rule as Reference Data). -->
          <div v-if="row.visible" class="detail-row">
            <span class="detail-label">Opacity</span>
            <span class="detail-value opacity-cell">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                :value="row.opacity"
                class="opacity-slider"
                @click.stop
                @input="sidebar.setProductOpacity({ id: row.id, opacity: Number($event.target.value) })"
              />
              <span class="opacity-pct">{{ Math.round(row.opacity * 100) }}%</span>
            </span>
          </div>
          <button class="link-btn products-open" @click.stop="sidebar.openProduct(row.id)">
            {{ openLabel(row.id) }}
          </button>
        </li>
      </template>
      <VectorRows :sets="contourSets" />
      <li v-if="isEmpty" class="empty">No products — densify, or build a DEM or orthophoto</li>
    </ul>

    <ContextMenu :menu="productCtx">
      <template #default="{ menu }">
        <!-- Groups: go there / display → change it → destructive. Same order as
             the cloud and reference-raster menus. Any product, main or not. -->
        <button class="ctx-item" @click="fromMenu((r) => sidebar.openProduct(r.id))">
          {{ openLabel(menu.row.id) }}
        </button>
        <!-- Greyed with the reason (not hidden) when the product has no map position. -->
        <button
          class="ctx-item"
          :class="{ 'ctx-disabled': !menu.row.visible && !!menu.row.mapBlocked }"
          :disabled="!menu.row.visible && !!menu.row.mapBlocked"
          @click="fromMenu(toggleMap)"
        >
          {{ mapCtxLabel(menu.row) }}
        </button>
        <button class="ctx-item" @click="fromMenu((r) => sidebar.showProductInfo({ productId: r.id }))">
          Show information
        </button>
        <button class="ctx-item" @click="fromMenu((r) => sidebar.productSymbology(r.id))">Symbology…</button>
        <button class="ctx-item" @click="fromMenu((r) => sidebar.downloadProduct(r.id))">Download…</button>
        <div class="ctx-sep"></div>
        <button v-if="!menu.row.main" class="ctx-item" @click="fromMenu((r) => sidebar.setMainProduct(r.id))">
          Set as main
        </button>
        <button class="ctx-item" @click="fromMenu((r) => startRename(r.id, r.name))">Rename</button>
        <div class="ctx-sep"></div>
        <button class="ctx-item danger" @click="fromMenu((r) => sidebar.removeProduct(r.id))">Remove</button>
      </template>
    </ContextMenu>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
