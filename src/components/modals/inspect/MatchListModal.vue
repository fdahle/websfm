<script setup>
import { ref, shallowRef, computed, watch, onBeforeUnmount } from 'vue'
import ViewerMatch from '../../viewers/ViewerMatch.vue'
import MatchGraph from '../../viewers/MatchGraph.vue'
import ModalShell from '../ui/ModalShell.vue'
import { useVirtualList } from '../../../composables/useVirtualList.js'
import { useTableSort, compareRaw } from '../../../composables/useTableSort.js'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { useMatchesStore } from '../../../stores/useMatchesStore.js'
import { useLog } from '../../../composables/useLog.js'

const props = defineProps({
  matchSummaries: { type: Array, default: () => [] },
  images: { type: Array, default: () => [] },
  matchStore: { type: Map, default: () => new Map() },
  // True once a sparse cloud exists — enables the "Used" column (matches that
  // became tie-points) and dims pairs that contributed nothing to the model.
  hasSparse: { type: Boolean, default: false },
  // UUIDs registered in the sparse model — for colouring nodes in the graph view.
  alignedUuids: { type: Object, default: () => new Set() },
  // pairId → Set("kpA:kpB") of correspondences that became surviving tie-points,
  // built on demand for the selected pair only (core/eval/usedMatches.js). Feeds
  // the preview's aligned/unused (green/red) match colouring.
  usedKeysOf: { type: Function, default: () => new Set() },
  // Imported camera positions keyed by uuid ({ x, y } in project CRS) — enables the
  // graph's geographic layout. Empty when no poses have been imported.
  nodePositions: { type: Object, default: () => ({}) },
})

const emit = defineEmits(['close', 'set-pair-enabled'])

// List ⇄ Graph toggle.
const viewMode = ref('list') // 'list' | 'graph'

// Flip a pair's exclusion from reconstruction. Emits the target state (not a toggle
// verb) so the parent action is idempotent.
function togglePair(pairId) {
  const s = props.matchSummaries.find((m) => m.pairId === pairId)
  emit('set-pair-enabled', pairId, s?.enabled === false)
}

function trimExt(name) {
  return name.replace(/\.[^.]+$/, '')
}

const selectedPairId = ref(null)

// ── Filtering + sorting ───────────────────────────────────────────────────────
// Filter by *participating* image, not by column: which of a pair's two images
// lands in A vs B is arbitrary (pairId is the uuid-sorted join), so an A-only
// filter silently hides roughly half the pairs the chosen image appears in.
const filterImage = ref('')

// Distinct image names appearing on *either* side of a pair, for the dropdown.
const imageOptions = computed(() => {
  const names = new Set()
  for (const m of props.matchSummaries) {
    names.add(trimExt(m.nameA))
    names.add(trimExt(m.nameB))
  }
  return [...names].sort((a, b) => a.localeCompare(b))
})

// Trimmed names once per summary list, not per comparison: a sort of 10⁵ pairs runs
// ~2·10⁶ comparisons, and each used to run two regexes.
const trimmedNames = computed(() => {
  const m = new Map()
  for (const s of props.matchSummaries) {
    const a = trimExt(s.nameA),
      b = trimExt(s.nameB)
    m.set(s.pairId, { a, b, aKey: a.toLowerCase(), bKey: b.toLowerCase() })
  }
  return m
})

const filteredSummaries = computed(() => {
  const q = filterImage.value
  if (!q) return props.matchSummaries
  const names = trimmedNames.value
  return props.matchSummaries.filter((m) => {
    const n = names.get(m.pairId)
    return n.a === q || n.b === q
  })
})

// Sorted by Image A on open; 'nameA' | 'nameB' | 'inlierCount' | 'usedCount'. Names
// sort on their lower-cased trimmed key with plain `<` (compareRaw) — no collation,
// which matters at 10⁵ pairs. The name map is read once per sort (in the rows
// getter), not reactively per comparison.
let sortNames = new Map()
function sortValue(m, key) {
  if (key === 'nameA') return sortNames.get(m.pairId).aKey
  if (key === 'nameB') return sortNames.get(m.pairId).bKey
  return m[key]
}
const {
  toggleSort: sortBy,
  sortArrow,
  sorted: displayedSummaries,
} = useTableSort(
  () => {
    sortNames = trimmedNames.value
    return filteredSummaries.value
  },
  sortValue,
  { initialKey: 'nameA', compare: compareRaw },
)

// Only the rows in view are in the DOM (composables/useVirtualList); a project's
// match list runs to tens of thousands of pairs. Row height measured once rendered.
const {
  listRef: matchBodyRef,
  visibleItems: visibleSummaries,
  padTop,
  padBottom,
} = useVirtualList({ items: () => displayedSummaries.value, itemHeight: 32, measure: true })

const selectedSummary = computed(() => props.matchSummaries.find((m) => m.pairId === selectedPairId.value) ?? null)

const selectedEntry = computed(() =>
  selectedPairId.value ? (props.matchStore.get(selectedPairId.value) ?? null) : null,
)

const selectedImgA = computed(() => {
  const s = selectedSummary.value
  return s ? (props.images.find((img) => img.id === s.idA) ?? null) : null
})

const selectedImgB = computed(() => {
  const s = selectedSummary.value
  return s ? (props.images.find((img) => img.id === s.idB) ?? null) : null
})

// The selected pair's matches and both images' keypoints, read on demand (neither is
// resident after a project open — useMatchesStore.ensurePairMatches /
// useImagesStore.ensureKeypoints). A shallowRef: the buffers are never reactive.
const imagesStore = useImagesStore()
const matchesStore = useMatchesStore()
const { log } = useLog()
const preview = shallowRef({ pairId: null, matches: null, kpsA: null, kpsB: null })
let previewRequest = 0
watch(
  [selectedPairId, selectedEntry, selectedImgA, selectedImgB],
  async ([pairId, entry, a, b]) => {
    const req = ++previewRequest
    preview.value = { pairId, matches: null, kpsA: null, kpsB: null }
    if (!pairId || !entry || !a || !b) return
    try {
      const [matches, kpsA, kpsB] = await Promise.all([
        matchesStore.ensurePairMatches(pairId),
        imagesStore.ensureKeypoints(a),
        imagesStore.ensureKeypoints(b),
      ])
      if (req === previewRequest) preview.value = { pairId, matches, kpsA, kpsB }
    } catch (err) {
      // Say why the panel stays empty.
      if (req === previewRequest) log(`Match preview: ${err?.message ?? err}`, 'warn', 'Matching')
    }
  },
  { immediate: true },
)

function selectMatch(pairId) {
  selectedPairId.value = selectedPairId.value === pairId ? null : pairId
}

// Draggable width of the left list panel (px). Clamped so it can't swallow the
// preview or shrink below the table's usable width.
const listWidth = ref(360)
let resizing = null
function startResize(e) {
  resizing = { startX: e.clientX, startW: listWidth.value }
  window.addEventListener('mousemove', onResize)
  window.addEventListener('mouseup', stopResize)
  e.preventDefault()
}
function onResize(e) {
  if (!resizing) return
  const w = resizing.startW + (e.clientX - resizing.startX)
  listWidth.value = Math.max(220, Math.min(700, w))
}
function stopResize() {
  resizing = null
  window.removeEventListener('mousemove', onResize)
  window.removeEventListener('mouseup', stopResize)
}
onBeforeUnmount(stopResize)

// Used-correspondence keys for the selected pair — null until a sparse model
// exists, so the preview draws neutral (undifferentiated) matches pre-alignment.
const selectedUsedKeys = computed(() =>
  props.hasSparse && selectedPairId.value ? props.usedKeysOf(selectedPairId.value) : null,
)
</script>

<template>
  <ModalShell
    title="Matches"
    aria-label="Match List"
    width="min(96vw, 1440px)"
    height="min(88vh, 1000px)"
    flush
    @close="emit('close')"
  >
    <template #header>
      <div class="match-head">
        <span class="match-title">Matches</span>
        <span v-if="matchSummaries.length" class="modal-count"
          >{{ matchSummaries.length }} pair{{ matchSummaries.length !== 1 ? 's' : '' }}</span
        >
        <div class="view-toggle">
          <button class="view-btn" :class="{ active: viewMode === 'list' }" @click="viewMode = 'list'">List</button>
          <button class="view-btn" :class="{ active: viewMode === 'graph' }" @click="viewMode = 'graph'">Graph</button>
        </div>
      </div>
    </template>

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
          @toggle-pair="togglePair"
        />
      </div>
      <div v-else class="list-panel" :style="{ width: listWidth + 'px' }">
        <div v-if="!matchSummaries.length" class="empty">No matches yet — run Match Features first.</div>
        <template v-else>
          <div class="filter-bar">
            <select
              v-model="filterImage"
              class="filter-input"
              title="Show only pairs containing this image (either side)"
            >
              <option value="">All images</option>
              <option v-for="name in imageOptions" :key="name" :value="name">{{ name }}</option>
            </select>
            <button v-if="filterImage" class="filter-clear" title="Clear filter" @click="filterImage = ''">×</button>
          </div>
          <div class="table-scroll">
            <table v-col-resize class="match-table">
              <thead>
                <tr>
                  <th class="sortable" @click="sortBy('nameA')">
                    Image A<span class="arrow">{{ sortArrow('nameA') }}</span>
                  </th>
                  <th class="sortable" @click="sortBy('nameB')">
                    Image B<span class="arrow">{{ sortArrow('nameB') }}</span>
                  </th>
                  <th class="sortable num-col" @click="sortBy('inlierCount')">
                    Matches<span class="arrow">{{ sortArrow('inlierCount') }}</span>
                  </th>
                  <th
                    v-if="hasSparse"
                    class="sortable num-col"
                    @click="sortBy('usedCount')"
                    title="Matches that became tie-points in the sparse model"
                  >
                    Used<span class="arrow">{{ sortArrow('usedCount') }}</span>
                  </th>
                </tr>
              </thead>
              <tbody ref="matchBodyRef">
                <tr v-if="!displayedSummaries.length">
                  <td :colspan="hasSparse ? 4 : 3" class="empty-row">No pairs match “{{ filterImage }}”.</td>
                </tr>
                <tr v-if="padTop" class="v-spacer" aria-hidden="true" :style="{ height: padTop + 'px' }">
                  <td :colspan="hasSparse ? 4 : 3"></td>
                </tr>
                <tr
                  v-for="m in visibleSummaries"
                  :key="m.pairId"
                  data-vrow
                  class="match-row"
                  :class="{
                    active: m.pairId === selectedPairId,
                    unused: hasSparse && !m.usedCount,
                    excluded: !m.enabled,
                  }"
                  :title="m.enabled ? '' : 'Excluded from reconstruction'"
                  @click="selectMatch(m.pairId)"
                >
                  <td class="name-cell">
                    <span v-if="!m.enabled" class="excluded-tag" title="Excluded from reconstruction">⦸</span>
                    {{ trimExt(m.nameA) }}
                  </td>
                  <td class="name-cell">{{ trimExt(m.nameB) }}</td>
                  <td class="num-col">{{ m.inlierCount }}</td>
                  <td v-if="hasSparse" class="num-col" :class="{ dim: !m.usedCount }">{{ m.usedCount }}</td>
                </tr>
                <tr v-if="padBottom" class="v-spacer" aria-hidden="true" :style="{ height: padBottom + 'px' }">
                  <td :colspan="hasSparse ? 4 : 3"></td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>

      <!-- Drag handle to resize the list panel (list view only). -->
      <div v-if="viewMode === 'list'" class="resizer" title="Drag to resize" @mousedown="startResize" />

      <!-- Right: match viewer preview -->
      <div class="preview-panel">
        <div v-if="selectedSummary" class="preview-bar">
          <span class="preview-name">{{ trimExt(selectedSummary.nameA) }} ↔ {{ trimExt(selectedSummary.nameB) }}</span>
          <button
            class="exclude-btn"
            :class="{ on: !selectedSummary.enabled }"
            :title="
              !selectedSummary.enabled
                ? 'Include this pair in reconstruction'
                : 'Exclude this pair from reconstruction (obviously-wrong match)'
            "
            @click="togglePair(selectedSummary.pairId)"
          >
            {{ !selectedSummary.enabled ? 'Excluded — click to restore' : 'Exclude from reconstruction' }}
          </button>
        </div>
        <div class="preview-body">
          <ViewerMatch
            v-if="selectedImgA && selectedImgB"
            :image-a="selectedImgA"
            :image-b="selectedImgB"
            :matches="preview.matches ?? []"
            :keypoints-a="preview.kpsA"
            :keypoints-b="preview.kpsB"
            :used-keys="selectedUsedKeys"
          />
          <div v-else class="preview-placeholder">
            <span>Select a pair to preview matches</span>
          </div>
        </div>
      </div>
    </div>
  </ModalShell>
</template>

<style scoped>
/* Roomy on purpose: the right panel holds two photos side by side, so the
   preview is the constraint — at 1100×75vh each half was barely wider than a
   thumbnail once the list took its 320px (hence the large width/height). */

/* #header replaces the shell's title: title, pair count and the List/Graph toggle,
   spread over the free width with the toggle beside the close button. */
.match-head {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
}

.match-title {
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

.view-btn:hover {
  background: var(--hover-bg);
  color: var(--text);
}
.view-btn.active {
  background: var(--accent);
  color: #fff;
}

/* Two-panel layout */
.modal-main {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

/* Left list. Width is driven inline (draggable); scrolling lives in .table-scroll
   so the filter bar stays put and only the table overflows. */
.list-panel {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--panel-border);
}

/* Only the table scrolls — horizontally (wide/resized columns) and vertically —
   keeping the filter select above it always visible. */
.table-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* Drag handle between the list and the preview. */
.resizer {
  flex-shrink: 0;
  width: 5px;
  cursor: col-resize;
  background: transparent;
}
.resizer:hover {
  background: var(--accent);
}

.empty {
  padding: 24px 16px;
  font-size: 13px;
  color: var(--text-dim);
  font-style: italic;
  text-align: center;
}

.filter-bar {
  flex-shrink: 0;
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
.filter-input:focus {
  border-color: var(--accent);
}

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
.filter-clear:hover {
  background: var(--hover-bg);
  color: var(--text);
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

.match-table th.sortable {
  cursor: pointer;
  user-select: none;
}
.match-table th.sortable:hover {
  color: var(--text);
}
.match-table th.num-col {
  text-align: right;
}
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
.match-row.unused .name-cell {
  color: var(--text-dim);
}

/* A user-excluded pair — greyed with a struck-through name. */
.match-row.excluded td {
  color: var(--text-dim);
}
.match-row.excluded .name-cell {
  text-decoration: line-through;
  opacity: 0.75;
}

.excluded-tag {
  color: #e06060;
  margin-right: 3px;
}

.match-row td {
  padding: 7px 12px;
  border-bottom: 1px solid var(--panel-border);
  color: var(--text);
}

/* Fixed row height for the virtual list (measured once rendered). Names never
   wrap (.name-cell nowrap), so every row is one line tall. */
.match-row {
  height: 32px;
}
.v-spacer > td {
  padding: 0;
  border: 0;
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

.dim {
  color: var(--text-dim);
}

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

.exclude-btn:hover {
  background: var(--hover-bg);
  color: var(--text);
}
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
