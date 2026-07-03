<script setup>
import { ref, computed } from 'vue'
import ViewerMatch from '../viewers/ViewerMatch.vue'

const props = defineProps({
  matchSummaries: { type: Array,  default: () => [] },
  images:         { type: Array,  default: () => [] },
  matchStore:     { type: Map,    default: () => new Map() },
  // True once a sparse cloud exists — enables the "Used" column (matches that
  // became tie-points) and dims pairs that contributed nothing to the model.
  hasSparse:      { type: Boolean, default: false },
})

const emit = defineEmits(['close'])

function trimExt(name) {
  return name.replace(/\.[^.]+$/, '')
}

const selectedPairId = ref(null)

// ── Filtering + sorting ───────────────────────────────────────────────────────
const filterA = ref('')
const sortKey = ref('nameA')   // 'nameA' | 'nameB' | 'inlierCount' | 'rawCount'
const sortDir = ref('asc')     // 'asc' | 'desc'

function sortBy(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = 'asc'
  }
}

// Distinct Image A names present in the pairs, for the filter dropdown.
const imageAOptions = computed(() => {
  const names = [...new Set(props.matchSummaries.map((m) => trimExt(m.nameA)))]
  return names.sort((a, b) => a.localeCompare(b))
})

const displayedSummaries = computed(() => {
  const q = filterA.value
  let rows = props.matchSummaries
  if (q) rows = rows.filter((m) => trimExt(m.nameA) === q)

  const key = sortKey.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  const isText = key === 'nameA' || key === 'nameB'
  return [...rows].sort((a, b) => {
    const va = isText ? trimExt(a[key]).toLowerCase() : a[key]
    const vb = isText ? trimExt(b[key]).toLowerCase() : b[key]
    if (va < vb) return -1 * dir
    if (va > vb) return 1 * dir
    return 0
  })
})

const selectedSummary = computed(() =>
  props.matchSummaries.find((m) => m.pairId === selectedPairId.value) ?? null
)

const selectedEntry = computed(() =>
  selectedPairId.value ? (props.matchStore.get(selectedPairId.value) ?? null) : null
)

const selectedImgA = computed(() => {
  const s = selectedSummary.value
  return s ? props.images.find((img) => img.id === s.idA) ?? null : null
})

const selectedImgB = computed(() => {
  const s = selectedSummary.value
  return s ? props.images.find((img) => img.id === s.idB) ?? null : null
})

function selectMatch(pairId) {
  selectedPairId.value = selectedPairId.value === pairId ? null : pairId
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Match List">
      <div class="modal-header">
        <span class="modal-title">Matches</span>
        <span v-if="matchSummaries.length" class="modal-count">{{ matchSummaries.length }} pair{{ matchSummaries.length !== 1 ? 's' : '' }}</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-main">
        <!-- Left: match list -->
        <div class="list-panel">
          <div v-if="!matchSummaries.length" class="empty">No matches yet — run Match Features first.</div>
          <template v-else>
            <div class="filter-bar">
              <select v-model="filterA" class="filter-input">
                <option value="">All images</option>
                <option v-for="name in imageAOptions" :key="name" :value="name">{{ name }}</option>
              </select>
              <button v-if="filterA" class="filter-clear" title="Clear filter" @click="filterA = ''">×</button>
            </div>
            <table v-col-resize class="match-table">
              <thead>
                <tr>
                  <th class="sortable" @click="sortBy('nameA')">Image A<span class="arrow">{{ sortKey === 'nameA' ? (sortDir === 'asc' ? '▲' : '▼') : '' }}</span></th>
                  <th class="sortable" @click="sortBy('nameB')">Image B<span class="arrow">{{ sortKey === 'nameB' ? (sortDir === 'asc' ? '▲' : '▼') : '' }}</span></th>
                  <th class="sortable num-col" @click="sortBy('inlierCount')">Matches<span class="arrow">{{ sortKey === 'inlierCount' ? (sortDir === 'asc' ? '▲' : '▼') : '' }}</span></th>
                  <th class="sortable num-col" @click="sortBy('rawCount')">Candidates<span class="arrow">{{ sortKey === 'rawCount' ? (sortDir === 'asc' ? '▲' : '▼') : '' }}</span></th>
                  <th v-if="hasSparse" class="sortable num-col" @click="sortBy('usedCount')" title="Matches that became tie-points in the sparse model">Used<span class="arrow">{{ sortKey === 'usedCount' ? (sortDir === 'asc' ? '▲' : '▼') : '' }}</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="!displayedSummaries.length">
                  <td :colspan="hasSparse ? 5 : 4" class="empty-row">No pairs match “{{ filterA }}”.</td>
                </tr>
                <tr
                  v-for="m in displayedSummaries"
                  :key="m.pairId"
                  class="match-row"
                  :class="{ active: m.pairId === selectedPairId, unused: hasSparse && !m.usedCount }"
                  @click="selectMatch(m.pairId)"
                >
                  <td class="name-cell">{{ trimExt(m.nameA) }}</td>
                  <td class="name-cell">{{ trimExt(m.nameB) }}</td>
                  <td class="num-col">{{ m.inlierCount }}</td>
                  <td class="num-col dim">{{ m.rawCount }}</td>
                  <td v-if="hasSparse" class="num-col" :class="{ dim: !m.usedCount }">{{ m.usedCount }}</td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>

        <!-- Right: match viewer preview -->
        <div class="preview-panel">
          <ViewerMatch
            v-if="selectedImgA && selectedImgB"
            :image-a="selectedImgA"
            :image-b="selectedImgB"
            :matches="selectedEntry?.matches ?? []"
          />
          <div v-else class="preview-placeholder">
            <span>Select a pair to preview matches</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  width: min(95vw, 1100px);
  height: 75vh;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--panel-border);
  flex-shrink: 0;
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  flex: 1;
}

.modal-count {
  font-size: 12px;
  color: var(--text-dim);
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 4px;
}

.modal-close:hover {
  background: var(--hover-bg);
  color: var(--text);
}

/* Two-panel layout */
.modal-main {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

/* Left list */
.list-panel {
  width: 320px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid var(--panel-border);
}

.empty {
  padding: 24px 16px;
  font-size: 13px;
  color: var(--text-dim);
  font-style: italic;
  text-align: center;
}

.filter-bar {
  position: sticky;
  top: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--panel-border);
}

.filter-input {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 4px 7px;
  outline: none;
}
.filter-input:focus { border-color: var(--accent); }

.filter-clear {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
  border-radius: 4px;
}
.filter-clear:hover { background: var(--hover-bg); color: var(--text); }

.match-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.match-table th {
  padding: 8px 12px;
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--panel-border);
  position: sticky;
  top: 37px;
  background: var(--panel);
}

.match-table th.sortable {
  cursor: pointer;
  user-select: none;
}
.match-table th.sortable:hover { color: var(--text); }
.match-table th.num-col { text-align: right; }
.arrow {
  display: inline-block;
  width: 1em;
  font-size: 9px;
  color: var(--accent);
}

.empty-row {
  padding: 16px 12px !important;
  text-align: center;
  color: var(--text-dim);
  font-style: italic;
}

.match-row {
  cursor: pointer;
}

.match-row:hover td {
  background: var(--hover-bg);
}

.match-row.active td {
  background: rgba(14, 99, 156, 0.22);
}

/* A verified pair that contributed no tie-points to the sparse model. */
.match-row.unused .name-cell { color: var(--text-dim); }

.match-row td {
  padding: 7px 12px;
  border-bottom: 1px solid var(--panel-border);
  color: var(--text);
}

.name-cell {
  max-width: 120px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.num-col {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dim { color: var(--text-dim); }

/* Right preview */
.preview-panel {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.preview-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--text-dim);
  font-style: italic;
}
</style>
