<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import WarnBox from '../ui/WarnBox.vue'
import GlossaryTerm from '../../glossary/GlossaryTerm.vue'
import { CONTOUR_DEFAULTS } from '../../../core/defaults.user.js'
import { contourLevels, MAX_CONTOUR_LEVELS } from '../../../core/products/contours.js'
import { contoursEffects } from '../../../core/stepEffects/contours.js'
import { checkNumberFields } from '../../../utils/numberFields.js'
import FileNameField from '../ui/FileNameField.vue'
import { defaultExportName } from '../../../core/exportNames.js'
import { useProjectsStore } from '../../../stores/useProjectsStore.js'

// Contours (Tools ▸ Products ▾) — contour lines traced from the DEM (marching
// squares, core/products/contours.js), added to the map as a line layer and, if
// asked, downloaded as GeoJSON or DXF. A DEM without a CRS cannot go on the map's
// layers, so its contours are always downloaded. The DEM itself is not changed.
// Heights and the interval are in the DEM's own vertical unit.
const props = defineProps({
  dem: { type: Object, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...CONTOUR_DEFAULTS })
const onMap = computed(() => !!props.dem?.crs && props.dem.crs !== 'local')
if (!onMap.value && settings.value.format === 'none') settings.value.format = 'geojson'
const unit = computed(() => (props.dem?.unit === 'model' ? 'model units' : props.dem?.unit || 'units'))

// ≈ 25 levels over the height range, rounded to a 1·2·5 × 10ⁿ step — the interval a
// cartographer would pick, not 3.7183.
const autoInterval = computed(() => {
  const span = (props.dem?.zMax ?? 0) - (props.dem?.zMin ?? 0)
  if (!(span > 0)) return 1
  const raw = span / 25
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p
})
const interval = computed(() => (settings.value.interval > 0 ? settings.value.interval : autoInterval.value))
const levelCount = computed(() => {
  try {
    return contourLevels({ min: props.dem.zMin, max: props.dem.zMax }, { interval: interval.value }).length
  } catch {
    return Infinity
  }
})
// Export stays disabled while a field is blank or out of range (rules = the inputs'
// own min/max/step). An interval of 0 is auto; blank is not.
const numbers = computed(() =>
  checkNumberFields(settings.value, {
    interval: { label: 'Interval', min: 0 },
    indexEvery: { label: 'Index contour every', min: 1, integer: true },
    smooth: { label: 'Smoothing', min: 0, max: 10, integer: true },
    generalize: { label: 'Smooth the DEM first', min: 0, max: 20 },
    minCells: { label: 'Drop lines shorter than', min: 0 },
  }),
)

// The optional File name, and the name the export gets without one.
const fileName = ref('')
const projects = useProjectsStore()
const defaultName = computed(() => defaultExportName('contours', { base: projects.currentProjectName || 'project' }))
// What each step does with this DEM (core/stepEffects/contours.js).
const effects = computed(() =>
  contoursEffects(settings.value, {
    interval: interval.value,
    levels: levelCount.value,
    max: MAX_CONTOUR_LEVELS,
    zMin: props.dem?.zMin ?? 0,
    zMax: props.dem?.zMax ?? 0,
    unit: unit.value,
    onMap: onMap.value,
    gsd: props.dem?.gsd ?? 0,
  }),
)

function run() {
  const s = settings.value
  emit('run', {
    interval: interval.value,
    indexEvery: s.indexEvery,
    smooth: s.smooth,
    generalize: s.generalize,
    minCells: s.minCells,
    format: s.format,
    fileName: fileName.value,
  })
}
</script>

<template>
  <ModalShell title="Contour Lines" @close="emit('close')">
    <WarnBox v-if="!dem">Build a DEM first (<strong>Reconstruct ▸ DEM</strong>).</WarnBox>
    <template v-else>
      <SettingsStep step="1" title="Pick the levels" :effect="effects.levels">
        <SettingsField label="Interval" label-for="ct-int" :unit="unit" :hint="`0 = auto (${autoInterval} ${unit}).`">
          <input
            id="ct-int"
            v-model.number="settings.interval"
            :aria-invalid="numbers.bad.interval"
            type="number"
            min="0"
            step="any"
            class="field-input"
          />
        </SettingsField>
        <SettingsField
          label-for="ct-index"
          unit="lines"
          hint="Index contours go on their own layer (drawn heavier in GIS/CAD)."
        >
          <template #label><GlossaryTerm id="contour-lines">Index contour</GlossaryTerm> every</template>
          <input
            id="ct-index"
            v-model.number="settings.indexEvery"
            :aria-invalid="numbers.bad.indexEvery"
            type="number"
            min="1"
            step="1"
            class="field-input"
          />
        </SettingsField>
      </SettingsStep>
      <SettingsStep step="2" title="Trace and shape" :effect="effects.shape">
        <SettingsField
          label="Smooth the DEM first"
          label-for="ct-gen"
          unit="cells"
          hint="Gaussian σ. Removes the noise rings of a photogrammetric DEM; 0 traces the heights as they are."
        >
          <input
            id="ct-gen"
            v-model.number="settings.generalize"
            :aria-invalid="numbers.bad.generalize"
            type="number"
            min="0"
            max="20"
            step="0.5"
            class="field-input"
          />
        </SettingsField>
        <SettingsField label="Smoothing" label-for="ct-smooth" unit="passes" hint="0 keeps the exact grid crossings.">
          <input
            id="ct-smooth"
            v-model.number="settings.smooth"
            :aria-invalid="numbers.bad.smooth"
            type="number"
            min="0"
            max="10"
            step="1"
            class="field-input"
          />
        </SettingsField>
        <SettingsField label="Drop lines shorter than" label-for="ct-min" unit="cells" hint="0 keeps every line.">
          <input
            id="ct-min"
            v-model.number="settings.minCells"
            :aria-invalid="numbers.bad.minCells"
            type="number"
            min="0"
            step="1"
            class="field-input"
          />
        </SettingsField>
      </SettingsStep>
      <SettingsStep step="3" title="Place and save" :effect="effects.result">
        <SettingsField label="Download" label-for="ct-fmt">
          <select id="ct-fmt" v-model="settings.format" class="field-select">
            <option v-if="onMap" value="none">No download</option>
            <option value="geojson">GeoJSON (GIS)</option>
            <option value="dxf">DXF R12 (CAD)</option>
          </select>
        </SettingsField>
        <FileNameField v-if="settings.format !== 'none'" v-model="fileName" :default-name="defaultName" />
      </SettingsStep>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button
        class="btn btn-primary"
        :disabled="!dem || !numbers.valid || !(levelCount > 0 && levelCount <= MAX_CONTOUR_LEVELS)"
        :title="numbers.reason"
        @click="run"
      >
        Create contours
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
