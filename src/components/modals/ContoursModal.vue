<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import WarnBox from './ui/WarnBox.vue'
import { CONTOUR_DEFAULTS } from '../../core/defaults.user.js'
import { contourLevels, MAX_CONTOUR_LEVELS } from '../../core/products/contours.js'

// Contours (Tools ▸ Products ▾) — contour lines traced from the DEM (marching
// squares, core/products/contours.js), downloaded as GeoJSON or DXF. The DEM itself
// is not changed. Heights and the interval are in the DEM's own vertical unit.
const props = defineProps({
  dem: { type: Object, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...CONTOUR_DEFAULTS })
const unit = computed(() => (props.dem?.unit === 'model' ? 'model units' : (props.dem?.unit || 'units')))

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
  try { return contourLevels({ min: props.dem.zMin, max: props.dem.zMax }, { interval: interval.value }).length } catch { return Infinity }
})

function run() {
  const s = settings.value
  emit('run', {
    interval: interval.value, indexEvery: s.indexEvery, smooth: s.smooth,
    minLength: s.minLength, format: s.format,
  })
}
</script>

<template>
  <ModalShell title="Contour Lines" @close="emit('close')">
    <WarnBox v-if="!dem">Build a DEM first (<strong>Reconstruct ▸ DEM</strong>).</WarnBox>
    <template v-else>
      <SettingsGroup title="Levels">
        <SettingsField label="Interval" label-for="ct-int" :unit="unit"
          :hint="`0 = auto (${autoInterval} ${unit}). Heights run ${dem.zMin.toPrecision(5)} – ${dem.zMax.toPrecision(5)} ${unit}.`">
          <input id="ct-int" v-model.number="settings.interval" type="number" min="0" step="any" class="field-input" />
        </SettingsField>
        <SettingsField label="Index contour every" label-for="ct-index" unit="lines"
          hint="Index contours go on their own layer (drawn heavier in GIS/CAD).">
          <input id="ct-index" v-model.number="settings.indexEvery" type="number" min="1" step="1" class="field-input" />
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title="Shape">
        <SettingsField label="Smoothing" label-for="ct-smooth" unit="passes" hint="0 keeps the exact grid crossings.">
          <input id="ct-smooth" v-model.number="settings.smooth" type="number" min="0" max="10" step="1" class="field-input" />
        </SettingsField>
        <SettingsField label="Drop lines shorter than" label-for="ct-min" :unit="dem.crs && dem.crs !== 'local' ? 'map units' : unit">
          <input id="ct-min" v-model.number="settings.minLength" type="number" min="0" step="any" class="field-input" />
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title="Download">
        <SettingsField label="Format" label-for="ct-fmt">
          <select id="ct-fmt" v-model="settings.format" class="field-select">
            <option value="geojson">GeoJSON (GIS)</option>
            <option value="dxf">DXF R12 (CAD)</option>
          </select>
        </SettingsField>
      </SettingsGroup>
      <WarnBox v-if="levelCount > MAX_CONTOUR_LEVELS">That interval gives too many levels — use a larger one.</WarnBox>
      <p v-else class="field-hint">{{ levelCount.toLocaleString() }} levels every {{ interval }} {{ unit }}.</p>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!dem || !(levelCount > 0 && levelCount <= MAX_CONTOUR_LEVELS)" @click="run">Export contours</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
