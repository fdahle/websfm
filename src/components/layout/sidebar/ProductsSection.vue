<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  open:  { type: Boolean, default: true },
  dem:   { type: Object, default: null },
  ortho: { type: Object, default: null },
})
const emit = defineEmits(['toggle', 'open-product'])

// One row per built raster; opening (double-click) shows it in a tab like an image.
const productRows = computed(() => {
  const rows = []
  if (props.dem) rows.push({ kind: 'dem', name: 'DEM', product: props.dem })
  if (props.ortho) rows.push({ kind: 'ortho', name: 'Orthophoto', product: props.ortho })
  return rows
})

const productExpanded = ref({})
function toggleProductExpand(kind) {
  if (productExpanded.value[kind]) delete productExpanded.value[kind]
  else productExpanded.value[kind] = true
}

const productUnit = (p) => (p?.unit === 'm' ? 'm' : 'units')
const productCrs = (p) => (p?.crs === 'local' || !p?.crs ? 'Local' : p.crs)
</script>

<template>
  <div class="section">
    <button class="section-hd" @click="emit('toggle')">
      <span class="chevron">{{ open ? '▾' : '▸' }}</span>
      <span class="section-name">Products</span>
      <span v-if="productRows.length" class="badge">{{ productRows.length }}</span>
    </button>
    <ul v-if="open" class="item-list">
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
          <button class="link-btn products-open" @click.stop="emit('open-product', row.kind)">Open in tab</button>
        </li>
      </template>
      <li v-if="!productRows.length" class="empty">No products — build a DEM or orthophoto</li>
    </ul>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
