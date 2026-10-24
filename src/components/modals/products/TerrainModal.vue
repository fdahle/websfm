<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import WarnBox from '../ui/WarnBox.vue'
import GlossaryTerm from '../../glossary/GlossaryTerm.vue'
import { TERRAIN_DEFAULTS } from '../../../core/defaults.user.js'
import { terrainEffects } from '../../../core/stepEffects/terrain.js'
import { checkNumberFields } from '../../../utils/numberFields.js'
import FileNameField from '../ui/FileNameField.vue'
import { defaultExportName } from '../../../core/exportNames.js'
import { useProjectsStore } from '../../../stores/useProjectsStore.js'

// Slope, Aspect, Hillshade (Tools ▸ Products ▾) — terrain derivatives of the DEM
// (Horn's method, as gdaldem; core/products/terrain.js), each downloaded as a
// GeoTIFF on the DEM's grid. Slope compares a height difference with a horizontal
// one, so both must be in the same unit: true for a metric or model-unit DEM; a
// projected CRS's scale factor k is corrected at the DEM centre.
const props = defineProps({
  dem: { type: Object, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...TERRAIN_DEFAULTS, products: [...TERRAIN_DEFAULTS.products], compression: 'deflate' })
const PRODUCTS = ['slope', 'aspect', 'hillshade']
const has = (id) => settings.value.products.includes(id)
function toggle(id) {
  const on = has(id)
  settings.value.products = PRODUCTS.filter((p) => (p === id ? !on : has(p)))
}
const geographic = computed(() => /longlat|EPSG:4326\b/i.test(props.dem?.crs || ''))
// Export stays disabled while a sun angle is blank or out of range (rules = the
// inputs' own min/max); they only matter when a hillshade is requested.
const numbers = computed(() =>
  checkNumberFields(settings.value, {
    azimuth: { label: 'Sun azimuth', min: 0, max: 360, when: has('hillshade') },
    altitude: { label: 'Sun altitude', min: 1, max: 90, when: has('hillshade') },
  }),
)

// The optional File name, and the name the export gets without one.
const fileName = ref('')
const projects = useProjectsStore()
const defaultName = computed(() => defaultExportName('terrain', { base: projects.currentProjectName || 'project' }))
// What each step does with this DEM (core/stepEffects/terrain.js).
const effects = computed(() => terrainEffects(settings.value))

function run() {
  const s = settings.value
  emit('run', {
    fileName: fileName.value,
    products: [...s.products],
    slopeUnits: s.slopeUnits,
    azimuth: s.azimuth,
    altitude: s.altitude,
    multidirectional: !!s.multidirectional,
    compression: s.compression,
  })
}
</script>

<template>
  <ModalShell title="Slope, Aspect, Hillshade" @close="emit('close')">
    <WarnBox v-if="!dem">Build a DEM first (<strong>Reconstruct ▸ DEM</strong>).</WarnBox>
    <WarnBox v-else-if="geographic"
      >This DEM is in degrees of longitude/latitude, so its horizontal and vertical units differ. Rebuild it in a
      projected CRS for slope and aspect.</WarnBox
    >
    <template v-else>
      <SettingsStep step="1" title="Slope" :effect="effects.slope" :inactive="!has('slope')">
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('slope')" @change="toggle('slope')" /> Make a
          <GlossaryTerm id="terrain-derivatives">slope</GlossaryTerm> raster</label
        >
        <SettingsField v-if="has('slope')" label="Units" label-for="tr-units">
          <select id="tr-units" v-model="settings.slopeUnits" class="field-select">
            <option value="degrees">Degrees</option>
            <option value="percent">Percent (rise / run × 100)</option>
          </select>
        </SettingsField>
      </SettingsStep>
      <SettingsStep step="2" title="Aspect" :effect="effects.aspect" :inactive="!has('aspect')">
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('aspect')" @change="toggle('aspect')" /> Make an
          <GlossaryTerm id="terrain-derivatives">aspect</GlossaryTerm> raster</label
        >
      </SettingsStep>
      <SettingsStep step="3" title="Hillshade" :effect="effects.hillshade" :inactive="!has('hillshade')">
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('hillshade')" @change="toggle('hillshade')" /> Make a
          <GlossaryTerm id="terrain-derivatives">hillshade</GlossaryTerm></label
        >
        <template v-if="has('hillshade')">
          <SettingsField
            label="Sun azimuth"
            label-for="tr-az"
            unit="°"
            hint="315 = from the north-west, the cartographic convention."
          >
            <input
              id="tr-az"
              v-model.number="settings.azimuth"
              :aria-invalid="numbers.bad.azimuth"
              type="number"
              min="0"
              max="360"
              step="5"
              class="field-input"
            />
          </SettingsField>
          <SettingsField label="Sun altitude" label-for="tr-alt" unit="°">
            <input
              id="tr-alt"
              v-model.number="settings.altitude"
              :aria-invalid="numbers.bad.altitude"
              type="number"
              min="1"
              max="90"
              step="5"
              class="field-input"
            />
          </SettingsField>
          <SettingsField hint="Blends four sun directions, so no slope disappears into shadow.">
            <label class="checkbox-row"
              ><input v-model="settings.multidirectional" type="checkbox" class="checkbox" /> Multidirectional</label
            >
          </SettingsField>
        </template>
      </SettingsStep>
      <SettingsStep step="4" title="Save" :effect="effects.save" :inactive="!settings.products.length">
        <SettingsField label="Compression" label-for="tr-comp">
          <select id="tr-comp" v-model="settings.compression" class="field-select">
            <option value="deflate">DEFLATE</option>
            <option value="none">None</option>
          </select>
        </SettingsField>
        <FileNameField v-model="fileName" :default-name="defaultName" />
      </SettingsStep>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button
        class="btn btn-primary"
        :disabled="!dem || geographic || !settings.products.length || !numbers.valid"
        :title="numbers.reason"
        @click="run"
      >
        Export
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
