<script setup>
import { ref, computed, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsPresetsMenu from '../ui/SettingsPresetsMenu.vue'
import { useDialogSettings } from '../../../composables/useDialogSettings.js'
import SettingsField from '../ui/SettingsField.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { TARGET_DEFAULTS } from '../../../core/defaults.user.js'
import { detectTargetsEffects } from '../../../core/stepEffects/detectTargets.js'
import { useDetectTargets, isTagKind } from '../../../composables/useDetectTargets.js'
import { ARUCO_DICTIONARIES } from '../../../core/sfm/tags/aruco.js'

// Detect Targets (Tools ▸ Images ▾): place the marks of GCPs with checkerboard mats where
// the model expects them, or of AprilTags or ArUco markers anywhere (composables/useDetectTargets.js). The
// plan (which GCP is looked for in which photo) is made here, live, so the effect lines
// count the run.
const emit = defineEmits(['close', 'run'])

// The last run's settings in this project, and saved presets (useDialogSettings).
const dialog = useDialogSettings('detect-targets', TARGET_DEFAULTS)
const settings = dialog.settings
const { plan } = useDetectTargets()
const planned = ref(null)
let seq = 0
watch(
  () => [settings.value.kind, settings.value.sizeM, settings.value.searchPx, settings.value.replaceDetected],
  async () => {
    const id = ++seq
    const p = await plan(settings.value)
    if (id === seq) planned.value = p
  },
  { immediate: true },
)
const effects = computed(() => detectTargetsEffects(settings.value, planned.value?.counts ?? {}))
const tags = computed(() => isTagKind(settings.value.kind))
const valid = computed(
  () =>
    tags.value ||
    (settings.value.sizeM > 0 &&
      settings.value.searchPx >= 5 &&
      settings.value.minScore >= 0 &&
      settings.value.minScore <= 1),
)
const runnable = computed(() => (tags.value ? planned.value?.counts.photos : planned.value?.counts.predictions) > 0)

function run() {
  dialog.remember()
  emit('run', { settings: { ...settings.value }, plan: planned.value })
}
</script>

<template>
  <ModalShell title="Detect Targets" @close="emit('close')">
    <template #header>
      <span class="modal-title">Detect Targets</span>
      <SettingsPresetsMenu :dialog="dialog" />
    </template>
    <p class="field-hint">
      Finds the centre of each GCP's target in the photos and places the GCP's mark there, marked as detected. Check
      them in <b>Edit GCPs</b>, then georeference again.
    </p>
    <SettingsStep step="1" title="Targets" :effect="effects.targets">
      <SettingsField label-for="dt-kind">
        <template #label><FieldHelp op="detect-targets" param="kind">Target type</FieldHelp></template>
        <select id="dt-kind" v-model="settings.kind" class="field-select">
          <option value="checker">Checker mat</option>
          <option value="apriltag">AprilTag 36h11</option>
          <option value="aruco">ArUco</option>
        </select>
      </SettingsField>
      <SettingsField v-if="settings.kind === 'aruco'" label-for="dt-dict">
        <template #label><FieldHelp op="detect-targets" param="arucoDict">Dictionary</FieldHelp></template>
        <select id="dt-dict" v-model="settings.arucoDict" class="field-select">
          <option v-for="d in ARUCO_DICTIONARIES" :key="d" :value="d">{{ d.toUpperCase() }}</option>
        </select>
      </SettingsField>
      <SettingsField v-if="!tags" label-for="dt-size" unit="m">
        <template #label
          ><FieldHelp op="detect-targets" param="sizeM" :value="settings.sizeM" :default-value="TARGET_DEFAULTS.sizeM"
            >Target size</FieldHelp
          ></template
        >
        <input
          id="dt-size"
          v-model.number="settings.sizeM"
          type="number"
          min="0.05"
          max="5"
          step="0.05"
          class="field-input"
        />
      </SettingsField>
    </SettingsStep>
    <SettingsStep step="2" title="Where to look" :effect="effects.search">
      <SettingsField v-if="!tags" label-for="dt-search" unit="px">
        <template #label
          ><FieldHelp
            op="detect-targets"
            param="searchPx"
            :value="settings.searchPx"
            :default-value="TARGET_DEFAULTS.searchPx"
            >Search radius</FieldHelp
          ></template
        >
        <input
          id="dt-search"
          v-model.number="settings.searchPx"
          type="number"
          min="5"
          max="300"
          step="5"
          class="field-input"
        />
      </SettingsField>
    </SettingsStep>
    <SettingsStep step="3" title="Marks" :effect="effects.marks">
      <SettingsField v-if="!tags" label-for="dt-score">
        <template #label
          ><FieldHelp
            op="detect-targets"
            param="minScore"
            :value="settings.minScore"
            :default-value="TARGET_DEFAULTS.minScore"
            >Minimum score</FieldHelp
          ></template
        >
        <input
          id="dt-score"
          v-model.number="settings.minScore"
          type="number"
          min="0"
          max="1"
          step="0.05"
          class="field-input"
        />
      </SettingsField>
      <label v-if="tags" class="checkbox-row">
        <input v-model="settings.addMarkers" type="checkbox" class="checkbox" />
        <FieldHelp op="detect-targets" param="addMarkers">Add markers for other tags</FieldHelp>
      </label>
      <label class="checkbox-row">
        <input v-model="settings.replaceDetected" type="checkbox" class="checkbox" />
        <FieldHelp op="detect-targets" param="replaceDetected">Replace earlier detections</FieldHelp>
      </label>
    </SettingsStep>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!valid || !runnable" @click="run">Detect targets</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
