<script setup>
import { ref, computed, watch, useSlots } from 'vue'

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

const key = ref(props.sortKey)
const dir = ref(props.sortDir)
// Follow a caller that changes the default sort (e.g. after switching data source).
watch(() => props.sortKey, (k) => { key.value = k })
watch(() => props.sortDir, (d) => { dir.value = d })

function toggle(col) {
  if (col.sortable === false) return
  if (key.value === col.key) dir.value = dir.value === 'asc' ? 'desc' : 'asc'
  else { key.value = col.key; dir.value = 'desc' }
  emit('sort', key.value, dir.value)
}
function arrow(col) {
  if (key.value !== col.key) return ''
  return dir.value === 'asc' ? '▲' : '▼'
}

const isEmpty = (v) => v == null || v === ''

const sortedRows = computed(() => {
  const list = props.rows
  const k = key.value
  if (!k) return list
  const sign = dir.value === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    const va = a[k], vb = b[k]
    if (isEmpty(va) && isEmpty(vb)) return 0
    if (isEmpty(va)) return 1   // nulls last, both directions
    if (isEmpty(vb)) return -1
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign
    return String(va).localeCompare(String(vb), undefined, { numeric: true }) * sign
  })
})

const expanded = ref(new Set())
function toggleExpand(row) {
  const s = new Set(expanded.value)
  if (s.has(row.id)) s.delete(row.id); else s.add(row.id)
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
      <tbody>
        <template v-for="row in sortedRows" :key="row.id">
          <tr
            class="dt-row"
            :class="{ expandable: !!slots.expanded }"
            @click="slots.expanded ? toggleExpand(row) : emit('row-click', row)"
          >
            <td
              v-for="col in columns"
              :key="col.key"
              :class="col.align ? `align-${col.align}` : ''"
            >
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
      </tbody>
    </table>
    <div v-else class="dt-empty">{{ emptyText }}</div>
  </div>
</template>

<style scoped src="./modal.css"></style>
