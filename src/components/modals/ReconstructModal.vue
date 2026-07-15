<script setup>
import { ref, computed } from 'vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsSection from './ui/SettingsSection.vue'
import PresetSelector from './ui/PresetSelector.vue'
import { RECONSTRUCT_DEFAULTS, RECONSTRUCT_PRESETS } from '../../core/defaults.user.js'

const emit = defineEmits(['close', 'run'])

// Prefill from the single source of truth (core/sfm/sfm.js falls back to the same
// values). Clone so edits don't mutate the shared constant.
const settings = ref({ ...RECONSTRUCT_DEFAULTS })

// Quality presets are deltas over the defaults (medium ≡ defaults). `activePreset`
// derives from the current settings (so editing any field shows "Custom" automatically);
// clicking a chip applies that preset's resolved values.
const presetOptions = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
]
const resolvePreset = (id) => ({ ...RECONSTRUCT_DEFAULTS, ...RECONSTRUCT_PRESETS[id] })
const activePreset = computed(() => {
  for (const { id } of presetOptions) {
    const r = resolvePreset(id)
    if (Object.keys(r).every((k) => settings.value[k] === r[k])) return id
  }
  return 'custom'
})
function selectPreset(id) { settings.value = { ...resolvePreset(id) } }

function run() {
  emit('run', { ...settings.value })
}
</script>

<template>
  <ModalShell title="Sparse Reconstruction" @close="emit('close')">
    <PresetSelector :model-value="activePreset" :presets="presetOptions" @select="selectPreset" />

    <SettingsSection>
      <SettingsField label="Min correspondences for registration" label-for="minMatches" unit="pts"
        hint="Minimum 3D–2D pairs required to register a new camera via PnP.">
        <input
          id="minMatches"
          v-model.number="settings.minMatchesForRegistration"
          type="number" min="6" max="500" step="1"
          class="field-input"
        />
      </SettingsField>
    </SettingsSection>

    <SettingsSection>
      <SettingsField label-for="reprj" unit="px"
        hint="Inlier threshold for camera pose RANSAC. Lower = stricter.">
        <template #label>
          <GlossaryTerm id="reprojection-error">Reprojection threshold</GlossaryTerm>
          (PnP RANSAC)
        </template>
        <input
          id="reprj"
          v-model.number="settings.reprjThreshold"
          type="number" min="0.5" max="20" step="0.5"
          class="field-input"
        />
      </SettingsField>
    </SettingsSection>

    <SettingsSection>
      <SettingsField label-for="baIter" hint="Set to 0 to skip bundle adjustment.">
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
    </SettingsSection>

    <SettingsSection>
      <SettingsField label="Refine intrinsics (self-calibration)" label-for="refineIntr">
        <select id="refineIntr" v-model="settings.refineIntrinsics" class="field-input field-select">
          <option value="auto">Auto — self-calibrate focal + radial distortion for EXIF-only cameras (recommended)</option>
          <option value="none">Off (use sensor table)</option>
          <option value="f">Focal length</option>
          <option value="f,cxcy">Focal + principal point</option>
          <option value="f,k1">Focal + radial k1</option>
          <option value="f,cxcy,k1,k2,k3">Focal + principal point + radial k1,k2,k3</option>
        </select>
        <template #hint>
          Lets bundle adjustment solve one shared focal (and optionally principal point or
          radial coefficients) per sensor, in the post-filter passes only. Weakly observed
          on short/single strips — the refined value is logged, never written back to the
          sensor table. <b>Auto</b> stages focal + radial k1 → k2 / cx,cy / k3 as the model
          grows, unless the sensor already has a calibrated distortion model.
        </template>
      </SettingsField>
    </SettingsSection>

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
