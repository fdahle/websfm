<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import CrsPicker from '../controls/CrsPicker.vue'
import { DELIMITER_OPTIONS, sniffDelimiter, parseRows, guessMapping, buildGcps } from '../../core/io/gcp.js'
import { axisLabels } from '../../core/crs.js'
import { GCP_ACCURACY_PRESETS } from '../../core/gcpAccuracy.js'
import { roleSelectStyle } from './ui/importRoles.js'

const props = defineProps({
  rawText:    { type: String, default: '' },
  fileName:   { type: String, default: 'gcp file' },
  projectCrs: { type: String, default: 'EPSG:4326' },
  // When importing from GeoJSON points, pre-parsed GCPs are passed in and the
  // delimiter/column-mapping UI is replaced by a simple preview.
  geojsonGcps: { type: Array,  default: null },
  detectedCrs: { type: String, default: null },
  accuracyDefaults: { type: Object, default: null },
  // The user already said this is a GCP file (Ribbon ▸ Import ▸ GCP File, or the
  // kind chooser), so the "Import as" question shrinks to a correction link —
  // see the same prop on CameraImportModal.
  kindDeclared: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'import', 'switch-kind'])

const geojsonMode = computed(() => Array.isArray(props.geojsonGcps))

// Re-interpret this same file as camera data (hands off to App, which opens the
// camera importer). Not offered in GeoJSON mode — GeoJSON points are never poses.
function switchKind(kind) {
  emit('switch-kind', { kind, rawText: props.rawText, fileName: props.fileName })
}

const delimiter = ref(sniffDelimiter(props.rawText))
const hasHeader = ref(true)
const sourceCrs = ref(props.detectedCrs || props.projectCrs)
const columnRoles = ref([])      // index → role id
const remembered = props.accuracyDefaults || {}
const accuracyPreset = ref(remembered.settings?.preset ?? 'unknown')
const defaultAccuracyX = ref(remembered.accuracies?.x ?? '')
const defaultAccuracyY = ref(remembered.accuracies?.y ?? '')
const defaultAccuracyZ = ref(remembered.accuracies?.z ?? '')
const accuracyConvention = ref(remembered.settings?.convention ?? '1sigma')
const accuracyUnit = ref(remembered.settings?.unit ?? 'metres')
const verticalDatum = ref(remembered.settings?.verticalDatum ?? 'unknown')
const defaultImageAccuracyX = ref(remembered.imageAccuracies?.x ?? 1)
const defaultImageAccuracyY = ref(remembered.imageAccuracies?.y ?? 1)

function applyAccuracyPreset() {
  const preset = GCP_ACCURACY_PRESETS[accuracyPreset.value]
  if (!preset) return
  defaultAccuracyX.value = preset.x ?? ''
  defaultAccuracyY.value = preset.y ?? ''
  defaultAccuracyZ.value = preset.z ?? ''
}

// ── Parsing ────────────────────────────────────────────────────────────────────

const rows = computed(() => parseRows(props.rawText, delimiter.value))
const columnCount = computed(() => rows.value.reduce((m, r) => Math.max(m, r.length), 0))
const headerCells = computed(() => (hasHeader.value ? (rows.value[0] || []) : []))
const dataRows = computed(() => (hasHeader.value ? rows.value.slice(1) : rows.value))
const previewRows = computed(() => dataRows.value.slice(0, 8))

function reguess() {
  const m = guessMapping(headerCells.value, columnCount.value, hasHeader.value)
  const roles = new Array(columnCount.value).fill('ignore')
  for (const [role, idx] of Object.entries(m)) if (idx != null) roles[idx] = role
  columnRoles.value = roles
}

onMounted(reguess)
watch([delimiter, hasHeader], reguess)

// ── Column-role assignment (each role used at most once) ───────────────────────

const roleOptions = computed(() => {
  const [ax, ay, az] = axisLabels(sourceCrs.value)
  return [
    { id: 'ignore', label: 'Ignore' },
    { id: 'name',   label: 'Name / ID' },
    { id: 'x',      label: `Abs ${ax}` },
    { id: 'y',      label: `Abs ${ay}` },
    { id: 'z',      label: `Abs ${az}` },
    { id: 'image',  label: 'Image name' },
    { id: 'px',     label: 'Pixel X' },
    { id: 'py',     label: 'Pixel Y' },
    { id: 'role',   label: 'Control / check' },
    { id: 'accuracyX', label: 'X accuracy (σ)' },
    { id: 'accuracyY', label: 'Y accuracy (σ)' },
    { id: 'accuracyZ', label: 'Z accuracy (σ)' },
    { id: 'accuracyXY', label: 'Horizontal accuracy' },
    { id: 'accuracyImgX', label: 'Image X accuracy (px)' },
    { id: 'accuracyImgY', label: 'Image Y accuracy (px)' },
    { id: 'correlationXY', label: 'XY correlation (ρ)' },
    { id: 'correlationXZ', label: 'XZ correlation (ρ)' },
    { id: 'correlationYZ', label: 'YZ correlation (ρ)' },
  ]
})

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
  const m = {
    name: null, x: null, y: null, z: null, image: null, px: null, py: null, role: null,
    accuracyX: null, accuracyY: null, accuracyZ: null,
    accuracyXY: null,
    accuracyImgX: null, accuracyImgY: null,
    correlationXY: null, correlationXZ: null, correlationYZ: null,
  }
  columnRoles.value.forEach((role, i) => { if (role !== 'ignore' && m[role] == null) m[role] = i })
  return m
})

// ── Result ──────────────────────────────────────────────────────────────────────

const built = computed(() =>
  geojsonMode.value ? { gcps: props.geojsonGcps, skipped: 0 } : buildGcps(dataRows.value, mapping.value)
)
const obsCount = computed(() => built.value.gcps.reduce((n, g) => n + g.observations.length, 0))

const hasName = computed(() => mapping.value.name != null)
const hasXY = computed(() => mapping.value.x != null && mapping.value.y != null)
const validDefaults = computed(() => {
  const values = [defaultAccuracyX.value, defaultAccuracyY.value, defaultAccuracyZ.value]
  const groundValid = values.every((value) => String(value).trim() === '')
    || values.every((value) => Number.isFinite(Number(value)) && Number(value) > 0)
  return groundValid && [defaultImageAccuracyX.value, defaultImageAccuracyY.value]
    .every((value) => Number.isFinite(Number(value)) && Number(value) > 0)
})
const canImport = computed(() =>
  validDefaults.value && (geojsonMode.value
    ? built.value.gcps.length > 0
    : (hasName.value && hasXY.value && built.value.gcps.length > 0))
)

const axX = computed(() => axisLabels(sourceCrs.value)[0])
const axY = computed(() => axisLabels(sourceCrs.value)[1])

function doImport() {
  if (!canImport.value) return
  emit('import', {
    gcps: built.value.gcps,
    sourceCrs: sourceCrs.value,
    defaultAccuracies: {
      x: String(defaultAccuracyX.value).trim() === '' ? null : Number(defaultAccuracyX.value),
      y: String(defaultAccuracyY.value).trim() === '' ? null : Number(defaultAccuracyY.value),
      z: String(defaultAccuracyZ.value).trim() === '' ? null : Number(defaultAccuracyZ.value),
    },
    accuracySettings: {
      preset: accuracyPreset.value,
      convention: accuracyConvention.value,
      unit: accuracyUnit.value,
      verticalDatum: verticalDatum.value,
    },
    defaultImageAccuracies: { x: Number(defaultImageAccuracyX.value), y: Number(defaultImageAccuracyY.value) },
  })
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Import GCPs">
      <div class="modal-header">
        <span class="modal-title">Import Ground Control Points</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="filename">{{ fileName }}</div>

        <template v-if="!geojsonMode">
          <template v-if="!kindDeclared">
            <label class="section-label kind-label">Import as</label>
            <div class="kind-toggle">
              <button class="kind-btn active">Ground Control Points</button>
              <button class="kind-btn" @click="switchKind('pose')">Camera Positions</button>
              <button class="kind-btn" @click="switchKind('sensor')">Camera Intrinsics</button>
            </div>
          </template>
          <p v-else class="kind-note">
            Importing as <b>Ground Control Points</b>. Not right? Import as
            <button class="kind-link" @click="switchKind('pose')">Camera Positions</button>
            or <button class="kind-link" @click="switchKind('sensor')">Camera Intrinsics</button>.
          </p>
        </template>

        <label class="section-label">Ground-coordinate uncertainty</label>
        <div class="accuracy-controls">
          <label class="accuracy-ctrl">
            <span>Method / preset</span>
            <select v-model="accuracyPreset" @change="applyAccuracyPreset">
              <option v-for="(preset, id) in GCP_ACCURACY_PRESETS" :key="id" :value="id">{{ preset.label }}</option>
            </select>
          </label>
          <label class="accuracy-ctrl">
            <span>X accuracy</span>
            <input v-model="defaultAccuracyX" type="number" min="0" step="any" @input="accuracyPreset = 'custom'" />
          </label>
          <label class="accuracy-ctrl">
            <span>Y accuracy</span>
            <input v-model="defaultAccuracyY" type="number" min="0" step="any" @input="accuracyPreset = 'custom'" />
          </label>
          <label class="accuracy-ctrl">
            <span>Z accuracy</span>
            <input v-model="defaultAccuracyZ" type="number" min="0" step="any" @input="accuracyPreset = 'custom'" />
          </label>
          <label class="accuracy-ctrl">
            <span>Values represent</span>
            <select v-model="accuracyConvention">
              <option value="1sigma">1σ</option>
              <option value="2sigma">2σ</option>
              <option value="95">95% per axis</option>
              <option value="hrms">HRMS / VRMS</option>
              <option value="cep95">CEP95 / 95% Z</option>
            </select>
          </label>
          <label class="accuracy-ctrl">
            <span>Accuracy unit</span>
            <select v-model="accuracyUnit">
              <option value="metres">Metres</option>
              <option value="project">Project CRS units</option>
              <option value="source">Source CRS units</option>
            </select>
          </label>
          <label class="accuracy-ctrl">
            <span>Height datum</span>
            <select v-model="verticalDatum">
              <option value="unknown">Unknown</option>
              <option value="ellipsoidal">Ellipsoidal</option>
              <option value="orthometric">Orthometric / geoid</option>
              <option value="local">Local datum</option>
            </select>
          </label>
          <label class="accuracy-ctrl">
            <span>Default image X/Y σ (px)</span>
            <span class="paired-inputs"><input v-model="defaultImageAccuracyX" type="number" min="0" step="any" /> /
              <input v-model="defaultImageAccuracyY" type="number" min="0" step="any" /></span>
          </label>
        </div>
        <p class="accuracy-help">
          Used when a row has no mapped accuracy value. “Unknown” imports the points for reporting but does not let them constrain the solution.
        </p>

        <div class="controls">
          <template v-if="!geojsonMode">
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
          </template>
          <div class="ctrl ctrl-crs">
            <label class="ctrl-label">Source CRS of these coordinates</label>
            <CrsPicker v-model="sourceCrs" />
          </div>
        </div>

        <template v-if="geojsonMode">
          <label class="section-label">Preview</label>
          <div class="table-wrap">
            <table class="preview">
              <thead><tr><th>Name</th><th>{{ axX }}</th><th>{{ axY }}</th></tr></thead>
              <tbody>
                <tr v-for="(g, i) in built.gcps.slice(0, 12)" :key="i">
                  <td>{{ g.name }}</td><td>{{ g.x }}</td><td>{{ g.y }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template v-else>
        <label class="section-label">Column mapping</label>
        <div class="table-wrap">
          <table class="preview">
            <thead>
              <tr>
                <th v-for="i in columnCount" :key="'r' + i" class="role-cell">
                  <select
                    class="role-select"
                    :style="roleSelectStyle(columnRoles[i - 1] || 'ignore', roleOptions)"
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
        </template>

        <div class="summary">
          <span v-if="!geojsonMode && !hasName" class="warn">Assign a <b>Name / ID</b> column.</span>
          <span v-else-if="!geojsonMode && !hasXY" class="warn">Assign <b>Abs {{ axX }}</b> and <b>Abs {{ axY }}</b> columns.</span>
          <span v-else-if="!validDefaults" class="warn">Accuracy values must be greater than zero.</span>
          <span v-else class="ok">
            {{ built.gcps.length }} GCP{{ built.gcps.length === 1 ? '' : 's' }}<template v-if="obsCount">, {{ obsCount }} image observation{{ obsCount === 1 ? '' : 's' }}</template>
            <template v-if="built.skipped"> · {{ built.skipped }} row{{ built.skipped === 1 ? '' : 's' }} skipped</template>
          </span>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn-secondary" @click="emit('close')">Cancel</button>
        <button class="btn-primary" :disabled="!canImport" @click="doImport">Import GCPs</button>
      </div>
    </div>
  </div>
</template>

<style scoped src="./ui/import-modal.css"></style>
<style scoped>
/* Only what differs from the shared import-preview chrome (see ui/import-modal.css). */
.modal { width: min(960px, calc(100vw - 32px)); }
.controls { grid-template-columns: auto auto 1fr; }
.ctrl-crs { grid-column: 1 / -1; }
.preview td { color: var(--text); font-family: monospace; }
.accuracy-controls { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; }
.accuracy-ctrl { display: grid; gap: 5px; color: var(--text-dim); font-size: 12px; }
.accuracy-ctrl input { width: 90px; }
.accuracy-ctrl select { min-width: 115px; }
.accuracy-unit { padding-bottom: 6px; color: var(--text-dim); font-size: 12px; }
.accuracy-help { margin: 7px 0 0; color: var(--text-dim); font-size: 12px; }
.paired-inputs { display: flex; align-items: center; gap: 3px; }
.paired-inputs input { width: 58px; }
</style>
