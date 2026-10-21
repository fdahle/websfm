<script setup>
import { computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import { useTableSort } from '../../../composables/useTableSort.js'

const props = defineProps({
  poses: { type: Array, required: true },
  crs: { type: String, default: null },
})

const emit = defineEmits(['close'])

function value(pose, key) {
  if (key === 'match') return pose.imageId ? 1 : 0
  return pose[key]
}

// Lands sorted by image name, ascending. Text collates numerically and
// case/accent-blind ("IMG_2" before "img_10"); anything else compares as a number.
function compare(a, b) {
  return typeof a === 'string'
    ? a.localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
    : Number(a) - Number(b)
}
const {
  toggleSort,
  sortArrow: arrow,
  sorted: sortedPoses,
} = useTableSort(() => props.poses, value, { initialKey: 'imageName', compare })

const matchedCount = computed(() => props.poses.filter((p) => p.imageId).length)

function show(value) {
  if (!Number.isFinite(value)) return '—'
  return Number(value).toLocaleString(undefined, {
    useGrouping: false,
    maximumSignificantDigits: 12,
  })
}
</script>

<template>
  <ModalShell
    title="Camera Poses"
    aria-label="Camera Poses Table"
    width="min(96vw, 1400px)"
    height="80vh"
    flush
    @close="emit('close')"
  >
    <template #header>
      <div>
        <div class="pose-title">Camera Poses</div>
        <div class="subtitle">
          {{ poses.length }} pose{{ poses.length === 1 ? '' : 's' }} · {{ matchedCount }} matched to loaded images
          <template v-if="crs"> · positions in {{ crs }}</template>
        </div>
      </div>
    </template>
    <div class="note">
      Unmatched rows are retained and will link automatically when an image with the same filename is added.
    </div>
    <div class="table-wrap">
      <table v-if="poses.length" v-col-resize>
        <thead>
          <tr>
            <th
              v-for="column in [
                ['imageName', 'Image'],
                ['match', 'Match'],
                ['source', 'Source'],
                ['x', 'X'],
                ['y', 'Y'],
                ['z', 'Z'],
                ['omega', 'ω'],
                ['phi', 'φ'],
                ['kappa', 'κ'],
                ['accuracyX', 'σX'],
                ['accuracyY', 'σY'],
                ['accuracyZ', 'σZ'],
                ['accuracyOmega', 'σω'],
                ['accuracyPhi', 'σφ'],
                ['accuracyKappa', 'σκ'],
              ]"
              :key="column[0]"
              class="sortable"
              @click="toggleSort(column[0])"
            >
              {{ column[1] }} <span class="arrow">{{ arrow(column[0]) }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="pose in sortedPoses" :key="pose.id" :class="{ disabled: pose.enabled === false }">
            <td class="name" :title="pose.imageName">{{ pose.imageName }}</td>
            <td>
              <span class="status" :class="pose.imageId ? 'matched' : 'unmatched'">{{
                pose.imageId ? 'Matched' : 'Unmatched'
              }}</span>
            </td>
            <td>{{ pose.source === 'exif' ? 'EXIF GPS' : 'Imported' }}</td>
            <td class="num">{{ show(pose.x) }}</td>
            <td class="num">{{ show(pose.y) }}</td>
            <td class="num">{{ show(pose.z) }}</td>
            <td class="num">{{ show(pose.omega) }}</td>
            <td class="num">{{ show(pose.phi) }}</td>
            <td class="num">{{ show(pose.kappa) }}</td>
            <td class="num">{{ show(pose.accuracyX) }}</td>
            <td class="num">{{ show(pose.accuracyY) }}</td>
            <td class="num">{{ show(pose.accuracyZ) }}</td>
            <td class="num">{{ show(pose.accuracyOmega) }}</td>
            <td class="num">{{ show(pose.accuracyPhi) }}</td>
            <td class="num">{{ show(pose.accuracyKappa) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">No camera poses imported.</div>
    </div>
  </ModalShell>
</template>

<style scoped>
.pose-title {
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
}
.subtitle,
.note {
  color: var(--text-dim);
  font-size: 12px;
}
.subtitle {
  margin-top: 3px;
}
.note {
  padding: 8px 16px;
  border-bottom: 1px solid var(--panel-border);
}
.table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
table {
  min-width: 1280px;
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
th,
td {
  padding: 7px 9px;
  text-align: left;
  white-space: nowrap;
  border-right: 1px solid var(--panel-border);
  border-bottom: 1px solid var(--panel-border);
}
th {
  position: sticky;
  top: 0;
  z-index: 1;
  color: var(--text-dim);
  font-weight: 600;
  background: var(--panel);
}
th.sortable {
  cursor: pointer;
  user-select: none;
}
th.sortable:hover {
  color: var(--text);
}
td {
  color: var(--text);
}
tr:hover td {
  background: var(--hover-bg);
}
tr.disabled {
  opacity: 0.55;
}
.name {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.arrow {
  float: right;
  min-width: 10px;
  color: var(--accent);
}
.status {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 9px;
  font-size: 11px;
}
.matched {
  color: var(--success, #67c587);
  background: color-mix(in srgb, var(--success, #67c587) 13%, transparent);
}
.unmatched {
  color: var(--warning, #e1ae5b);
  background: color-mix(in srgb, var(--warning, #e1ae5b) 13%, transparent);
}
.empty {
  padding: 36px;
  color: var(--text-dim);
  text-align: center;
}
</style>
