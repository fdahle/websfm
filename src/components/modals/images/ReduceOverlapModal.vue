<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { REDUCE_OVERLAP_DEFAULTS } from '../../../core/defaults.user.js'
import { isImageEnabled } from '../../../core/imageEnabled.js'
import { overlapVisibility, chooseOverlapSubset } from '../../../core/sfm/reduceOverlap.js'
import { reduceOverlapEffects } from '../../../core/stepEffects/reduceOverlap.js'

// Reduce Overlap (Tools ▸ Images ▾): disable the photos of the main model that a
// heavily overlapping block does not need for depth maps (core/sfm/reduceOverlap.js).
// The choice is made here, live, so the effect line is the run's result; Run disables
// them (core/imageEnabled.js), and Enable in the image list brings any back.
const props = defineProps({
  cloud: { type: Object, default: null },
  images: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...REDUCE_OVERLAP_DEFAULTS })

// The enabled photos with a pose, in image-list order, with their frame size.
const cameras = computed(() => {
  const cams = props.cloud?.cameras
  if (!cams) return []
  const out = []
  for (const img of props.images) {
    const cam = cams.get(img.uuid)
    if (!cam || !isImageEnabled(img)) continue
    out.push({
      id: img.id,
      uuid: img.uuid,
      R: cam.R,
      t: cam.t,
      K: cam.K,
      width: img.meta?.width || Math.round(2 * (cam.K.cx + 0.5)),
      height: img.meta?.height || Math.round(2 * (cam.K.cy + 0.5)),
    })
  }
  return out
})
const disabledPosed = computed(() => {
  const cams = props.cloud?.cameras
  return cams ? props.images.filter((img) => cams.has(img.uuid) && !isImageEnabled(img)).length : 0
})
const angleOk = computed(() => settings.value.maxAngle > 0 && settings.value.maxAngle <= 90)
const coverageOk = computed(() => Number.isInteger(settings.value.coverage) && settings.value.coverage >= 1)
// 10,000 sampled points: enough to stand in for the surface, and quick enough to count
// again as a setting changes.
const visibility = computed(() =>
  angleOk.value && cameras.value.length && props.cloud?.points
    ? overlapVisibility(props.cloud.points, cameras.value, { maxAngle: settings.value.maxAngle, maxPoints: 10000 })
    : null,
)
const keep = computed(() =>
  visibility.value && coverageOk.value
    ? chooseOverlapSubset(visibility.value, cameras.value.length, { coverage: settings.value.coverage })
    : null,
)
const kept = computed(() => (keep.value ? keep.value.reduce((a, b) => a + b, 0) : null))
const effects = computed(() =>
  reduceOverlapEffects(settings.value, {
    enabled: cameras.value.length,
    disabled: disabledPosed.value,
    points: visibility.value?.points ?? 0,
    kept: kept.value,
  }),
)
const toDisable = computed(() => (keep.value ? cameras.value.filter((c, i) => !keep.value[i]) : []))

function run() {
  emit('run', {
    disableIds: toDisable.value.map((c) => c.id),
    kept: kept.value,
    enabled: cameras.value.length,
    coverage: settings.value.coverage,
  })
}
</script>

<template>
  <ModalShell title="Reduce Overlap" @close="emit('close')">
    <p class="field-hint">
      Disables the photos of the main model that the depth maps do not need, keeping enough to see every part of the
      surface. Their features, matches and poses stay; <b>Enable</b> in the image list brings any back.
    </p>
    <SettingsStep step="1" title="Which photos see each point" :effect="effects.visibility">
      <SettingsField label-for="ro-angle" unit="°">
        <template #label
          ><FieldHelp
            op="reduce-overlap"
            param="maxAngle"
            :value="settings.maxAngle"
            :default-value="REDUCE_OVERLAP_DEFAULTS.maxAngle"
            >Viewing angle</FieldHelp
          ></template
        >
        <input
          id="ro-angle"
          v-model.number="settings.maxAngle"
          type="number"
          min="10"
          max="90"
          step="5"
          class="field-input"
        />
      </SettingsField>
    </SettingsStep>
    <SettingsStep step="2" title="Photos kept per point" :effect="effects.coverage">
      <SettingsField label-for="ro-coverage">
        <template #label
          ><FieldHelp
            op="reduce-overlap"
            param="coverage"
            :value="settings.coverage"
            :default-value="REDUCE_OVERLAP_DEFAULTS.coverage"
            >Photos per point</FieldHelp
          ></template
        >
        <input
          id="ro-coverage"
          v-model.number="settings.coverage"
          type="number"
          min="1"
          max="20"
          step="1"
          class="field-input"
        />
      </SettingsField>
    </SettingsStep>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!toDisable.length" @click="run">
        Disable {{ toDisable.length || '' }} {{ toDisable.length === 1 ? 'photo' : 'photos' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
