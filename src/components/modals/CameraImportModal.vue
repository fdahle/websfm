<script setup>
import { ref, computed } from 'vue'
import CrsPicker from '../controls/CrsPicker.vue'
import ModalShell from './ui/ModalShell.vue'
import ColumnMappingTable from './ui/ColumnMappingTable.vue'
import ImportKindSwitch from './ui/ImportKindSwitch.vue'
import { DELIMITER_OPTIONS } from '../../core/io/gcp.js'
import { SENSOR_ROLES, SENSOR_ROLE_LABELS, guessMapping as guessSensors, buildSensors } from '../../core/io/sensor.js'
import { POSE_ROLES, POSE_ROLE_LABELS, guessMapping as guessPoses, buildPoses } from '../../core/io/pose.js'
import { useDelimitedImport } from '../../composables/useDelimitedImport.js'
import { axisLabels } from '../../core/crs.js'

// Imports camera parameters from delimited text in one of two modes:
//   - 'sensor' : shared intrinsics (one row per sensor) — no CRS
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
})
const emit = defineEmits(['close', 'import', 'switch-kind'])

const mode = ref(props.detectedMode === 'sensor' ? 'sensor' : 'pose')
const sourceCrs = ref(props.projectCrs)

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
        Import {{ mode === 'sensor' ? 'Sensors' : 'Poses' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/import-modal.css"></style>
<style scoped>
/* Only what differs from the shared import-preview styling (see ui/import-modal.css). */
.controls { grid-template-columns: auto auto 1fr; }
.ctrl-crs { grid-column: 1 / -1; }
</style>
