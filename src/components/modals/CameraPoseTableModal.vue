<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  poses: { type: Array, required: true },
  crs:   { type: String, default: null },
})

const emit = defineEmits(['close'])
const sort = ref({ key: 'imageName', direction: 1 })

function value(pose, key) {
  if (key === 'match') return pose.imageId ? 1 : 0
  return pose[key]
}

function toggleSort(key) {
  sort.value = sort.value.key === key
    ? { key, direction: -sort.value.direction }
    : { key, direction: 1 }
}

function arrow(key) {
  return sort.value.key === key ? (sort.value.direction > 0 ? '▲' : '▼') : ''
}

const sortedPoses = computed(() => [...props.poses].sort((a, b) => {
  const av = value(a, sort.value.key)
  const bv = value(b, sort.value.key)
  if (av == null && bv == null) return 0
  if (av == null) return 1
  if (bv == null) return -1
  return (typeof av === 'string'
    ? av.localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' })
    : Number(av) - Number(bv)) * sort.value.direction
}))

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
  <div class="overlay" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Camera Poses Table">
      <div class="modal-header">
        <div>
          <div class="modal-title">Camera Poses</div>
          <div class="subtitle">
            {{ poses.length }} pose{{ poses.length === 1 ? '' : 's' }} · {{ matchedCount }} matched to loaded images
            <template v-if="crs"> · positions in {{ crs }}</template>
          </div>
        </div>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>
      <div class="note">
        Unmatched rows are retained and will link automatically when an image with the same filename is added.
      </div>
      <div class="table-wrap">
        <table v-if="poses.length" v-col-resize>
          <thead>
            <tr>
              <th v-for="column in [
                ['imageName', 'Image'], ['match', 'Match'], ['source', 'Source'],
                ['x', 'X'], ['y', 'Y'], ['z', 'Z'],
                ['omega', 'ω'], ['phi', 'φ'], ['kappa', 'κ'],
                ['accuracyX', 'σX'], ['accuracyY', 'σY'], ['accuracyZ', 'σZ'],
                ['accuracyOmega', 'σω'], ['accuracyPhi', 'σφ'], ['accuracyKappa', 'σκ'],
              ]" :key="column[0]" class="sortable" @click="toggleSort(column[0])">
                {{ column[1] }} <span class="arrow">{{ arrow(column[0]) }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="pose in sortedPoses" :key="`${pose.source}:${pose.imageName}`" :class="{ disabled: pose.enabled === false }">
              <td class="name" :title="pose.imageName">{{ pose.imageName }}</td>
              <td><span class="status" :class="pose.imageId ? 'matched' : 'unmatched'">{{ pose.imageId ? 'Matched' : 'Unmatched' }}</span></td>
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
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .55); }
.modal { width: min(96vw, 1400px); height: 80vh; display: flex; flex-direction: column; overflow: hidden; background: var(--panel); border: 1px solid var(--panel-border); border-radius: 8px; box-shadow: 0 8px 32px rgba(0, 0, 0, .4); }
.modal-header { display: flex; align-items: center; justify-content: space-between; flex: 0 0 auto; padding: 12px 16px; border-bottom: 1px solid var(--panel-border); }
.modal-title { color: var(--text); font-size: 14px; font-weight: 600; }
.subtitle, .note { color: var(--text-dim); font-size: 12px; }
.subtitle { margin-top: 3px; }
.note { padding: 8px 16px; border-bottom: 1px solid var(--panel-border); }
.modal-close { padding: 1px 6px; color: var(--text-dim); font-size: 20px; line-height: 1; cursor: pointer; background: none; border: 0; border-radius: 4px; }
.modal-close:hover { color: var(--text); background: var(--hover-bg); }
.table-wrap { flex: 1; min-height: 0; overflow: auto; }
table { min-width: 1280px; width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 7px 9px; text-align: left; white-space: nowrap; border-right: 1px solid var(--panel-border); border-bottom: 1px solid var(--panel-border); }
th { position: sticky; top: 0; z-index: 1; color: var(--text-dim); font-weight: 600; background: var(--panel); }
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: var(--text); }
td { color: var(--text); }
tr:hover td { background: var(--hover-bg); }
tr.disabled { opacity: .55; }
.name { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.arrow { float: right; min-width: 10px; color: var(--accent); }
.status { display: inline-block; padding: 2px 6px; border-radius: 9px; font-size: 11px; }
.matched { color: var(--success, #67c587); background: color-mix(in srgb, var(--success, #67c587) 13%, transparent); }
.unmatched { color: var(--warning, #e1ae5b); background: color-mix(in srgb, var(--warning, #e1ae5b) 13%, transparent); }
.empty { padding: 36px; color: var(--text-dim); text-align: center; }
</style>
