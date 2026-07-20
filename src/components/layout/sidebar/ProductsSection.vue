<script setup>
import { computed, ref } from 'vue'
import CloudRows from './CloudRows.vue'

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
})
const emit = defineEmits(['toggle', 'open-product', 'select-cloud', 'remove-cloud', 'rename-cloud', 'zoom-to-cloud'])

// One row per built raster; opening (double-click) shows it in a tab like an image.
const productRows = computed(() => {
  const rows = []
  if (props.dem) rows.push({ kind: 'dem', name: 'DEM', product: props.dem })
  if (props.ortho) rows.push({ kind: 'ortho', name: 'Orthophoto', product: props.ortho })
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

const productUnit = (p) => (p?.unit === 'm' ? 'm' : 'units')
const productCrs = (p) => (p?.crs === 'local' || !p?.crs ? 'Local' : p.crs)
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
        @remove-cloud="emit('remove-cloud', $event)"
        @rename-cloud="emit('rename-cloud', $event)"
        @zoom-to-cloud="emit('zoom-to-cloud', $event)"
      />
      <template v-for="row in productRows" :key="row.kind">
        <li
          class="list-item"
          :title="`${row.name} — double-click to open`"
          @dblclick="emit('open-product', row.kind)"
        >
          <button
            class="expand-btn"
            :class="{ open: productExpanded[row.kind] }"
            @click.stop="toggleProductExpand(row.kind)"
            :title="productExpanded[row.kind] ? 'Collapse' : 'Expand'"
          ></button>
          <span class="item-name">{{ row.name }}</span>
          <span class="obs-badge" :title="`${row.product.width}×${row.product.height} px`">
            {{ row.product.width }}×{{ row.product.height }}
          </span>
        </li>
        <li v-if="productExpanded[row.kind]" class="img-details">
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
          <button class="link-btn products-open" @click.stop="emit('open-product', row.kind)">{{ openLabel(row.kind) }}</button>
        </li>
      </template>
      <li v-if="isEmpty" class="empty">No products — densify, or build a DEM or orthophoto</li>
    </ul>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
