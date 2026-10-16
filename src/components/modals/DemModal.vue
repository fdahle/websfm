<script setup>
import { linearCrsUnit } from '../../core/crs.js'
import { computed, ref, watch } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import WarnBox from './ui/WarnBox.vue'
import FrameCrsField from './ui/FrameCrsField.vue'
import FieldHelp from '../guide/FieldHelp.vue'
import { DEM_DEFAULTS } from '../../core/defaults.user.js'
import { useComputeSettings } from '../../composables/useComputeSettings.js'
import { checkNumberFields } from '../../utils/numberFields.js'

// Build DEM (Digital Surface Model). Rasterises the point cloud into a height
// grid in the chosen frame. Defaults are the single source of truth in
// core/defaults.user.js (core/products/dem.js keeps matching defensive fallbacks).
// `canGeoreference` / `projectCrs` come from the reconstruction store.
// `source` is the store's `demSource` getter — the cloud generateDem() will
// actually rasterise. Shown read-only: the pick is the store's, this only makes
// it visible. A sparse source is a legitimate (if coarse) run, so it warns and
// never gates the button.
const props = defineProps({
  canGeoreference: { type: Boolean, default: false },
  hasScale: { type: Boolean, default: false },
  projectCrs: { type: String, default: null },
  // Why the project-CRS option is off ('geographic' | 'evidence' | null) and, for a
  // geographic CRS, the projected one the camera positions suggest (store getters).
  georeferenceBlocker: { type: String, default: null },
  crsSuggestion: { type: Object, default: null },
  source: { type: Object, default: null },
  // The store's `groundSource`: the classified cloud Points ▸ Ground only uses.
  groundSource: { type: Object, default: null },
})

const emit = defineEmits(['close', 'run', 'apply-crs-suggestion'])

// A georeferenced project defaults to the project CRS: a local-frame product has no
// map position (core/products/productLayers.js), so 'local' there would be a trap.
// Read once at open — a fact about the project, never re-applied over the user's pick.
// <FrameCrsField> keeps it valid afterwards (back to local when the georeference goes).
const settings = ref({ ...DEM_DEFAULTS, crs: props.canGeoreference ? 'project' : DEM_DEFAULTS.crs })
// A DTM has building- and tree-sized holes where non-ground points were removed,
// so choosing Ground only turns on the enclosed-gap fill (and All points turns it
// off again). The checkbox stays the user's after that.
watch(() => settings.value.points, (p) => { settings.value.fillHoles = p === 'ground' })

const groundOnly = computed(() => settings.value.points === 'ground')
const activeSource = computed(() => (groundOnly.value ? props.groundSource : props.source))
const isSparseSource = computed(() => activeSource.value?.kind === 'sparse')
const localUnit = computed(() => props.hasScale ? 'm/px' : 'model units/px')

const sourceLabel = computed(() => {
  const s = activeSource.value
  if (!s) return groundOnly.value ? 'No classified cloud yet' : 'No point cloud yet'
  const kind = s.kind === 'dense' ? 'Dense cloud' : 'Sparse cloud'
  // A streamed cloud is read from its octree, as finely as the cell size needs.
  const streamed = s.cloud && !s.cloud.pos && s.cloud.lod ? ' · streamed' : ''
  return `${kind}${s.name ? ` · ${s.name}` : ''} · ${s.count.toLocaleString()} points${streamed}${groundOnly.value ? ' · ground class' : ''}`
})
// The machine-level memory budget (Settings ▸ Compute), injected at run() like
// the dense modals: it bounds the staged points and the grid.
const { memBudgetBytes } = useComputeSettings()

// Run stays disabled while a field is blank or out of range (rules = the inputs'
// own min/max/step). GSD 0 is auto; blank is not — it would read as 0 silently.
const numbers = computed(() => checkNumberFields(settings.value, {
  gsd: { label: 'Ground sample distance', min: 0 },
  fillRadius: { label: 'Interpolation radius', min: 1, max: 32, integer: true, when: settings.value.fillMethod !== 'none' },
}))

function run() {
  // Pass gsd only when set (0 ⇒ let the worker auto-suggest).
  const { gsd, ...rest } = settings.value
  const out = { ...rest, memBudgetBytes: memBudgetBytes.value }
  emit('run', gsd > 0 ? { ...out, gsd } : out)
}
</script>

<template>
  <ModalShell title="Build DEM" @close="emit('close')">
    <!-- Read-only: which cloud the run will rasterise. The pick lives in the
         store's demSource getter; showing it here is what makes a sparse-source
         DEM a visible choice instead of a silent fallback. -->
    <div class="source-row">
      <span class="field-label">Source</span>
      <span class="field-hint source-value">{{ sourceLabel }}</span>
    </div>

    <SettingsField label-for="dem-points"
      :hint="groundSource ? 'Ground only rasterises the ground class of a classified cloud: a bare-earth DTM.'
        : 'Ground only needs a classified cloud: Tools ▸ Point Cloud ▸ Classify ground.'">
      <template #label><FieldHelp op="dem" param="points">Points</FieldHelp></template>
      <select id="dem-points" v-model="settings.points" class="field-input field-select">
        <option value="all">All points (DSM)</option>
        <option value="ground" :disabled="!groundSource">Ground only (DTM)</option>
      </select>
    </SettingsField>

    <WarnBox v-if="isSparseSource">
      Building from the <b>sparse</b> cloud — cells are interpolated from tie points,
      so the surface is approximate. Run <b>Depth maps → Densify</b> for a true DSM.
    </WarnBox>

    <FrameCrsField id="dem-crs" v-model="settings.crs" real-world="heights" help-op="dem"
      :can-georeference="canGeoreference" :has-scale="hasScale" :project-crs="projectCrs"
      :georeference-blocker="georeferenceBlocker" :crs-suggestion="crsSuggestion"
      @apply-crs-suggestion="(s) => emit('apply-crs-suggestion', s)" />

    <SettingsField label-for="dem-gsd"
      :unit="settings.crs === 'project' ? `${linearCrsUnit(projectCrs)}/px` : localUnit"
      hint="Cell size. 0 = auto (≈ one point per cell). Smaller = finer & slower.">
      <template #label>
        <FieldHelp op="dem" param="gsd" :value="settings.gsd || 'Auto'" :default-value="DEM_DEFAULTS.gsd || 'Auto'">Ground sample distance</FieldHelp>
      </template>
      <input id="dem-gsd" v-model.number="settings.gsd" :aria-invalid="numbers.bad.gsd" type="number" min="0" step="0.1" class="field-input" />
    </SettingsField>

    <!-- The raw min/max lets far background (an oblique capture sees almost to the
         horizon) set the raster size; the dense core keeps the site. The run logs
         how many points the core leaves out. -->
    <SettingsField label-for="dem-extent"
      hint="Dense core trims sparse far background (oblique views), and logs what it leaves out. All points uses the raw extent.">
      <template #label><FieldHelp op="dem" param="extent">Extent</FieldHelp></template>
      <select id="dem-extent" v-model="settings.extent" class="field-input field-select">
        <option value="core">Dense core of the cloud</option>
        <option value="all">All points</option>
      </select>
    </SettingsField>

    <SettingsField label-for="dem-agg"
      hint="How multiple points in one cell collapse to a single height.">
      <template #label><FieldHelp op="dem" param="aggregate">Surface aggregation</FieldHelp></template>
      <select id="dem-agg" v-model="settings.aggregate" class="field-input field-select">
        <option value="max">Max (DSM — top surface)</option>
        <option value="median">Median (robust)</option>
        <option value="mean">Mean</option>
        <option value="min">Min (ground-ish)</option>
      </select>
    </SettingsField>

    <SettingsField label-for="dem-fill-method"
      hint="IDW blends nearby heights smoothly; nearest neighbour preserves steps. Disable to keep nodata gaps.">
      <template #label><FieldHelp op="dem" param="fillMethod">Gap interpolation</FieldHelp></template>
      <select id="dem-fill-method" v-model="settings.fillMethod" class="field-input field-select">
        <option value="idw">Inverse distance (smooth)</option>
        <option value="nearest">Nearest neighbour</option>
        <option value="none">None (keep gaps)</option>
      </select>
    </SettingsField>

    <!-- The radius never expands the raster extent; it only fills cells with a
         measured neighbour inside this search distance. -->
    <SettingsField v-if="settings.fillMethod !== 'none'" label-for="dem-fill" unit="px"
      :hint="isSparseSource
        ? 'Fill empty cells with measured neighbours inside this radius. On a sparse source, a large radius invents surface between distant tie points.'
        : 'Fill empty cells only when an original measured cell lies within this radius.'">
      <template #label><FieldHelp op="dem" param="fillRadius" :value="settings.fillRadius" :default-value="DEM_DEFAULTS.fillRadius">Interpolation radius</FieldHelp></template>
      <input id="dem-fill" v-model.number="settings.fillRadius" :aria-invalid="numbers.bad.fillRadius" type="number" min="1" max="32" step="1" class="field-input" />
    </SettingsField>

    <SettingsField hint="Interpolate every gap the survey surrounds, such as the ground under a removed building. Gaps at the edge stay empty.">
      <template #label>
        <FieldHelp op="dem" param="fillHoles" :value="settings.fillHoles" :default-value="DEM_DEFAULTS.fillHoles">Fill enclosed gaps</FieldHelp>
      </template>
      <label class="checkbox-row"><input v-model="settings.fillHoles" type="checkbox" class="checkbox" /> Enabled</label>
    </SettingsField>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!numbers.valid || (groundOnly && !groundSource)"
        :title="groundOnly && !groundSource ? 'Classify the ground of a dense cloud first' : numbers.reason" @click="run">{{ groundOnly ? 'Build DTM' : 'Build DEM' }}</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
/* DEM/aggregation selects read better full-width. */
.field-select { width: 100%; }
/* Source is a read-only statement, not a field: label and value on one line. */
.source-row { display: flex; align-items: baseline; gap: 8px; }
.source-value { color: var(--text); }
</style>
