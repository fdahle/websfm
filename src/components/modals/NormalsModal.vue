<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import WarnBox from './ui/WarnBox.vue'
import { NORMALS_DEFAULTS } from '../../core/defaults.user.js'
import { cameraCenter } from '../../core/sfm/geometry.js'

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
const sourceId = ref(props.clouds.some((c) => c.id === props.initialId) ? props.initialId : props.clouds[0]?.id ?? null)
const source = computed(() => props.clouds.find((c) => c.id === sourceId.value) ?? null)
const hasCameras = computed(() => (props.cameras?.size ?? 0) > 0)

// 'auto': a computed cloud shares the model frame with the cameras, so "towards the
// nearest camera" is right even for walls and overhangs; an imported cloud may sit
// in another frame entirely, so it gets +Z (an aerial survey's up).
const resolvedOrient = computed(() => {
  const o = settings.value.orient
  if (o !== 'auto') return o
  return !source.value?.imported && hasCameras.value ? 'cameras' : 'up'
})

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
    <WarnBox v-if="!clouds.length">No dense cloud yet. Build one with <strong>Dense Model</strong> or import one.</WarnBox>
    <template v-else>
      <SettingsGroup title="Source">
        <SettingsField label="Cloud" label-for="nrm-src" hint="Adds a new cloud with normals; this one is left untouched.">
          <select id="nrm-src" v-model="sourceId" class="field-select">
            <option v-for="c in clouds" :key="c.id" :value="c.id">
              {{ c.name }} — {{ c.count.toLocaleString() }} points{{ c.nrm ? ' · has normals' : '' }}
            </option>
          </select>
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title="Estimation">
        <SettingsField label="Neighbours" label-for="nrm-k"
          hint="Points in each local plane fit. More is smoother and slower; fewer keeps sharp edges.">
          <input id="nrm-k" v-model.number="settings.k" type="number" min="6" max="64" step="1" class="field-input" />
        </SettingsField>
        <SettingsField label="Point normals" label-for="nrm-orient"
          :hint="resolvedOrient === 'cameras' ? 'Each normal faces the nearest camera — right for walls and overhangs.'
            : resolvedOrient === 'up' ? 'Each normal faces upward (+Z) — right for terrain from above.'
            : 'Keeps the side the existing normals face, re-estimating only their direction.'">
          <select id="nrm-orient" v-model="settings.orient" class="field-select">
            <option value="auto">Automatic</option>
            <option value="cameras" :disabled="!hasCameras">Towards the cameras</option>
            <option value="up">Upwards (+Z)</option>
            <option value="existing" :disabled="!source?.nrm">Keep existing side</option>
          </select>
        </SettingsField>
      </SettingsGroup>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !(settings.k >= 6)" @click="run">Estimate</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
