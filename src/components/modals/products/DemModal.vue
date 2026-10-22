<script setup>
import { linearCrsUnit } from '../../../core/crs.js'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import WarnBox from '../ui/WarnBox.vue'
import FrameCrsField from '../ui/FrameCrsField.vue'
import RasterSizeField from '../ui/RasterSizeField.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { DEM_DEFAULTS } from '../../../core/defaults.user.js'
import { useComputeSettings } from '../../../composables/useComputeSettings.js'
import { checkNumberFields } from '../../../utils/numberFields.js'
import { demEffects, frameText } from '../../../core/stepEffects/raster.js'

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
  // The store's estimateRasterSize('dem', settings): the size readout under the cell size.
  estimateSize: { type: Function, default: null },
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
watch(
  () => settings.value.points,
  (p) => {
    settings.value.fillHoles = p === 'ground'
  },
)

const groundOnly = computed(() => settings.value.points === 'ground')
const activeSource = computed(() => (groundOnly.value ? props.groundSource : props.source))
const isSparseSource = computed(() => activeSource.value?.kind === 'sparse')
const localUnit = computed(() => (props.hasScale ? 'm/px' : 'model units/px'))

// The machine-level memory budget (Settings ▸ Compute), injected at run() like
// the dense modals: it bounds the staged points and the grid.
const { memBudgetBytes } = useComputeSettings()

// Run stays disabled while a field is blank or out of range (rules = the inputs'
// own min/max/step). GSD 0 is auto; blank is not — it would read as 0 silently.
const numbers = computed(() =>
  checkNumberFields(settings.value, {
    gsd: { label: 'Ground sample distance', min: 0, when: settings.value.sizeBy !== 'px' },
    longSide: { label: 'Long side', min: 0, integer: true, when: settings.value.sizeBy === 'px' },
    fillRadius: {
      label: 'Interpolation radius',
      min: 1,
      max: 32,
      integer: true,
      when: settings.value.fillMethod !== 'none',
    },
  }),
)

// What a run gets: the size field shown (a cell size, or a long side in px), only
// when set — 0 ⇒ the worker's auto.
function runSettings() {
  const { gsd, longSide, ...rest } = settings.value
  const size = rest.sizeBy === 'px' ? (longSide > 1 ? { longSide } : {}) : gsd > 0 ? { gsd } : {}
  return { ...rest, memBudgetBytes: memBudgetBytes.value, ...size }
}
function run() {
  emit('run', runSettings())
}

// The size the run would build, re-estimated (debounced) when what sets it changes.
const estimate = ref(null)
let estimateGen = 0,
  estimateTimer = null
watch(
  () => {
    const s = settings.value
    return JSON.stringify([s.crs, s.extent, s.points, s.sizeBy, s.gsd, s.longSide, memBudgetBytes.value])
  },
  () => {
    if (!props.estimateSize) return
    clearTimeout(estimateTimer)
    const gen = ++estimateGen
    if (typeof estimate.value !== 'object' || !estimate.value) estimate.value = 'loading'
    estimateTimer = setTimeout(async () => {
      let e = null
      try {
        e = await props.estimateSize(runSettings())
      } catch {
        e = null
      }
      if (gen === estimateGen) estimate.value = e
    }, 250)
  },
  { immediate: true },
)
onBeforeUnmount(() => clearTimeout(estimateTimer))

// What each step does to this project (core/stepEffects/raster.js).
const cellUnit = computed(() =>
  settings.value.crs === 'project' ? `${linearCrsUnit(props.projectCrs)}/px` : localUnit.value,
)
const effects = computed(() => {
  const s = activeSource.value
  return demEffects(settings.value, {
    // A streamed cloud is read from its octree, as finely as the cell size needs.
    source: s && { kind: s.kind, name: s.name, count: s.count, streamed: !!(s.cloud && !s.cloud.pos && s.cloud.lod) },
    estimate: estimate.value,
    unit: cellUnit.value,
    frame: frameText(settings.value.crs, { projectCrs: props.projectCrs, hasScale: props.hasScale }),
  })
})
</script>

<template>
  <ModalShell title="Build DEM" @close="emit('close')">
    <SettingsStep step="1" title="Points" :effect="effects.points">
      <SettingsField
        label-for="dem-points"
        :hint="
          groundSource
            ? 'Ground only rasterises the ground class of a classified cloud: a bare-earth DTM.'
            : 'Ground only needs a classified cloud: Tools ▸ Point Cloud ▸ Classify ground.'
        "
      >
        <template #label><FieldHelp op="dem" param="points">Points</FieldHelp></template>
        <select id="dem-points" v-model="settings.points" class="field-input field-select">
          <option value="all">All points (DSM)</option>
          <option value="ground" :disabled="!groundSource">Ground only (DTM)</option>
        </select>
      </SettingsField>

      <WarnBox v-if="isSparseSource">
        Building from the <b>sparse</b> cloud — cells are interpolated from tie points, so the surface is approximate.
        Run <b>Depth maps → Densify</b> for a true DSM.
      </WarnBox>
    </SettingsStep>

    <SettingsStep step="2" title="Grid" :effect="effects.grid">
      <FrameCrsField
        id="dem-crs"
        v-model="settings.crs"
        real-world="heights"
        help-op="dem"
        :can-georeference="canGeoreference"
        :has-scale="hasScale"
        :project-crs="projectCrs"
        :georeference-blocker="georeferenceBlocker"
        :crs-suggestion="crsSuggestion"
        @apply-crs-suggestion="(s) => emit('apply-crs-suggestion', s)"
      />

      <!-- The raw min/max lets far background (an oblique capture sees almost to the
           horizon) set the raster size; the dense core keeps the site. The run logs
           how many points the core leaves out. -->
      <SettingsField
        label-for="dem-extent"
        hint="Dense core trims sparse far background (oblique views), and logs what it leaves out. All points uses the raw extent."
      >
        <template #label><FieldHelp op="dem" param="extent">Extent</FieldHelp></template>
        <select id="dem-extent" v-model="settings.extent" class="field-input field-select">
          <option value="core">Dense core of the cloud</option>
          <option value="all">All points</option>
        </select>
      </SettingsField>

      <RasterSizeField
        id="dem"
        op="dem"
        :defaults="DEM_DEFAULTS"
        v-model:size-by="settings.sizeBy"
        v-model:gsd="settings.gsd"
        v-model:long-side="settings.longSide"
        :unit="cellUnit"
        gsd-hint="Cell size. 0 = auto (≈ one point per cell). Smaller = finer & slower."
        :invalid="numbers.bad"
        :estimate="estimate"
        auto-capped="Auto keeps a DEM to 4,096 px a side, so this one is coarser than one point per cell. Set a cell size or a long side for a finer DEM."
      />
    </SettingsStep>

    <SettingsStep step="3" title="Height per cell" :effect="effects.cell">
      <SettingsField label-for="dem-agg" hint="How multiple points in one cell collapse to a single height.">
        <template #label><FieldHelp op="dem" param="aggregate">Surface aggregation</FieldHelp></template>
        <select id="dem-agg" v-model="settings.aggregate" class="field-input field-select">
          <option value="max">Max (DSM — top surface)</option>
          <option value="median">Median (robust)</option>
          <option value="mean">Mean</option>
          <option value="min">Min (ground-ish)</option>
        </select>
      </SettingsField>
    </SettingsStep>

    <SettingsStep step="4" title="Fill gaps" :effect="effects.fill">
      <SettingsField
        label-for="dem-fill-method"
        hint="IDW blends nearby heights smoothly; nearest neighbour preserves steps. Disable to keep nodata gaps."
      >
        <template #label><FieldHelp op="dem" param="fillMethod">Gap interpolation</FieldHelp></template>
        <select id="dem-fill-method" v-model="settings.fillMethod" class="field-input field-select">
          <option value="idw">Inverse distance (smooth)</option>
          <option value="nearest">Nearest neighbour</option>
          <option value="none">None (keep gaps)</option>
        </select>
      </SettingsField>

      <!-- The radius never expands the raster extent; it only fills cells with a
           measured neighbour inside this search distance. -->
      <SettingsField
        v-if="settings.fillMethod !== 'none'"
        label-for="dem-fill"
        unit="px"
        :hint="
          isSparseSource
            ? 'Fill empty cells with measured neighbours inside this radius. On a sparse source, a large radius invents surface between distant tie points.'
            : 'Fill empty cells only when an original measured cell lies within this radius.'
        "
      >
        <template #label
          ><FieldHelp op="dem" param="fillRadius" :value="settings.fillRadius" :default-value="DEM_DEFAULTS.fillRadius"
            >Interpolation radius</FieldHelp
          ></template
        >
        <input
          id="dem-fill"
          v-model.number="settings.fillRadius"
          :aria-invalid="numbers.bad.fillRadius"
          type="number"
          min="1"
          max="32"
          step="1"
          class="field-input"
        />
      </SettingsField>

      <SettingsField
        hint="Interpolate every gap the survey surrounds, such as the ground under a removed building. Gaps at the edge stay empty."
      >
        <template #label>
          <FieldHelp op="dem" param="fillHoles" :value="settings.fillHoles" :default-value="DEM_DEFAULTS.fillHoles"
            >Fill enclosed gaps</FieldHelp
          >
        </template>
        <label class="checkbox-row"
          ><input v-model="settings.fillHoles" type="checkbox" class="checkbox" /> Enabled</label
        >
      </SettingsField>
    </SettingsStep>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button
        class="btn btn-primary"
        :disabled="!numbers.valid || (groundOnly && !groundSource)"
        :title="groundOnly && !groundSource ? 'Classify the ground of a dense cloud first' : numbers.reason"
        @click="run"
      >
        {{ groundOnly ? 'Build DTM' : 'Build DEM' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
/* DEM/aggregation selects read better full-width. */
.field-select {
  width: 100%;
}
</style>
