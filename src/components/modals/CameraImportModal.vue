<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import CrsPicker from '../controls/CrsPicker.vue'
import { DELIMITER_OPTIONS, sniffDelimiter, parseRows } from '../../core/io/gcp.js'
import { SENSOR_ROLES, SENSOR_ROLE_LABELS, guessMapping as guessSensors, buildSensors } from '../../core/io/sensor.js'
import { POSE_ROLES, POSE_ROLE_LABELS, guessMapping as guessPoses, buildPoses } from '../../core/io/pose.js'

// Imports camera parameters from delimited text in one of two modes:
//   - 'sensor' : shared intrinsics (one row per sensor) — no CRS
//   - 'pose'   : per-image exterior orientation — positions need a source CRS
// `detectedMode` pre-selects the mode the router sniffed; the user can switch.
const props = defineProps({
  rawText:      { type: String, default: '' },
  fileName:     { type: String, default: 'camera file' },
  projectCrs:   { type: String, default: 'EPSG:4326' },
  detectedMode: { type: String, default: 'pose' },
})
const emit = defineEmits(['close', 'import', 'switch-kind'])

// Re-interpret this same file as a different content type (hands off to App,
// which opens the matching importer).
function switchKind(kind) {
  emit('switch-kind', { kind, rawText: props.rawText, fileName: props.fileName })
}

const mode = ref(props.detectedMode === 'sensor' ? 'sensor' : 'pose')
const delimiter = ref(sniffDelimiter(props.rawText))
const hasHeader = ref(true)
const sourceCrs = ref(props.projectCrs)
const columnRoles = ref([])   // index → role id

// ── Parsing ────────────────────────────────────────────────────────────────────

const rows = computed(() => parseRows(props.rawText, delimiter.value))
const columnCount = computed(() => rows.value.reduce((m, r) => Math.max(m, r.length), 0))
const headerCells = computed(() => (hasHeader.value ? (rows.value[0] || []) : []))
const dataRows = computed(() => (hasHeader.value ? rows.value.slice(1) : rows.value))
const previewRows = computed(() => dataRows.value.slice(0, 8))

const ROLES = computed(() => (mode.value === 'sensor' ? SENSOR_ROLES : POSE_ROLES))
const ROLE_LABELS = computed(() => (mode.value === 'sensor' ? SENSOR_ROLE_LABELS : POSE_ROLE_LABELS))

const roleOptions = computed(() => [
  { id: 'ignore', label: 'Ignore' },
  ...ROLES.value.map((id) => ({ id, label: ROLE_LABELS.value[id] })),
])

function reguess() {
  const guess = mode.value === 'sensor' ? guessSensors : guessPoses
  const m = guess(headerCells.value, columnCount.value, hasHeader.value)
  const roles = new Array(columnCount.value).fill('ignore')
  for (const [role, idx] of Object.entries(m)) if (idx != null) roles[idx] = role
  columnRoles.value = roles
}

onMounted(reguess)
watch([delimiter, hasHeader, mode], reguess)

// Each role used at most once.
function setRole(colIdx, role) {
  const roles = [...columnRoles.value]
  if (role !== 'ignore') {
    const prev = roles.indexOf(role)
    if (prev !== -1 && prev !== colIdx) roles[prev] = 'ignore'
  }
  roles[colIdx] = role
  columnRoles.value = roles
}

const mapping = computed(() => {
  const m = Object.fromEntries(ROLES.value.map((r) => [r, null]))
  columnRoles.value.forEach((role, i) => { if (role !== 'ignore' && m[role] == null) m[role] = i })
  return m
})

// ── Result ──────────────────────────────────────────────────────────────────────

const built = computed(() =>
  mode.value === 'sensor' ? buildSensors(dataRows.value, mapping.value) : buildPoses(dataRows.value, mapping.value)
)

const sensorCount = computed(() => (mode.value === 'sensor' ? built.value.sensors.length : 0))
const poseCount   = computed(() => (mode.value === 'pose' ? built.value.poses.length : 0))

const hasImage = computed(() => mapping.value.image != null)
const hasXY = computed(() => mapping.value.x != null && mapping.value.y != null)

const canImport = computed(() =>
  mode.value === 'sensor'
    ? sensorCount.value > 0
    : hasImage.value && hasXY.value && poseCount.value > 0
)

function doImport() {
  if (!canImport.value) return
  if (mode.value === 'sensor') emit('import', { mode: 'sensor', sensors: built.value.sensors })
  else emit('import', { mode: 'pose', poses: built.value.poses, sourceCrs: sourceCrs.value })
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Import camera parameters">
      <div class="modal-header">
        <span class="modal-title">Import Camera Parameters</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="filename">{{ fileName }}</div>

        <label class="section-label kind-label">Import as</label>
        <div class="kind-toggle">
          <button class="kind-btn" @click="switchKind('gcp')">Ground Control Points</button>
          <button class="kind-btn" :class="{ active: mode === 'pose' }" @click="mode = 'pose'">Camera Positions</button>
          <button class="kind-btn" :class="{ active: mode === 'sensor' }" @click="mode = 'sensor'">Camera Intrinsics</button>
        </div>

        <div class="controls">
          <div class="ctrl">
            <label class="ctrl-label">Delimiter</label>
            <select v-model="delimiter" class="ctrl-input">
              <option v-for="d in DELIMITER_OPTIONS" :key="d.id" :value="d.id">{{ d.label }}</option>
            </select>
          </div>
          <label class="ctrl-check">
            <input type="checkbox" v-model="hasHeader" />
            First row is a header
          </label>
          <div v-if="mode === 'pose'" class="ctrl ctrl-crs">
            <label class="ctrl-label">Source CRS of these positions</label>
            <CrsPicker v-model="sourceCrs" />
          </div>
        </div>

        <label class="section-label">Column mapping</label>
        <div class="table-wrap">
          <table class="preview">
            <thead>
              <tr>
                <th v-for="i in columnCount" :key="'r' + i" class="role-cell">
                  <select
                    class="role-select"
                    :value="columnRoles[i - 1] || 'ignore'"
                    @change="setRole(i - 1, $event.target.value)"
                  >
                    <option v-for="o in roleOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
                  </select>
                </th>
              </tr>
              <tr v-if="hasHeader">
                <th v-for="i in columnCount" :key="'h' + i" class="header-cell">{{ headerCells[i - 1] ?? '' }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, ri) in previewRows" :key="ri">
                <td v-for="i in columnCount" :key="i">{{ row[i - 1] ?? '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="summary">
          <template v-if="mode === 'sensor'">
            <span v-if="sensorCount" class="ok">{{ sensorCount }} sensor{{ sensorCount === 1 ? '' : 's' }}<template v-if="built.skipped"> · {{ built.skipped }} row{{ built.skipped === 1 ? '' : 's' }} skipped</template></span>
            <span v-else class="warn">Assign at least one intrinsic column (focal, dimensions…).</span>
          </template>
          <template v-else>
            <span v-if="!hasImage" class="warn">Assign an <b>Image name</b> column.</span>
            <span v-else-if="!hasXY" class="warn">Assign <b>Abs X</b> and <b>Abs Y</b> columns.</span>
            <span v-else class="ok">{{ poseCount }} pose{{ poseCount === 1 ? '' : 's' }}<template v-if="built.skipped"> · {{ built.skipped }} row{{ built.skipped === 1 ? '' : 's' }} skipped</template></span>
          </template>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn-secondary" @click="emit('close')">Cancel</button>
        <button class="btn-primary" :disabled="!canImport" @click="doImport">
          Import {{ mode === 'sensor' ? 'Sensors' : 'Poses' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
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
  width: 760px;
  max-width: 94vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--panel-border);
}

.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }

.modal-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 1px 6px; border-radius: 4px;
}
.modal-close:hover { background: var(--hover-bg); color: var(--text); }

.modal-body { padding: 16px; overflow-y: auto; }

.filename {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 14px;
  font-family: monospace;
}

/* Content-type toggle */
.kind-label { margin-bottom: 8px; }
.kind-toggle {
  display: inline-flex;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 16px;
}

.kind-btn {
  background: var(--bg);
  border: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 13px;
  padding: 7px 16px;
  cursor: pointer;
}
.kind-btn + .kind-btn { border-left: 1px solid var(--panel-border); }
.kind-btn:hover { color: var(--text); }
.kind-btn.active { background: var(--accent); color: #fff; }

.controls {
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: end;
  gap: 16px;
  margin-bottom: 18px;
}

.ctrl { display: flex; flex-direction: column; gap: 6px; }
.ctrl-crs { grid-column: 1 / -1; max-width: 360px; }

.ctrl-label, .section-label {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-dim);
}
.section-label { display: block; margin-bottom: 8px; }

.ctrl-input {
  background: var(--bg); border: 1px solid var(--panel-border); border-radius: 5px;
  color: var(--text); font: inherit; font-size: 13px; padding: 7px 10px; outline: none;
}
.ctrl-input:focus { border-color: var(--accent); }

.ctrl-check {
  display: flex; align-items: center; gap: 7px;
  font-size: 13px; color: var(--text); cursor: pointer; padding-bottom: 7px;
}

.table-wrap {
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  overflow: auto;
  max-height: 260px;
}

.preview {
  border-collapse: collapse;
  font-size: 12px;
  width: 100%;
}

.preview th, .preview td {
  border: 1px solid var(--panel-border);
  padding: 4px 8px;
  text-align: left;
  white-space: nowrap;
}

.role-cell { padding: 4px; background: var(--bg); position: sticky; top: 0; z-index: 1; }

.role-select {
  background: var(--panel); border: 1px solid var(--panel-border); border-radius: 4px;
  color: var(--text); font: inherit; font-size: 11px; padding: 3px 6px; outline: none; width: 100%;
}
.role-select:focus { border-color: var(--accent); }

.header-cell { background: var(--bg); color: var(--text-dim); font-weight: 600; }
.preview td { color: var(--text); font-family: monospace; }

.summary { margin-top: 12px; font-size: 12px; }
.summary .warn { color: #d89a3a; }
.summary .ok { color: var(--text-dim); }

.modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--panel-border);
}

.btn-secondary {
  background: none; border: 1px solid var(--panel-border); border-radius: 5px;
  color: var(--text-dim); font: inherit; font-size: 12px; padding: 6px 14px; cursor: pointer;
}
.btn-secondary:hover { background: var(--hover-bg); color: var(--text); }

.btn-primary {
  background: var(--accent); border: none; border-radius: 5px;
  color: #fff; font: inherit; font-size: 12px; padding: 6px 16px; cursor: pointer;
}
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-primary:disabled { opacity: 0.45; cursor: default; }
</style>
