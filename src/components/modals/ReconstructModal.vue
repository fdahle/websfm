<script setup>
import { ref, computed } from 'vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import PresetCards from './ui/PresetCards.vue'
import {
  RECONSTRUCT_DEFAULTS,
  RECONSTRUCT_PRESETS,
  RECONSTRUCT_PRESET_META,
} from '../../core/defaults.user.js'

const emit = defineEmits(['close', 'run'])

// Prefill from the single source of truth (core/sfm/sfm.js falls back to the same
// values). Clone so edits don't mutate the shared constant.
const settings = ref({ ...RECONSTRUCT_DEFAULTS })

// Quality presets are deltas over the defaults (medium ≡ defaults). `activePreset`
// derives from the current settings (so editing any field shows "Custom" automatically).
// `baseId` remembers which preset the current (possibly-edited) values came from, so the
// "· modified" tag + Reset target the right one.
const resolvePreset = (id) => ({ ...RECONSTRUCT_DEFAULTS, ...RECONSTRUCT_PRESETS[id] })
const baseId = ref('medium')
const activePreset = computed(() => {
  for (const { id } of RECONSTRUCT_PRESET_META) {
    const r = resolvePreset(id)
    if (Object.keys(r).every((k) => settings.value[k] === r[k])) return id
  }
  return 'custom'
})
function selectPreset(id) {
  settings.value = { ...resolvePreset(id) }
  baseId.value = id
}

// Self-calibration: short <option> labels + a hint that explains the selected mode
// (the long prose lives here, one selection at a time, instead of overflowing the option).
const SELF_CAL_HINTS = {
  auto: 'Stages focal + radial k1 → k2 / cx,cy / k3 as the model grows — unless a sensor already carries a calibrated distortion model. Best for EXIF-only cameras and film scans.',
  none: 'Trust the sensor table as-is; bundle adjustment does not touch intrinsics.',
  f: 'Solve one shared focal length per sensor.',
  'f,cxcy': 'Solve focal length and principal point per sensor.',
  'f,k1': 'Solve focal length and the first radial distortion coefficient.',
  'f,cxcy,k1,k2,k3': 'Solve focal, principal point and all three radial coefficients (needs many well-spread views).',
}
const selfCalHint = computed(() => SELF_CAL_HINTS[settings.value.refineIntrinsics] ?? '')

function run() {
  emit('run', { ...settings.value })
}
</script>

<template>
  <ModalShell title="Sparse Reconstruction" @close="emit('close')">
    <PresetCards
      :model-value="activePreset"
      :base-id="baseId"
      :presets="RECONSTRUCT_PRESET_META"
      @select="selectPreset"
    />

    <AdvancedDisclosure label="Advanced settings">
      <SettingsGroup title="Registration">
        <SettingsField label-for="minMatches" unit="pts"
          hint="Minimum 3D–2D pairs required to register a new camera via PnP.">
          <template #label>
            <GlossaryTerm id="pnp">Min correspondences</GlossaryTerm>
          </template>
          <input
            id="minMatches"
            v-model.number="settings.minMatchesForRegistration"
            type="number" min="6" max="500" step="1"
            class="field-input"
          />
        </SettingsField>

        <SettingsField label-for="reprj" unit="px"
          hint="Inlier threshold for camera-pose RANSAC. Lower = stricter.">
          <template #label>
            <GlossaryTerm id="reprojection-error">Reprojection threshold</GlossaryTerm>
          </template>
          <input
            id="reprj"
            v-model.number="settings.reprjThreshold"
            type="number" min="0.5" max="20" step="0.5"
            class="field-input"
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Optimization">
        <SettingsField label-for="baIter"
          hint="Bundle-adjustment iterations per pass. Set to 0 to skip bundle adjustment.">
          <template #label>
            <GlossaryTerm id="bundle-adjustment">Bundle adjustment</GlossaryTerm> iterations
          </template>
          <input
            id="baIter"
            v-model.number="settings.baIterations"
            type="number" min="0" max="200" step="5"
            class="field-input"
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Calibration">
        <SettingsField label-for="refineIntr">
          <template #label>
            <GlossaryTerm id="self-calibration">Self-calibration</GlossaryTerm>
          </template>
          <select id="refineIntr" v-model="settings.refineIntrinsics" class="field-input field-select">
            <option value="auto">Auto (recommended)</option>
            <option value="none">Off — use sensor table</option>
            <option value="f">Focal length</option>
            <option value="f,cxcy">Focal + principal point</option>
            <option value="f,k1">Focal + radial k1</option>
            <option value="f,cxcy,k1,k2,k3">Focal + principal point + k1,k2,k3</option>
          </select>
          <template #hint>{{ selfCalHint }}</template>
        </SettingsField>
      </SettingsGroup>
    </AdvancedDisclosure>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" @click="run">Run Reconstruction</button>
    </template>
  </ModalShell>
</template>

<!-- Field-control classes (.field-input/.field-select) style THIS modal's own inputs,
     which are passed as slot content (compiled in this component's scope, so scoped CSS
     applies here — not inside SettingsField). .btn lives in the global stylesheet. -->
<style scoped src="./ui/modal.css"></style>
