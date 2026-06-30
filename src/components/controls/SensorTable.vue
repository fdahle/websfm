<script setup>
import { ref, computed } from 'vue'
import { estimatedIntrinsics } from '../../utils/cameraEstimated.js'

// Editable table of sensors (shared intrinsics). In 'initial' mode the numeric
// cells are editable inputs (the source of truth); in 'estimated' mode they show
// bundle-adjusted values aggregated from the reconstruction (read-only).
const props = defineProps({
  sensors: { type: Array,  required: true },
  images:  { type: Array,  default: () => [] },
  cameras: { type: Map,    default: () => new Map() }, // uuid → { R, t, K }
})

const emit = defineEmits(['update', 'remove', 'toggle-fixed'])

const isFixed = (s, field) => !!s.fixed?.[field]

const mode = ref('initial') // 'initial' | 'estimated' | 'diff'

const round = (n, d = 2) => (n == null ? null : Number(n.toFixed(d)))
const signed = (n, d = 2) => (n == null ? null : (n >= 0 ? '+' : '') + n.toFixed(d))

function imageCount(sensorId) {
  return props.images.filter((i) => i.sensorId === sensorId).length
}

// Mean estimated intrinsics across this sensor's reconstructed images.
function estimated(sensorId) {
  const vals = []
  for (const img of props.images) {
    if (img.sensorId !== sensorId) continue
    const cam = props.cameras.get(img.uuid)
    const est = cam && estimatedIntrinsics(cam)
    if (est) vals.push(est)
  }
  if (!vals.length) return null
  const mean = (k) => {
    const xs = vals.map((v) => v[k]).filter((x) => x != null)
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
  }
  return { focal: mean('focal'), cx: mean('cx'), cy: mean('cy'), n: vals.length }
}

const anyEstimated = computed(() => props.sensors.some((s) => estimated(s.id)))

const hint = computed(() => ({
  initial:   'Calibration priors — editable',
  fixed:     'Tick a parameter to hold it constant during bundle adjustment',
  estimated: 'Bundle-adjusted (read-only), averaged per sensor',
  diff:      'Estimated − initial (Δ)',
}[mode.value]))

// Estimated − initial for an intrinsic, or null if either side is missing.
function diff(sensorId, key) {
  const est = estimated(sensorId)
  if (!est || est[key] == null) return null
  const s = props.sensors.find((x) => x.id === sensorId)
  const init = s?.[key]
  if (init == null || init === '') return null
  return est[key] - Number(init)
}

// Editable numeric columns (label handled separately).
const NUM_COLS = [
  { key: 'width',  label: 'W' },
  { key: 'height', label: 'H' },
  { key: 'focal',  label: 'Focal', lockable: true },
  { key: 'cx',     label: 'cx', lockable: true },
  { key: 'cy',     label: 'cy', lockable: true },
  { key: 'k1',     label: 'k1', lockable: true },
  { key: 'k2',     label: 'k2', lockable: true },
  { key: 'k3',     label: 'k3', lockable: true },
  { key: 'p1',     label: 'p1', lockable: true },
  { key: 'p2',     label: 'p2', lockable: true },
]

function onEdit(id, field, e) {
  emit('update', { id, field, value: e.target.value })
}
</script>

<template>
  <div class="table-wrap">
    <div class="toolbar">
      <div class="seg">
        <button class="seg-btn" :class="{ active: mode === 'initial' }" @click="mode = 'initial'">Initial</button>
        <button
          class="seg-btn"
          :class="{ active: mode === 'estimated' }"
          :disabled="!anyEstimated"
          :title="anyEstimated ? '' : 'Run a reconstruction to get estimated values'"
          @click="mode = 'estimated'"
        >Estimated</button>
        <button
          class="seg-btn"
          :class="{ active: mode === 'diff' }"
          :disabled="!anyEstimated"
          :title="anyEstimated ? '' : 'Run a reconstruction to compare values'"
          @click="mode = 'diff'"
        >Difference</button>
        <button class="seg-btn" :class="{ active: mode === 'fixed' }" @click="mode = 'fixed'">Fixed</button>
      </div>
      <span class="hint">{{ hint }}</span>
    </div>

    <table v-if="sensors.length">
      <thead>
        <tr>
          <th>Label</th>
          <th>Source</th>
          <th v-for="c in NUM_COLS" :key="c.key">{{ c.label }}</th>
          <th>Images</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in sensors" :key="s.id">
          <td class="label-cell">
            <input
              v-if="mode === 'initial'"
              class="cell-input label-input"
              :value="s.label"
              @change="onEdit(s.id, 'label', $event)"
            />
            <span v-else>{{ s.label }}</span>
          </td>
          <td class="dim">{{ s.source === 'exif' ? 'EXIF' : 'imported' }}</td>

          <template v-if="mode === 'initial'">
            <td v-for="c in NUM_COLS" :key="c.key">
              <input
                class="cell-input"
                type="number"
                step="any"
                :value="s[c.key] ?? ''"
                @change="onEdit(s.id, c.key, $event)"
              />
            </td>
          </template>
          <template v-else-if="mode === 'fixed'">
            <td v-for="c in NUM_COLS" :key="c.key" class="check-cell">
              <input
                v-if="c.lockable"
                type="checkbox"
                class="fix-check"
                :checked="isFixed(s, c.key)"
                :title="isFixed(s, c.key) ? 'Held constant by the solver' : 'Free to refine'"
                @change="emit('toggle-fixed', { id: s.id, field: c.key })"
              />
              <span v-else class="dim">—</span>
            </td>
          </template>
          <template v-else-if="mode === 'estimated'">
            <td>{{ s.width ?? '—' }}</td>
            <td>{{ s.height ?? '—' }}</td>
            <td :class="{ dim: !estimated(s.id) }">{{ round(estimated(s.id)?.focal) ?? '—' }}</td>
            <td :class="{ dim: !estimated(s.id) }">{{ round(estimated(s.id)?.cx) ?? '—' }}</td>
            <td :class="{ dim: !estimated(s.id) }">{{ round(estimated(s.id)?.cy) ?? '—' }}</td>
            <td v-for="c in ['k1','k2','k3','p1','p2']" :key="c" class="dim">—</td>
          </template>
          <template v-else>
            <td class="dim">—</td>
            <td class="dim">—</td>
            <td v-for="c in ['focal','cx','cy']" :key="c" :class="{ dim: diff(s.id, c) == null }">
              {{ signed(diff(s.id, c)) ?? '—' }}
            </td>
            <td v-for="c in ['k1','k2','k3','p1','p2']" :key="c" class="dim">—</td>
          </template>

          <td class="count">{{ imageCount(s.id) }}</td>
          <td><button class="remove" title="Remove sensor" @click="emit('remove', s.id)">×</button></td>
        </tr>
      </tbody>
    </table>

    <div v-else class="empty">No sensors yet — add images (auto-detected from EXIF) or import a calibration file.</div>
  </div>
</template>

<style scoped>
.table-wrap { position: absolute; inset: 0; overflow: auto; background: var(--bg); display: flex; flex-direction: column; }

.toolbar {
  position: sticky; top: 0; z-index: 2;
  display: flex; align-items: center; gap: 14px;
  padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--panel-border);
}

.seg { display: inline-flex; border: 1px solid var(--panel-border); border-radius: 5px; overflow: hidden; }
.seg-btn {
  background: var(--bg); border: none; color: var(--text-dim);
  font: inherit; font-size: 12px; padding: 4px 12px; cursor: pointer;
}
.seg-btn + .seg-btn { border-left: 1px solid var(--panel-border); }
.seg-btn.active { background: var(--accent); color: #fff; }
.seg-btn:disabled { opacity: 0.4; cursor: default; }
.hint { font-size: 11px; color: var(--text-dim); }

table { width: 100%; border-collapse: collapse; font-size: 12px; }

thead th {
  position: sticky; top: 41px; z-index: 1;
  background: var(--panel); text-align: left; padding: 8px 10px;
  font-weight: 600; color: var(--text-dim); border-bottom: 1px solid var(--panel-border); white-space: nowrap;
}

tbody td { padding: 4px 10px; border-bottom: 1px solid var(--panel-border); white-space: nowrap; color: var(--text); }
tbody td.dim { color: var(--text-dim); }
.label-cell { min-width: 140px; }
.count { text-align: center; font-variant-numeric: tabular-nums; }

.cell-input {
  width: 64px; background: var(--bg); border: 1px solid var(--panel-border); border-radius: 4px;
  color: var(--text); font: inherit; font-size: 12px; padding: 3px 5px; outline: none;
}
.label-input { width: 130px; }
.cell-input:focus { border-color: var(--accent); }

/* Numeric input without the up/down spinners — stepping makes no sense for
   calibration values, but we keep type=number for numeric keyboards/validation. */
.cell-input[type='number'] { -moz-appearance: textfield; appearance: textfield; }
.cell-input[type='number']::-webkit-outer-spin-button,
.cell-input[type='number']::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

/* Fixed tab — checkbox per refinable intrinsic (held constant by the solver). */
.check-cell { text-align: center; }
.fix-check { width: 14px; height: 14px; accent-color: var(--accent); cursor: pointer; margin: 0; vertical-align: middle; }

.remove {
  background: none; border: none; color: var(--text-dim); cursor: pointer;
  font-size: 16px; line-height: 1; padding: 0 4px; border-radius: 4px;
}
.remove:hover { color: #e55; background: rgba(220, 80, 80, 0.12); }

.empty { padding: 40px; text-align: center; color: var(--text-dim); }
</style>
