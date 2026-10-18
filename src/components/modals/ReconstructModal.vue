<script setup>
import { ref, computed } from 'vue'
import FieldHelp from '../guide/FieldHelp.vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import PresetCards from './ui/PresetCards.vue'
import { useDatasetRecommendations } from '../../composables/useDatasetRecommendations.js'
import { usePresetSettings } from '../../composables/usePresetSettings.js'
import {
  RECONSTRUCT_DEFAULTS,
  RECONSTRUCT_PRESETS,
  RECONSTRUCT_PRESET_META,
} from '../../core/defaults.user.js'
import { checkNumberFields } from '../../utils/numberFields.js'

const props = defineProps({
  // Set when Georeference hands off here for its GCP-constrained adjustment path.
  // The reconstruction settings remain identical; only the framing and final action differ.
  groundControlAdjustment: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'run'])
const { recommendations } = useDatasetRecommendations()

// Prefill from the single source of truth (core/sfm/sfm.js falls back to the same
// values). Clone so edits don't mutate the shared constant.
const settings = ref({ ...RECONSTRUCT_DEFAULTS })
// Run stays disabled while a field is blank or out of range (rules = the inputs'
// own min/max/step).
const numbers = computed(() => checkNumberFields(settings.value, {
  minMatchesForRegistration: { label: 'Min correspondences', min: 6, max: 500, integer: true },
  reprjThreshold: { label: 'Reprojection threshold', min: 0.5, max: 20 },
  baIterations: { label: 'Bundle adjustment iterations', min: 0, max: 200, integer: true },
}))

// Quality presets are deltas over the defaults (medium ≡ defaults) and own the keys
// they patch (BA iterations, reprojection gate). `activePreset` derives from those
// (so editing one shows "· modified" automatically); `baseId` remembers which preset
// the current values came from, so the "· modified" tag + Reset target the right one.
// Every setting here is solver tuning, so a card (and Reset) restores all of them and
// any edit reads as "· modified" — unlike Match/Mesh, whose cards leave the
// orthogonal choices (pairing strategy, cleanup) alone.
const { baseId, activePreset, selectPreset } = usePresetSettings({
  settings, defaults: RECONSTRUCT_DEFAULTS, presets: RECONSTRUCT_PRESETS, cards: RECONSTRUCT_PRESET_META,
  ownedKeys: Object.keys(RECONSTRUCT_DEFAULTS),
})

// Self-calibration: short <option> labels + a hint that explains the selected mode
// (the long prose lives here, one selection at a time, instead of overflowing the option).
const SELF_CAL_HINTS = {
  auto: 'Stages focal + radial k1 → k2 / cx,cy / k3 (then k4 on a four-term fisheye) as the model grows — unless a sensor already carries a calibrated distortion model. Best for EXIF-only cameras and film scans.',
  none: 'Trust the sensor table as-is; bundle adjustment does not touch intrinsics.',
  f: 'Solve one shared focal length per sensor.',
  'f,cxcy': 'Solve focal length and principal point per sensor.',
  'f,k1': 'Solve focal length and the first radial distortion coefficient.',
  'f,cxcy,k1,k2,k3': 'Solve focal, principal point and all three radial coefficients (needs many well-spread views).',
  'f,cxcy,k1,k2,k3,k4': 'Solve focal, principal point and all four fisheye terms of a Fisheye (k1–k4) lens; on any other lens the same as k1,k2,k3.',
}
// U2 derives nothing to override here — `auto` already resolves per project inside
// core/sfm/sfm.js — but it does know WHICH branch this project will take. That is
// worth saying, so it extends the hint of the field it describes instead of
// occupying a banner that could never offer an action.
const selfCalHint = computed(() => {
  const base = SELF_CAL_HINTS[settings.value.refineIntrinsics] ?? ''
  const reason = recommendations.value.sfm?.refineIntrinsics?.reason
  if (settings.value.refineIntrinsics !== 'auto' || !reason) return base
  return `${base} This project: ${reason}`
})

function run() {
  emit('run', { ...settings.value })
}
</script>

<template>
  <ModalShell :title="props.groundControlAdjustment ? 'Adjust with Ground Control' : 'Sparse Reconstruction'" @close="emit('close')">
    <p v-if="props.groundControlAdjustment" class="adjust-intro">
      Rebuild the sparse model with the eligible GCPs included in bundle adjustment.
      When it succeeds, the model will automatically be fitted to the project CRS.
    </p>
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
            <FieldHelp op="sparse-reconstruction" param="minMatchesForRegistration" :value="settings.minMatchesForRegistration" :default-value="RECONSTRUCT_DEFAULTS.minMatchesForRegistration">Min correspondences</FieldHelp>
          </template>
          <input
            id="minMatches"
            v-model.number="settings.minMatchesForRegistration"
            :aria-invalid="numbers.bad.minMatchesForRegistration"
            type="number" min="6" max="500" step="1"
            class="field-input"
          />
        </SettingsField>

        <SettingsField label-for="reprj" unit="detection px"
          hint="Inlier threshold for camera-pose RANSAC. Lower = stricter. Measured at
                the detection resolution, so it scales automatically on downscaled images.">
          <template #label>
            <FieldHelp op="sparse-reconstruction" param="reprjThreshold" :value="settings.reprjThreshold" :default-value="RECONSTRUCT_DEFAULTS.reprjThreshold">Reprojection threshold</FieldHelp>
          </template>
          <input
            id="reprj"
            v-model.number="settings.reprjThreshold"
            :aria-invalid="numbers.bad.reprjThreshold"
            type="number" min="0.5" max="20" step="0.5"
            class="field-input"
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Optimization">
        <SettingsField label-for="baIter"
          hint="Bundle-adjustment iterations per pass. 0 skips bundle adjustment — and with it self-calibration.">
          <template #label>
            <FieldHelp op="sparse-reconstruction" param="baIterations" :value="settings.baIterations" :default-value="RECONSTRUCT_DEFAULTS.baIterations">Bundle adjustment iterations</FieldHelp>
          </template>
          <input
            id="baIter"
            v-model.number="settings.baIterations"
            :aria-invalid="numbers.bad.baIterations"
            type="number" min="0" max="200" step="5"
            class="field-input"
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Calibration">
        <SettingsField label-for="refineIntr">
          <template #label>
            <FieldHelp op="sparse-reconstruction" param="refineIntrinsics">Self-calibration</FieldHelp>
          </template>
          <!-- Self-calibration happens inside bundle adjustment; with 0 iterations it never runs. -->
          <select id="refineIntr" v-model="settings.refineIntrinsics" class="field-input field-select"
            :disabled="!(settings.baIterations > 0)">
            <option value="auto">Auto (recommended)</option>
            <option value="none">Off — use sensor table</option>
            <option value="f">Focal length</option>
            <option value="f,cxcy">Focal + principal point</option>
            <option value="f,k1">Focal + radial k1</option>
            <option value="f,cxcy,k1,k2,k3">Focal + principal point + k1,k2,k3</option>
            <option value="f,cxcy,k1,k2,k3,k4">Focal + principal point + k1–k4 (fisheye)</option>
          </select>
          <template #hint>{{ settings.baIterations > 0 ? selfCalHint
            : 'Not used: bundle adjustment is off (0 iterations), and self-calibration runs inside it.' }}</template>
        </SettingsField>
      </SettingsGroup>
    </AdvancedDisclosure>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!numbers.valid" :title="numbers.reason" @click="run">
        {{ props.groundControlAdjustment ? 'Adjust & Georeference' : 'Run Reconstruction' }}
      </button>
    </template>
  </ModalShell>
</template>

<!-- Field-control classes (.field-input/.field-select) style THIS modal's own inputs,
     which are passed as slot content (compiled in this component's scope, so scoped CSS
     applies here — not inside SettingsField). .btn lives in the global stylesheet. -->
<style scoped src="./ui/modal.css"></style>
<style scoped>
.adjust-intro { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text); }
</style>
