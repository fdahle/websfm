<script setup>
import { ref, computed, watch } from 'vue'
import CrsPicker from '../../controls/CrsPicker.vue'
import ModalShell from '../ui/ModalShell.vue'
import ColumnMappingTable from '../ui/ColumnMappingTable.vue'
import ImportKindSwitch from '../ui/ImportKindSwitch.vue'
import { DELIMITER_OPTIONS } from '../../../core/io/gcp.js'
import {
  SENSOR_ROLES, SENSOR_ROLE_LABELS, guessMapping as guessSensors, buildSensors, guessFocalUnit,
  planSensorImport, sensorImportImageIds,
} from '../../../core/io/sensor.js'
import { POSE_ROLES, POSE_ROLE_LABELS, guessMapping as guessPoses, buildPoses, guessPoseCrs } from '../../../core/io/pose.js'
import { useDelimitedImport } from '../../../composables/useDelimitedImport.js'
import { axisLabels } from '../../../core/crs.js'

// Imports camera parameters from delimited text in one of two modes:
//   - 'sensor' : intrinsics — one row per sensor, or per image with an image
//                column — no CRS. Each imported sensor updates a project sensor or
//                becomes a new one (core/io/sensor.js planSensorImport); the user
//                can change that per sensor before importing.
//   - 'pose'   : per-image exterior orientation — positions need a source CRS
// `detectedMode` pre-selects the mode the router sniffed; the user can switch.
const props = defineProps({
  rawText:      { type: String, default: '' },
  fileName:     { type: String, default: 'camera file' },
  projectCrs:   { type: String, default: 'EPSG:4326' },
  detectedMode: { type: String, default: 'pose' },
  // The user already said what this file is (a Ribbon ▸ Import command, or the
  // kind chooser) — `detectedMode` is their answer, not a sniff. Then asking
  // "Import as" up front re-asks a question they just answered, so the choice
  // shrinks to a one-line correction link. It never disappears: the declaration
  // can still be wrong (wrong button, wrong file), and the modal is the only
  // place that mistake is visible.
  kindDeclared: { type: Boolean, default: false },
  // The project's sensors and images, to decide where imported intrinsics go.
  sensors:      { type: Array, default: () => [] },
  images:       { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'import', 'switch-kind'])

const mode = ref(props.detectedMode === 'sensor' ? 'sensor' : 'pose')
// The positions' CRS: the project CRS unless the mapped columns are lon/lat (then
// WGS 84), until the user picks one.
const sourceCrsChoice = ref(null)
const sourceCrs = computed({
  get: () => sourceCrsChoice.value ?? (mode.value === 'pose' ? guessPoseCrs(headerCells.value, mapping.value) : null) ?? props.projectCrs,
  set: (v) => { sourceCrsChoice.value = v },
})

// Pose ⇄ sensor is a mode switch in here; GCP re-interprets this same file as a
// different content type (hands off to App, which opens the GCP importer).
function pickKind(kind) {
  if (kind === 'gcp') emit('switch-kind', { kind, rawText: props.rawText, fileName: props.fileName })
  else mode.value = kind
}

// ── Column roles + parsing (composables/useDelimitedImport.js) ─────────────────

const ROLES = computed(() => (mode.value === 'sensor' ? SENSOR_ROLES : POSE_ROLES))
const ROLE_LABELS = computed(() => (mode.value === 'sensor' ? SENSOR_ROLE_LABELS : POSE_ROLE_LABELS))

// Pose positions are in the source CRS, so their labels name its axes
// (Abs E/N/H, Abs Lon/Lat/h…) rather than a generic X/Y/Z.
const axes = computed(() => axisLabels(sourceCrs.value))
const roleLabel = (id) => {
  if (mode.value === 'pose') {
    const axis = { x: 0, y: 1, z: 2 }[id]
    if (axis != null) return `Abs ${axes.value[axis]}`
  }
  return ROLE_LABELS.value[id]
}

const roleOptions = computed(() => [
  { id: 'ignore', label: 'Ignore' },
  ...ROLES.value.map((id) => ({ id, label: roleLabel(id) })),
])

// A mode switch swaps the guesser, which re-guesses every column.
const {
  delimiter, hasHeader, columnRoles, columnCount, headerCells, dataRows, previewRows, setRole, mapping,
} = useDelimitedImport({
  rawText: () => props.rawText,
  guessMapping: computed(() => (mode.value === 'sensor' ? guessSensors : guessPoses)),
  roles: ROLES,
})

// ── Result ──────────────────────────────────────────────────────────────────────

// The focal column's unit: guessed from its header / values until the user picks one.
const focalUnitChoice = ref(null)
const focalUnit = computed({
  get: () => focalUnitChoice.value ?? guessFocalUnit(headerCells.value, mapping.value, dataRows.value),
  set: (v) => { focalUnitChoice.value = v },
})

const built = computed(() =>
  mode.value === 'sensor'
    ? buildSensors(dataRows.value, mapping.value, { focalUnit: focalUnit.value })
    : buildPoses(dataRows.value, mapping.value)
)

// ── Where each imported sensor goes ─────────────────────────────────────────────
// The planned target per sensor, then the user's override ('' = new sensor). An
// override is dropped when the set of imported sensors changes (another column
// mapping), since it may then describe a different sensor.
const plan = computed(() => (mode.value === 'sensor' ? planSensorImport(built.value.sensors, props.sensors, props.images) : []))
const targetChoice = ref({})
watch(() => built.value.sensors?.map((s) => `${s.label}|${s.images?.join(',')}`).join('\n'), () => { targetChoice.value = {} })
const sensorById = computed(() => new Map(props.sensors.map((s) => [s.id, s])))
const imageCount = computed(() => {
  const n = new Map()
  for (const img of props.images) if (img.sensorId) n.set(img.sensorId, (n.get(img.sensorId) ?? 0) + 1)
  return n
})
const targetOf = (i) => (i in targetChoice.value ? targetChoice.value[i] || null : plan.value[i]?.target ?? null)
const setTarget = (i, id) => { targetChoice.value = { ...targetChoice.value, [i]: id } }

const outcomes = computed(() => (built.value.sensors ?? []).map((sensor, i) => {
  const target = targetOf(i)
  const imageIds = sensorImportImageIds(plan.value[i], sensor, target, built.value.sensors.length, props.images)
  return { sensor, target, imageIds, unmatched: plan.value[i]?.unmatched ?? [], reason: plan.value[i]?.reason }
}))

// The file's label, else the images it covers, else its place in the file.
function sensorName(s, i) {
  if (s.label) return s.label
  if (s.images?.length) return s.images.length > 1 ? `${s.images[0]} +${s.images.length - 1} more` : s.images[0]
  return outcomes.value.length > 1 ? `Sensor ${i + 1} in file` : 'Sensor in file'
}
const fmt = (v) => (Number.isInteger(v) ? String(v) : String(+v.toFixed(6)))
function describeSensor(s) {
  const parts = []
  if (s.focal != null) parts.push(`f ${fmt(s.focal)} ${s.focalUnit}`)
  if (s.width != null && s.height != null) parts.push(`${s.width}×${s.height} px`)
  if (s.pixelSize != null) parts.push(`pixel ${fmt(s.pixelSize)} mm`)
  if (s.cx != null || s.cy != null || s.ppxMm != null || s.ppyMm != null) parts.push('principal point')
  if (s.distortionModel) parts.push(`lens ${s.distortionModel}`)
  if (['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'p1', 'p2'].some((k) => s[k] != null)) parts.push('distortion')
  if (s.marks) parts.push(`${s.marks.length} fiducial marks`)
  return parts.join(' · ')
}
const REASON = {
  label: 'same label', images: 'the sensor of exactly these images', sole: "the project's only sensor",
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// Sensors every one of whose images this import moves elsewhere: they stay in the
// project (with their values) but are left without images, which the user should know.
const emptied = computed(() => {
  const moving = new Map() // image id → sensor it ends up on
  for (const o of outcomes.value) for (const id of o.imageIds) moving.set(id, o.target ?? 'new')
  const left = new Map()
  for (const img of props.images) {
    if (!img.sensorId) continue
    const stays = !moving.has(img.id) || moving.get(img.id) === img.sensorId
    left.set(img.sensorId, (left.get(img.sensorId) ?? 0) + (stays ? 1 : 0))
  }
  return props.sensors.filter((s) => left.get(s.id) === 0)
})

function describeOutcome(o, i) {
  const moved = o.imageIds.length ? `, ${plural(o.imageIds.length, 'image')} assigned` : ''
  if (!o.target) return `New sensor${moved || ', no images assigned yet'}`
  const t = sensorById.value.get(o.target)
  const auto = o.target === plan.value[i]?.target && REASON[o.reason] ? ` (${REASON[o.reason]})` : ''
  return `Updates ${t?.label ?? 'sensor'}${auto}${moved}`
}

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
  if (mode.value === 'sensor') {
    emit('import', { mode: 'sensor', items: outcomes.value.map((o) => ({ sensor: o.sensor, targetId: o.target, imageIds: o.imageIds })) })
  }
  else emit('import', { mode: 'pose', poses: built.value.poses, sourceCrs: sourceCrs.value })
}
</script>

<template>
  <ModalShell title="Import Camera Parameters" aria-label="Import camera parameters" width="760px" flush @close="emit('close')">
    <div class="import-body">
      <div class="filename">{{ fileName }}</div>

      <ImportKindSwitch :active="mode" :declared="kindDeclared" @pick="pickKind" />

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
        <div v-if="mode === 'sensor' && mapping.focal != null" class="ctrl">
          <label class="ctrl-label" for="focal-unit">Focal length in</label>
          <select id="focal-unit" v-model="focalUnit" class="ctrl-input">
            <option value="mm">mm</option>
            <option value="px">pixels</option>
          </select>
        </div>
        <div v-if="mode === 'pose'" class="ctrl ctrl-crs">
          <label class="ctrl-label">Source CRS of these positions</label>
          <CrsPicker v-model="sourceCrs" />
        </div>
      </div>

      <label class="section-label">Column mapping</label>
      <p v-if="mode === 'pose'" class="kind-note">
        Accuracies are 1σ values. Position accuracies constrain reconstruction;
        orientation accuracies constrain omega, phi and kappa.
      </p>
      <ColumnMappingTable
        :column-count="columnCount" :column-roles="columnRoles" :role-options="roleOptions"
        :has-header="hasHeader" :header-cells="headerCells" :preview-rows="previewRows"
        @set-role="setRole"
      />

      <template v-if="mode === 'sensor' && outcomes.length">
        <label class="section-label targets-label">Where it goes</label>
        <ul class="targets">
          <li v-for="(o, i) in outcomes" :key="i" class="target-row">
            <div class="target-what">
              <strong>{{ sensorName(o.sensor, i) }}</strong>
              <span class="dim">{{ describeSensor(o.sensor) }}</span>
            </div>
            <select class="ctrl-input target-select" :value="o.target ?? ''" :aria-label="`Target for imported sensor ${i + 1}`"
              @change="setTarget(i, $event.target.value)">
              <option value="">New sensor</option>
              <option v-for="s in sensors" :key="s.id" :value="s.id">Update {{ s.label }} ({{ plural(imageCount.get(s.id) ?? 0, 'image') }})</option>
            </select>
            <div class="target-outcome">
              {{ describeOutcome(o, i) }}
              <span v-if="o.unmatched.length" class="warn"> · {{ o.unmatched.length }} image name{{ o.unmatched.length === 1 ? '' : 's' }} not in the project</span>
            </div>
          </li>
        </ul>
        <p v-if="emptied.length" class="kind-note emptied">
          {{ emptied.map((s) => s.label).join(', ') }} will have no images left; remove {{ emptied.length === 1 ? 'it' : 'them' }}
          in the sensor table if no longer needed.
        </p>
      </template>

      <div class="summary">
        <template v-if="mode === 'sensor'">
          <span v-if="sensorCount" class="ok">{{ sensorCount }} sensor{{ sensorCount === 1 ? '' : 's' }}<template v-if="built.skipped"> · {{ built.skipped }} row{{ built.skipped === 1 ? '' : 's' }} skipped</template></span>
          <span v-else class="warn">Assign at least one intrinsic column (focal, dimensions…).</span>
        </template>
        <template v-else>
          <span v-if="!hasImage" class="warn">Assign an <b>Image name</b> column.</span>
          <span v-else-if="!hasXY" class="warn">Assign <b>Abs {{ axes[0] }}</b> and <b>Abs {{ axes[1] }}</b> columns.</span>
          <span v-else class="ok">{{ poseCount }} pose{{ poseCount === 1 ? '' : 's' }}<template v-if="built.skipped"> · {{ built.skipped }} row{{ built.skipped === 1 ? '' : 's' }} skipped</template></span>
        </template>
      </div>
    </div>

    <template #footer>
      <button class="btn-secondary" @click="emit('close')">Cancel</button>
      <button class="btn-primary" :disabled="!canImport" @click="doImport">
        {{ mode === 'sensor' ? 'Import Calibration' : 'Import Poses' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/import-modal.css"></style>
<style scoped>
/* Only what differs from the shared import-preview styling (see ui/import-modal.css). */
.controls { grid-template-columns: auto auto auto 1fr; }
.ctrl-crs { grid-column: 1 / -1; }
.targets-label { margin-top: 16px; }
.targets {
  list-style: none; margin: 0; padding: 0; max-height: 220px; overflow-y: auto;
  border: 1px solid var(--panel-border); border-radius: 6px;
}
.target-row {
  display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 4px 12px; align-items: center;
  padding: 8px 10px; font-size: 12px;
}
.target-row + .target-row { border-top: 1px solid var(--panel-border); }
.target-what { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.target-what strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.target-select { font-size: 12px; padding: 5px 8px; }
.target-outcome { grid-column: 1 / -1; color: var(--text-dim); }
.dim { color: var(--text-dim); }
.emptied { margin: 8px 0 0; }
.warn { color: #d89a3a; }
@media (max-width: 640px) { .target-row { grid-template-columns: 1fr; } }
</style>
