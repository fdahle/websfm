<script setup>
import { ref, computed } from 'vue'
import MetadataTable from '../controls/MetadataTable.vue'
import { estimatedIntrinsics, estimatedCenter, estimatedAngles } from '../../utils/cameraEstimated.js'

// Per-image inspector with three tabs:
//   - Metadata   : raw EXIF (incl. GPS)            — MetadataTable
//   - Intrinsics : the sensor each image uses; lens values read-only (inherited)
//   - Extrinsics : per-image pose (X/Y/Z + ω/φ/κ)
// Intrinsics/Extrinsics carry an Initial⇄Estimated toggle. Initial = priors
// (sensor calibration / imported pose); Estimated = bundle-adjusted reconstruction.
const props = defineProps({
  images:     { type: Array,  required: true },
  sensors:    { type: Array,  default: () => [] },
  poses:      { type: Array,  default: () => [] },
  cameras:    { type: Map,    default: () => new Map() }, // uuid → { R, t, K }
  crs:        { type: String, default: null },
  selectedId: { type: String, default: null },
})

const emit = defineEmits(['close', 'select', 'open', 'assign-sensor', 'open-sensor-table'])

const tab = ref('metadata')  // 'metadata' | 'intrinsics' | 'extrinsics'
const mode = ref('initial')  // 'initial' | 'estimated'

const round = (n, d = 3) => (n == null ? null : Number(n.toFixed(d)))
const show = (n) => (n == null ? '—' : round(n))

const anyEstimated = computed(() => props.images.some((i) => props.cameras.get(i.uuid)))

function sensorFor(img) {
  return props.sensors.find((s) => s.id === img.sensorId) || null
}
function poseFor(img) {
  return props.poses.find((p) => p.imageId === img.id) || null
}

// ── Intrinsics row (resolved, read-only) ──────────────────────────────────────
function intrinsics(img) {
  if (mode.value === 'estimated') {
    const est = estimatedIntrinsics(props.cameras.get(img.uuid))
    return est ? { focal: est.focal, unit: 'px', cx: est.cx, cy: est.cy, k1: null, estimated: true } : null
  }
  const s = sensorFor(img)
  if (!s) return null
  return { focal: s.focal, unit: s.focalUnit || 'px', cx: s.cx, cy: s.cy, k1: s.k1, estimated: false }
}

// ── Extrinsics row ────────────────────────────────────────────────────────────
function extrinsics(img) {
  if (mode.value === 'estimated') {
    const cam = props.cameras.get(img.uuid)
    if (!cam) return null
    const c = estimatedCenter(cam)
    const a = estimatedAngles(cam)
    return { x: c?.[0], y: c?.[1], z: c?.[2], omega: a?.omega, phi: a?.phi, kappa: a?.kappa, space: 'model' }
  }
  const p = poseFor(img)
  if (!p) return null
  return { x: p.x, y: p.y, z: p.z, omega: p.omega, phi: p.phi, kappa: p.kappa, space: 'crs' }
}

// Status pill shown on the extrinsics tab when there's no value to display.
function poseStatus(img) {
  if (poseFor(img)) return 'imported'
  if (img.meta?.gpsLat != null && img.meta?.gpsLon != null) return 'GPS prior'
  return '—'
}

function onSelect(id)  { emit('select', id) }
function onOpen(id)    { emit('open', id) }
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Image Table">
      <div class="modal-header">
        <div class="tabs">
          <button class="tab" :class="{ active: tab === 'metadata' }" @click="tab = 'metadata'">Metadata</button>
          <button class="tab" :class="{ active: tab === 'intrinsics' }" @click="tab = 'intrinsics'">Intrinsics</button>
          <button class="tab" :class="{ active: tab === 'extrinsics' }" @click="tab = 'extrinsics'">Extrinsics</button>
        </div>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <!-- Initial/Estimated toggle (intrinsics & extrinsics only) -->
      <div v-if="tab !== 'metadata'" class="subbar">
        <div class="seg">
          <button class="seg-btn" :class="{ active: mode === 'initial' }" @click="mode = 'initial'">Initial</button>
          <button
            class="seg-btn"
            :class="{ active: mode === 'estimated' }"
            :disabled="!anyEstimated"
            :title="anyEstimated ? '' : 'Run a reconstruction to get estimated values'"
            @click="mode = 'estimated'"
          >Estimated</button>
        </div>
        <span v-if="tab === 'intrinsics' && mode === 'initial'" class="hint">
          Inherited from each image's sensor (read-only).
          <button class="link" @click="emit('open-sensor-table')">Edit in Sensor Table →</button>
        </span>
        <span v-else-if="tab === 'extrinsics'" class="hint">
          {{ mode === 'estimated' ? 'Bundle-adjusted — model space (not georeferenced)' : (crs ? `Positions in ${crs}` : 'Imported priors') }}
        </span>
        <span v-else class="hint">Bundle-adjusted intrinsics (pixels).</span>
      </div>

      <div class="modal-body">
        <!-- Metadata -->
        <MetadataTable
          v-if="tab === 'metadata'"
          :images="images"
          :selected-id="selectedId"
          @select="onSelect"
          @open="onOpen"
        />

        <!-- Intrinsics -->
        <div v-else-if="tab === 'intrinsics'" class="table-wrap">
          <table v-if="images.length">
            <thead>
              <tr>
                <th>Name</th>
                <th>Sensor</th>
                <th>Focal</th>
                <th>cx</th>
                <th>cy</th>
                <th>k1</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="img in images"
                :key="img.id"
                :class="{ selected: img.id === selectedId }"
                @click="onSelect(img.id)"
                @dblclick="onOpen(img.id)"
              >
                <td class="name-cell" :title="img.name">{{ img.name }}</td>
                <td @click.stop>
                  <select
                    v-if="mode === 'initial' && sensors.length"
                    class="sensor-select"
                    :value="img.sensorId || ''"
                    @change="emit('assign-sensor', { imageId: img.id, sensorId: $event.target.value || null })"
                  >
                    <option value="">—</option>
                    <option v-for="s in sensors" :key="s.id" :value="s.id">{{ s.label }}</option>
                  </select>
                  <span v-else class="dim">{{ sensorFor(img)?.label || '—' }}</span>
                </td>
                <template v-if="intrinsics(img)">
                  <td>{{ show(intrinsics(img).focal) }}<span class="unit"> {{ intrinsics(img).unit }}</span></td>
                  <td>{{ show(intrinsics(img).cx) }}</td>
                  <td>{{ show(intrinsics(img).cy) }}</td>
                  <td :class="{ dim: intrinsics(img).k1 == null }">{{ show(intrinsics(img).k1) }}</td>
                </template>
                <template v-else>
                  <td colspan="4" class="dim">{{ mode === 'estimated' ? 'not reconstructed' : 'no sensor assigned' }}</td>
                </template>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">No images.</div>
        </div>

        <!-- Extrinsics -->
        <div v-else class="table-wrap">
          <table v-if="images.length">
            <thead>
              <tr>
                <th>Name</th>
                <th>X</th>
                <th>Y</th>
                <th>Z</th>
                <th>ω</th>
                <th>φ</th>
                <th>κ</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="img in images"
                :key="img.id"
                :class="{ selected: img.id === selectedId }"
                @click="onSelect(img.id)"
                @dblclick="onOpen(img.id)"
              >
                <td class="name-cell" :title="img.name">{{ img.name }}</td>
                <template v-if="extrinsics(img)">
                  <td>{{ show(extrinsics(img).x) }}</td>
                  <td>{{ show(extrinsics(img).y) }}</td>
                  <td :class="{ dim: extrinsics(img).z == null }">{{ show(extrinsics(img).z) }}</td>
                  <td :class="{ dim: extrinsics(img).omega == null }">{{ show(extrinsics(img).omega) }}</td>
                  <td :class="{ dim: extrinsics(img).phi == null }">{{ show(extrinsics(img).phi) }}</td>
                  <td :class="{ dim: extrinsics(img).kappa == null }">{{ show(extrinsics(img).kappa) }}</td>
                </template>
                <template v-else>
                  <td colspan="6" class="dim">{{ mode === 'estimated' ? 'not reconstructed' : '—' }}</td>
                </template>
                <td class="dim">{{ mode === 'estimated' ? (extrinsics(img) ? 'estimated' : '—') : poseStatus(img) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">No images.</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; z-index: 200;
}

.modal {
  background: var(--panel); border: 1px solid var(--panel-border); border-radius: 8px;
  width: min(92vw, 960px); height: 80vh; max-height: 80vh;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4); display: flex; flex-direction: column;
}

.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 16px; border-bottom: 1px solid var(--panel-border); flex-shrink: 0;
}

.tabs { display: flex; gap: 2px; }
.tab {
  background: none; border: none; color: var(--text-dim);
  font: inherit; font-size: 13px; padding: 7px 14px; cursor: pointer; border-radius: 5px;
}
.tab:hover { background: var(--hover-bg); color: var(--text); }
.tab.active { background: var(--bg); color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }

.modal-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 1px 6px; border-radius: 4px;
}
.modal-close:hover { background: var(--hover-bg); color: var(--text); }

.subbar {
  display: flex; align-items: center; gap: 14px;
  padding: 8px 16px; border-bottom: 1px solid var(--panel-border); flex-shrink: 0;
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
.link { background: none; border: none; color: var(--accent); font: inherit; font-size: 11px; cursor: pointer; padding: 0; }
.link:hover { text-decoration: underline; }

.modal-body { flex: 1; overflow: auto; min-height: 0; position: relative; }

.table-wrap { position: absolute; inset: 0; overflow: auto; background: var(--bg); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead th {
  position: sticky; top: 0; background: var(--panel); text-align: left; padding: 10px 12px;
  font-weight: 600; color: var(--text-dim); border-bottom: 1px solid var(--panel-border); white-space: nowrap;
}
tbody td { padding: 8px 12px; border-bottom: 1px solid var(--panel-border); white-space: nowrap; color: var(--text); font-variant-numeric: tabular-nums; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: rgba(255, 255, 255, 0.04); }
tbody tr.selected { background: rgba(14, 99, 156, 0.25); }
.name-cell { max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.dim { color: var(--text-dim); }
.unit { color: var(--text-dim); font-size: 11px; }

.sensor-select {
  background: var(--bg); border: 1px solid var(--panel-border); border-radius: 4px;
  color: var(--text); font: inherit; font-size: 12px; padding: 3px 6px; outline: none; max-width: 160px;
}
.sensor-select:focus { border-color: var(--accent); }

.empty { padding: 40px; text-align: center; color: var(--text-dim); }
</style>
