<script setup>
import { ref, computed } from 'vue'
import ViewerMatch from '../viewers/ViewerMatch.vue'
import MatchGraph from '../viewers/MatchGraph.vue'

const props = defineProps({
  matchSummaries: { type: Array,  default: () => [] },
  images:         { type: Array,  default: () => [] },
  matchStore:     { type: Map,    default: () => new Map() },
  // True once a sparse cloud exists — enables the "Used" column (matches that
  // became tie-points) and dims pairs that contributed nothing to the model.
  hasSparse:      { type: Boolean, default: false },
  // UUIDs registered in the sparse model — for colouring nodes in the graph view.
  alignedUuids:   { type: Object, default: () => new Set() },
  // Imported camera positions keyed by uuid ({ x, y } in project CRS) — enables the
  // graph's geographic layout. Empty when no poses have been imported.
  nodePositions:  { type: Object, default: () => ({}) },
})

const emit = defineEmits(['close', 'toggle-disabled'])

// List ⇄ Graph toggle.
const viewMode = ref('list')  // 'list' | 'graph'

// Flip a pair's exclusion from reconstruction. Emits the target state (not a toggle
// verb) so the parent action is idempotent.
function toggleDisabled(pairId) {
  const s = props.matchSummaries.find((m) => m.pairId === pairId)
  emit('toggle-disabled', pairId, !s?.disabled)
}

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
        <div class="view-toggle">
          <button class="view-btn" :class="{ active: viewMode === 'list' }" @click="viewMode = 'list'">List</button>
          <button class="view-btn" :class="{ active: viewMode === 'graph' }" @click="viewMode = 'graph'">Graph</button>
        </div>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-main">
        <!-- Left: match list (or graph) -->
        <div v-if="viewMode === 'graph'" class="graph-panel">
          <MatchGraph
            :match-summaries="matchSummaries"
            :aligned-uuids="alignedUuids"
            :has-sparse="hasSparse"
            :node-positions="nodePositions"
            :selected-pair-id="selectedPairId"
            @select="selectMatch"
            @toggle-disabled="toggleDisabled"
          />
        </div>
        <div v-else class="list-panel">
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
                  :class="{ active: m.pairId === selectedPairId, unused: hasSparse && !m.usedCount, disabled: m.disabled }"
                  :title="m.disabled ? 'Excluded from reconstruction' : ''"
                  @click="selectMatch(m.pairId)"
                >
                  <td class="name-cell">
                    <span v-if="m.disabled" class="excluded-tag" title="Excluded from reconstruction">⦸</span>
                    {{ trimExt(m.nameA) }}
                  </td>
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
          <div v-if="selectedSummary" class="preview-bar">
            <span class="preview-name">{{ trimExt(selectedSummary.nameA) }} ↔ {{ trimExt(selectedSummary.nameB) }}</span>
            <button
              class="exclude-btn"
              :class="{ on: selectedSummary.disabled }"
              :title="selectedSummary.disabled ? 'Include this pair in reconstruction' : 'Exclude this pair from reconstruction (obviously-wrong match)'"
              @click="toggleDisabled(selectedSummary.pairId)"
            >{{ selectedSummary.disabled ? 'Excluded — click to restore' : 'Exclude from reconstruction' }}</button>
          </div>
          <div class="preview-body">
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

/* List / Graph segmented toggle */
.view-toggle {
  display: flex;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  overflow: hidden;
}

.view-btn {
  background: none;
  border: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  padding: 3px 12px;
  cursor: pointer;
}

.view-btn:hover { background: var(--hover-bg); color: var(--text); }
.view-btn.active { background: var(--accent); color: #fff; }

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

/* A user-excluded pair — greyed with a struck-through name. */
.match-row.disabled td { color: var(--text-dim); }
.match-row.disabled .name-cell { text-decoration: line-through; opacity: 0.75; }

.excluded-tag { color: #e06060; margin-right: 3px; }

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

/* Left graph panel (replaces the list when the Graph view is active) — wider than
   the list since a force layout needs room to breathe. */
.graph-panel {
  flex: 1;
  min-width: 0;
  position: relative;
  border-right: 1px solid var(--panel-border);
}

/* Right preview */
.preview-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

/* Selected-pair action bar above the preview */
.preview-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--panel-border);
}

.preview-name {
  flex: 1;
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.exclude-btn {
  flex-shrink: 0;
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  padding: 4px 12px;
  cursor: pointer;
}

.exclude-btn:hover { background: var(--hover-bg); color: var(--text); }
.exclude-btn.on {
  border-color: #e06060;
  color: #e06060;
}

/* Fills the remaining preview height; ViewerMatch positions itself absolute inset:0 */
.preview-body {
  flex: 1;
  position: relative;
  min-height: 0;
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
