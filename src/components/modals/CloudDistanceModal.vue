<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import WarnBox from './ui/WarnBox.vue'
import { DISTANCE_DEFAULTS } from '../../core/defaults.user.js'

// Distance to Reference (Tools ▸ Point Cloud ▾) — per-point distance from a cloud to
// another cloud (nearest point) or to a mesh (exact, to the nearest triangle)
// (core/products/cloudDistance.js). The result is a NEW copy of the source with a
// `distance` attribute, coloured blue → white → red. The everyday use is change
// detection between two epochs, once they are aligned.
const props = defineProps({
  clouds: { type: Array, default: () => [] },
  references: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...DISTANCE_DEFAULTS })
const sourceId = ref(props.clouds.some((c) => c.id === props.initialId) ? props.initialId : props.clouds[0]?.id ?? null)
const source = computed(() => props.clouds.find((c) => c.id === sourceId.value) ?? null)
const refChoices = computed(() => props.references.filter((c) => c.id !== sourceId.value))
const referenceId = ref(refChoices.value[0]?.id ?? null)
const reference = computed(() => refChoices.value.find((c) => c.id === referenceId.value) ?? null)
const unitLabel = computed(() => (source.value?.imported ? 'file units' : 'model units'))
const signable = computed(() => reference.value && (reference.value.kind === 'mesh' || !!reference.value.nrm))

function run() {
  const s = settings.value
  emit('run', {
    sourceIds: [sourceId.value, referenceId.value],
    settings: { maxDistance: s.maxDistance > 0 ? s.maxDistance : 0, signed: !!s.signed && signable.value },
    name: `${source.value?.name ?? 'Cloud'} (distance)`,
  })
}
</script>

<template>
  <ModalShell title="Distance to Reference" @close="emit('close')">
    <WarnBox v-if="!clouds.length || !refChoices.length">Needs a dense cloud and another cloud or a mesh to measure against.</WarnBox>
    <template v-else>
      <SettingsGroup title="Clouds">
        <SettingsField label="Measure" label-for="dist-src" hint="Every point of this cloud gets a distance.">
          <select id="dist-src" v-model="sourceId" class="field-select">
            <option v-for="c in clouds" :key="c.id" :value="c.id">{{ c.name }} — {{ c.count.toLocaleString() }} points</option>
          </select>
        </SettingsField>
        <SettingsField label="To" label-for="dist-ref" hint="A mesh gives exact surface distances; a cloud gives distance to its nearest point.">
          <select id="dist-ref" v-model="referenceId" class="field-select">
            <option v-for="c in refChoices" :key="c.id" :value="c.id">{{ c.name }}{{ c.kind === 'mesh' ? ' (mesh)' : '' }}</option>
          </select>
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title="Distance">
        <SettingsField
          :hint="signable ? 'Positive above the reference surface, negative below — what change detection needs.'
            : 'Unsigned: the reference cloud has no normals. Estimate normals on it, or use a mesh, for a signed distance.'">
          <label class="checkbox-row"><input v-model="settings.signed" type="checkbox" class="checkbox" :disabled="!signable" /> Signed (above / below)</label>
        </SettingsField>
        <SettingsField label="Ignore beyond" label-for="dist-max" :unit="unitLabel" hint="Farther points get no value (shown grey). 0 = no limit.">
          <input id="dist-max" v-model.number="settings.maxDistance" type="number" min="0" step="any" class="field-input" />
        </SettingsField>
      </SettingsGroup>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !reference" @click="run">Compute</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
