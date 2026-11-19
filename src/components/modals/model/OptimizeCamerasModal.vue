<script setup>
import FieldHelp from '../../guide/FieldHelp.vue'
import { OPTIMIZE_CAMERAS_DEFAULTS } from '../../../core/defaults.user.js'
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import WarnBox from '../ui/WarnBox.vue'
import { optimizeCamerasEffects } from '../../../core/stepEffects/optimizeCameras.js'
import { t } from '../../../composables/useI18n.js'
import I18nText from '../../I18nText.vue'

// Optimize Cameras (Tools ▸ Model ▾) — re-run bundle adjustment on the finished
// sparse model with the focal length (and optionally the principal point) free,
// shared per sensor, held to the GCPs and camera priors the reconstruction used
// (core/sfm/gradualSelection.js `optimizeCameras`). The usual step after adding
// control points or cleaning the tie points. Focal length (+ principal point) keep the
// lens as calibrated; Full lens solves it too, and the solved lens becomes the model's
// (stores/reconstruction/cloudEdits.js), so dense and the GCP marks follow it.
const props = defineProps({
  // The main sparse model (the one downstream stages consume).
  cloud: { type: Object, default: null },
  gcpCount: { type: Number, default: 0 },
})
const emit = defineEmits(['close', 'run'])

const refine = ref(OPTIMIZE_CAMERAS_DEFAULTS.refine)
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
  <ModalShell :title="t('optimizeCameras.title')" @close="emit('close')">
    <WarnBox v-if="!cloud">{{ t('optimizeCameras.noModel') }}</WarnBox>
    <template v-else>
      <SettingsGroup :title="t('optimizeCameras.source')">
        <p class="source-line">
          <strong>{{ cloud.name }}</strong>
        </p>
      </SettingsGroup>
      <SettingsStep step="1" :title="t('optimizeCameras.step')" :effect="effects.refine">
        <SettingsField label-for="opt-refine" :hint="t('optimizeCameras.hint')">
          <template #label
            ><FieldHelp op="optimize-cameras" param="refine">{{
              t('optimizeCameras.freeParameters')
            }}</FieldHelp></template
          >
          <select id="opt-refine" v-model="refine" class="field-select">
            <option value="f">{{ t('optimizeCameras.refine.f') }}</option>
            <option value="f,cxcy">{{ t('optimizeCameras.refine.fcxcy') }}</option>
            <option value="full">{{ t('optimizeCameras.refine.full') }}</option>
          </select>
        </SettingsField>
      </SettingsStep>
      <WarnBox><I18nText k="optimizeCameras.replaces" /></WarnBox>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">{{ t('optimizeCameras.cancel') }}</button>
      <button
        class="btn btn-primary"
        :disabled="!cloud"
        :title="cloud ? null : t('optimizeCameras.needsModel')"
        @click="run"
      >
        {{ t('optimizeCameras.run') }}
      </button>
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
