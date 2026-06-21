<script setup>
import { ref, computed } from 'vue'
import MatchViewer from '../MatchViewer.vue'

const props = defineProps({
  matchSummaries: { type: Array,  default: () => [] },
  images:         { type: Array,  default: () => [] },
  matchStore:     { type: Map,    default: () => new Map() },
})

const emit = defineEmits(['close'])

function trimExt(name) {
  return name.replace(/\.[^.]+$/, '')
}

const selectedPairId = ref(null)

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
          <table v-else class="match-table">
            <thead>
              <tr>
                <th>Image A</th>
                <th>Image B</th>
                <th class="num-col">Inliers</th>
                <th class="num-col">Raw</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="m in matchSummaries"
                :key="m.pairId"
                class="match-row"
                :class="{ active: m.pairId === selectedPairId }"
                @click="selectMatch(m.pairId)"
              >
                <td class="name-cell">{{ trimExt(m.nameA) }}</td>
                <td class="name-cell">{{ trimExt(m.nameB) }}</td>
                <td class="num-col">{{ m.inlierCount }}</td>
                <td class="num-col dim">{{ m.rawCount }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Right: match viewer preview -->
        <div class="preview-panel">
          <MatchViewer
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
  top: 0;
  background: var(--panel);
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
