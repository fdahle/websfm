<script setup>
import { ref, watch, useSlots } from 'vue'
import { useVirtualList } from '../../../composables/useVirtualList.js'
import { useTableSort } from '../../../composables/useTableSort.js'

// Shared sortable table for the Evaluate views (step 0 of PLAN-eval-views). A row
// of headline StatTiles over one of these is the shape six of the eight views take.
//
// Columns: [{ key, label, align?, format?: (v, row) => string, sortable?: bool }].
// Rows: object[] — each needs a stable `id`. Cell text is `format(row[key], row)`
// (default: the raw value, '—' when null). Opt into a custom cell with a
// `cell-<key>` slot, or a per-row detail panel with the `expanded` slot.
//
// Sort: header click toggles asc/desc on a sortable column. `null`/'' values sort
// LAST in both directions — an untriangulable GCP or unregistered image must never
// masquerade as the best (or worst) row. Default sort is worst-first (desc), the
// useful landing state for an error table.
const props = defineProps({
  columns: { type: Array, required: true },
  rows: { type: Array, default: () => [] },
  sortKey: { type: String, default: null },
  sortDir: { type: String, default: 'desc' }, // 'asc' | 'desc'
  emptyText: { type: String, default: 'Nothing to show.' },
})
const emit = defineEmits(['row-click', 'sort'])
const slots = useSlots()

const asDir = (d) => (d === 'asc' ? 1 : -1)
// Sorting is composables/useTableSort; a newly clicked column starts descending.
const {
  sortKey,
  sortDir,
  toggleSort,
  sortArrow,
  sorted: sortedRows,
} = useTableSort(
  () => props.rows,
  (row, k) => row[k],
  { initialKey: props.sortKey, initialDir: asDir(props.sortDir), firstDir: -1 },
)
// Follow a caller that changes the default sort (e.g. after switching data source).
watch(
  () => props.sortKey,
  (k) => {
    sortKey.value = k
  },
)
watch(
  () => props.sortDir,
  (d) => {
    sortDir.value = asDir(d)
  },
)

function toggle(col) {
  if (col.sortable === false) return
  toggleSort(col.key)
  emit('sort', sortKey.value, sortDir.value === 1 ? 'asc' : 'desc')
}
function arrow(col) {
  return sortArrow(col.key)
}

// Long tables (a Quality Report over thousands of images) render only the rows in
// view (composables/useVirtualList, measured row height). A table with an
// `expanded` slot keeps rendering every row: its detail rows have content-defined
// heights, and those tables (GCPs, fiducial drafts) are short.
const {
  listRef: bodyRef,
  visibleItems: visibleRows,
  padTop,
  padBottom,
} = useVirtualList({
  items: () => sortedRows.value,
  itemHeight: 31,
  measure: true,
  threshold: slots.expanded ? Infinity : 150,
})

const expanded = ref(new Set())
function toggleExpand(row) {
  const s = new Set(expanded.value)
  if (s.has(row.id)) s.delete(row.id)
  else s.add(row.id)
  expanded.value = s
}

function fmt(col, row) {
  const v = row[col.key]
  if (col.format) return col.format(v, row)
  return v == null || v === '' ? '—' : v
}
</script>

<template>
  <div class="dt-wrap">
    <table v-if="sortedRows.length" class="dt">
      <thead>
        <tr>
          <th
            v-for="col in columns"
            :key="col.key"
            :class="[col.align ? `align-${col.align}` : '', { sortable: col.sortable !== false }]"
            @click="toggle(col)"
          >
            {{ col.label }}<span v-if="col.sortable !== false" class="dt-arrow">{{ arrow(col) }}</span>
          </th>
        </tr>
      </thead>
      <tbody ref="bodyRef">
        <tr v-if="padTop" class="dt-spacer" aria-hidden="true" :style="{ height: padTop + 'px' }">
          <td :colspan="columns.length"></td>
        </tr>
        <template v-for="row in visibleRows" :key="row.id">
          <tr
            data-vrow
            class="dt-row"
            :class="{ expandable: !!slots.expanded }"
            @click="slots.expanded ? toggleExpand(row) : emit('row-click', row)"
          >
            <td v-for="col in columns" :key="col.key" :class="col.align ? `align-${col.align}` : ''">
              <slot :name="`cell-${col.key}`" :row="row" :value="row[col.key]">
                {{ fmt(col, row) }}
              </slot>
            </td>
          </tr>
          <tr v-if="slots.expanded && expanded.has(row.id)" class="dt-detail">
            <td :colspan="columns.length">
              <slot name="expanded" :row="row" />
            </td>
          </tr>
        </template>
        <tr v-if="padBottom" class="dt-spacer" aria-hidden="true" :style="{ height: padBottom + 'px' }">
          <td :colspan="columns.length"></td>
        </tr>
      </tbody>
    </table>
    <div v-else class="dt-empty">{{ emptyText }}</div>
  </div>
</template>

<style scoped src="./modal.css"></style>
<style scoped>
/* Virtual-list spacers stand in for off-screen rows; they carry no cell chrome. */
.dt tbody tr.dt-spacer > td {
  padding: 0;
  border: 0;
}
</style>
