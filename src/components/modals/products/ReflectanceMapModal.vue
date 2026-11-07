<script setup>
import FieldHelp from '../../guide/FieldHelp.vue'
import { computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsPresetsMenu from '../ui/SettingsPresetsMenu.vue'
import { useDialogSettings } from '../../../composables/useDialogSettings.js'
import SettingsField from '../ui/SettingsField.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import WarnBox from '../ui/WarnBox.vue'
import ExperimentalBadge from '../../layout/ExperimentalBadge.vue'
import { REFLECTANCE_DEFAULTS } from '../../../core/defaults.user.js'
import { reflectanceEffects } from '../../../core/stepEffects/reflectance.js'
import { checkNumberFields } from '../../../utils/numberFields.js'

// Products ▸ Reflectance map — a multispectral camera's bands on the DEM, in reflectance
// (core/products/reflectanceMap.js). The map becomes a reference raster: Style bands…
// shows a band, a composite or an index such as NDVI.
const props = defineProps({
  // { label, bands, captures, panelCaptures, dls, thermal } of the project's rig, or null.
  rig: { type: Object, default: null },
  // The main DEM's record, or null.
  dem: { type: Object, default: null },
})
const emit = defineEmits(['close', 'run'])

const dialog = useDialogSettings('reflectance-map', REFLECTANCE_DEFAULTS)
const settings = dialog.settings
const unit = computed(() => (props.dem?.unit === 'model' ? 'model units' : props.dem?.unit || 'units'))
const numbers = computed(() => checkNumberFields(settings.value, { gsd: { label: 'Cell size', min: 0 } }))
const effects = computed(() => reflectanceEffects(settings.value, { rig: props.rig, dem: props.dem }))

function run() {
  dialog.remember()
  emit('run', { ...settings.value })
}
</script>

<template>
  <ModalShell title="Reflectance Map" @close="emit('close')">
    <template #header>
      <span class="modal-title">Reflectance Map <ExperimentalBadge id="reflectance" /></span>
      <SettingsPresetsMenu :dialog="dialog" />
    </template>
    <WarnBox v-if="!rig">No photo here is a band of a multispectral camera (MicaSense RedEdge or Altum).</WarnBox>
    <WarnBox v-else-if="!dem">Build a DEM first (<strong>Reconstruct ▸ DEM</strong>): the map lies on it.</WarnBox>
    <template v-else>
      <SettingsStep step="1" title="Calibrate" :effect="effects.calibration">
        <SettingsField label-for="rf-cal">
          <template #label><FieldHelp op="reflectance-map" param="calibration">Calibration</FieldHelp></template>
          <select id="rf-cal" v-model="settings.calibration" class="field-select">
            <option value="auto">Auto</option>
            <option value="panel+dls">Panel and sun sensor</option>
            <option value="panel">Panel</option>
            <option value="dls">Sun sensor</option>
            <option value="radiance">None (radiance)</option>
          </select>
        </SettingsField>
      </SettingsStep>
      <SettingsStep step="2" title="Map the bands" :effect="effects.grid">
        <SettingsField label-for="rf-gsd" :unit="unit" hint="0 = the reference band's own ground pixel.">
          <template #label
            ><FieldHelp op="reflectance-map" param="gsd" :value="settings.gsd" :default-value="REFLECTANCE_DEFAULTS.gsd"
              >Cell size</FieldHelp
            ></template
          >
          <input
            id="rf-gsd"
            v-model.number="settings.gsd"
            :aria-invalid="numbers.bad.gsd"
            type="number"
            min="0"
            step="any"
            class="field-input"
          />
        </SettingsField>
      </SettingsStep>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!rig || !dem || !numbers.valid" :title="numbers.reason" @click="run">
        Build reflectance map
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
