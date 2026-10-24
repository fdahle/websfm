<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import NoSourceWarn from '../ui/NoSourceWarn.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import GlossaryTerm from '../../glossary/GlossaryTerm.vue'
import { useSourcePick, cloudOptionLabel } from '../../../composables/useSourcePick.js'
import { NORMALS_DEFAULTS } from '../../../core/defaults.user.js'
import { normalsEffects } from '../../../core/stepEffects/normals.js'
import { cameraCenter } from '../../../core/sfm/geometry.js'

// Estimate Normals (Tools ▸ Point Cloud ▾) — per-point normals from a local plane
// fit (core/products/cloudNormals.js). The point of it: an imported cloud usually
// arrives without normals, and the Poisson mesher cannot run without them. Adds a
// NEW cloud carrying the normals; positions and colour are unchanged.
const props = defineProps({
  clouds: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
  // The main sparse model's cameras (Map uuid → { R, t }), for "towards the cameras".
  cameras: { type: Object, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...NORMALS_DEFAULTS })
const { id: sourceId, item: source } = useSourcePick(() => props.clouds, { initialId: props.initialId })
const normalsOptionLabel = (c) => `${cloudOptionLabel(c)}${c.nrm ? ' · has normals' : ''}`
const hasCameras = computed(() => (props.cameras?.size ?? 0) > 0)

// 'auto': a computed cloud shares the model frame with the cameras, so "towards the
// nearest camera" is right even for walls and overhangs; an imported cloud may sit
// in another frame entirely, so it gets +Z (an aerial survey's up).
const resolvedOrient = computed(() => {
  const o = settings.value.orient
  if (o !== 'auto') return o
  return !source.value?.imported && hasCameras.value ? 'cameras' : 'up'
})
// What each step does to this cloud (core/stepEffects/normals.js).
const effects = computed(() =>
  normalsEffects(settings.value, { count: source.value?.count ?? 0, orient: resolvedOrient.value }),
)

function run() {
  const kind = resolvedOrient.value
  let orient
  if (kind === 'cameras') {
    const points = new Float64Array(props.cameras.size * 3)
    let i = 0
    for (const cam of props.cameras.values()) points.set(cameraCenter(cam), 3 * i++)
    orient = { kind: 'viewpoints', points }
  } else if (kind === 'existing') orient = { kind: 'existing' }
  else orient = { kind: 'up', up: [0, 0, 1] }
  emit('run', {
    sourceIds: [sourceId.value],
    settings: { k: settings.value.k, orient },
    name: `${source.value?.name ?? 'Cloud'} (normals)`,
  })
}
</script>

<template>
  <ModalShell title="Estimate Normals" @close="emit('close')">
    <NoSourceWarn v-if="!clouds.length" kind="cloud" />
    <template v-else>
      <SettingsGroup title="Source">
        <SourcePicker
          id="nrm-src"
          v-model="sourceId"
          label="Cloud"
          :items="clouds"
          :option-label="normalsOptionLabel"
          hint="Adds a new cloud with normals; this one is left untouched."
        />
      </SettingsGroup>
      <SettingsStep step="1" title="Fit local planes" :effect="effects.fit">
        <SettingsField
          label="Neighbours"
          label-for="nrm-k"
          hint="More is smoother and slower; fewer keeps sharp edges."
        >
          <input id="nrm-k" v-model.number="settings.k" type="number" min="6" max="64" step="1" class="field-input" />
        </SettingsField>
      </SettingsStep>
      <SettingsStep step="2" title="Orient" :effect="effects.orient">
        <SettingsField label-for="nrm-orient">
          <template #label><GlossaryTerm id="surface-normal">Point normals</GlossaryTerm> face</template>
          <select id="nrm-orient" v-model="settings.orient" class="field-select">
            <option value="auto">Automatic</option>
            <option value="cameras" :disabled="!hasCameras">Towards the cameras</option>
            <option value="up">Upwards (+Z)</option>
            <option value="existing" :disabled="!source?.nrm">Keep existing side</option>
          </select>
        </SettingsField>
      </SettingsStep>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !(settings.k >= 6)" @click="run">Estimate</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
