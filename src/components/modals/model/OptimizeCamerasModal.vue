<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import WarnBox from '../ui/WarnBox.vue'
import { optimizeCamerasEffects } from '../../../core/stepEffects/optimizeCameras.js'

// Optimize Cameras (Tools ▸ Model ▾) — re-run bundle adjustment on the finished
// sparse model with the focal length (and optionally the principal point) free,
// shared per sensor, held to the GCPs and camera priors the reconstruction used
// (core/sfm/gradualSelection.js `optimizeCameras`). The usual step after adding
// control points or cleaning the tie points. Radial distortion stays as the
// reconstruction calibrated it — refining it here would desynchronise dense.
const props = defineProps({
  // The main sparse model (the one downstream stages consume).
  cloud: { type: Object, default: null },
  gcpCount: { type: Number, default: 0 },
})
const emit = defineEmits(['close', 'run'])

const refine = ref('f')
// What the step does to the model (core/stepEffects/optimizeCameras.js).
const effects = computed(() =>
  optimizeCamerasEffects(
    { refine: refine.value },
    { cameras: props.cloud?.cameras.size ?? 0, points: props.cloud?.points?.length ?? 0, gcps: props.gcpCount },
  ),
)

function run() {
  emit('run', {
    sourceIds: [props.cloud.id],
    settings: { refine: refine.value, createdAt: props.cloud.createdAt },
  })
}
</script>

<template>
  <ModalShell title="Optimize Cameras" @close="emit('close')">
    <WarnBox v-if="!cloud">Build the sparse model first.</WarnBox>
    <template v-else>
      <SettingsGroup title="Source">
        <p class="source-line">
          <strong>{{ cloud.name }}</strong>
        </p>
      </SettingsGroup>
      <SettingsStep step="1" title="Re-adjust the cameras" :effect="effects.refine">
        <SettingsField
          label="Free parameters"
          label-for="opt-refine"
          hint="The principal point needs a well-spread, strongly overlapping block."
        >
          <select id="opt-refine" v-model="refine" class="field-select">
            <option value="f">Focal length</option>
            <option value="f,cxcy">Focal length + principal point</option>
          </select>
        </SettingsField>
      </SettingsStep>
      <WarnBox>
        The model is replaced in place, so everything computed from it is cleared as after a new reconstruction: depth
        maps, the dense cloud and mesh, DEM and orthophoto, and the georeference and scale fit (both refit on demand).
        Imported data and your edited copies are kept.
      </WarnBox>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!cloud" @click="run">Optimize</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.source-line {
  font-size: 13px;
  color: var(--text);
}
</style>
