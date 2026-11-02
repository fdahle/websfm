<script setup>
import { ref, computed, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { TARGET_DEFAULTS } from '../../../core/defaults.user.js'
import { detectTargetsEffects } from '../../../core/stepEffects/detectTargets.js'
import { useDetectTargets } from '../../../composables/useDetectTargets.js'

// Detect Targets (Tools ▸ Images ▾): place the marks of GCPs with checkerboard mats where
// the model expects them (composables/useDetectTargets.js). The plan (which GCP is looked
// for in which photo) is made here, live, so the effect lines count the run.
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...TARGET_DEFAULTS })
const { plan } = useDetectTargets()
const planned = ref(null)
let seq = 0
watch(
  () => [settings.value.sizeM, settings.value.searchPx, settings.value.replaceDetected],
  async () => {
    const id = ++seq
    const p = await plan(settings.value)
    if (id === seq) planned.value = p
  },
  { immediate: true },
)
const effects = computed(() => detectTargetsEffects(settings.value, planned.value?.counts ?? {}))
const valid = computed(
  () =>
    settings.value.sizeM > 0 &&
    settings.value.searchPx >= 5 &&
    settings.value.minScore >= 0 &&
    settings.value.minScore <= 1,
)

function run() {
  emit('run', { settings: { ...settings.value }, plan: planned.value })
}
</script>

<template>
  <ModalShell title="Detect Targets" @close="emit('close')">
    <p class="field-hint">
      Finds the centre of each GCP's black-and-white checker mat in the photos where the model expects it, and places
      the GCP's mark there, marked as detected. Check them in <b>Edit GCPs</b>, then georeference again.
    </p>
    <SettingsStep step="1" title="Targets" :effect="effects.targets">
      <SettingsField label-for="dt-size" unit="m">
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
      <SettingsField label-for="dt-search" unit="px">
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
      <SettingsField label-for="dt-score">
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
      <label class="checkbox-row">
        <input v-model="settings.replaceDetected" type="checkbox" class="checkbox" />
        <FieldHelp op="detect-targets" param="replaceDetected">Replace earlier detections</FieldHelp>
      </label>
    </SettingsStep>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!valid || !planned?.counts.predictions" @click="run">
        Detect targets
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
