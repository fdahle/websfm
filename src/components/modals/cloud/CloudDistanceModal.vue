<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import WarnBox from '../ui/WarnBox.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import GlossaryTerm from '../../glossary/GlossaryTerm.vue'
import { useSourcePick, referenceOptionLabel } from '../../../composables/useSourcePick.js'
import { DISTANCE_DEFAULTS } from '../../../core/defaults.user.js'
import { cloudDistanceEffects } from '../../../core/stepEffects/cloudDistance.js'

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
const { id: sourceId, item: source } = useSourcePick(() => props.clouds, { initialId: props.initialId })
// The reference is never the source: picking the current reference to measure
// re-picks another one rather than leaving "To" blank.
const {
  id: referenceId,
  item: reference,
  options: refChoices,
} = useSourcePick(() => props.references, { exclude: sourceId })
const unitLabel = computed(() => (source.value?.imported ? 'file units' : 'model units'))
const signable = computed(() => reference.value && (reference.value.kind === 'mesh' || !!reference.value.nrm))
// What each step does (core/stepEffects/cloudDistance.js).
const effects = computed(() =>
  cloudDistanceEffects(settings.value, {
    count: source.value?.count ?? 0,
    mesh: reference.value?.kind === 'mesh',
    signable: !!signable.value,
    unit: unitLabel.value,
  }),
)

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
    <WarnBox v-if="!clouds.length || !refChoices.length"
      >Needs a dense cloud and another cloud or a mesh to measure against.</WarnBox
    >
    <template v-else>
      <SettingsGroup title="Source">
        <SourcePicker
          id="dist-src"
          v-model="sourceId"
          label="Measure"
          :items="clouds"
          hint="Every point of this cloud gets a distance."
        />
        <SourcePicker
          id="dist-ref"
          v-model="referenceId"
          label="To"
          :items="refChoices"
          :option-label="referenceOptionLabel"
          hint="A mesh gives exact surface distances; a cloud gives distance to its nearest point."
        />
      </SettingsGroup>
      <SettingsStep step="1" title="Find the nearest" :effect="effects.nearest">
        <SettingsField label="Ignore beyond" label-for="dist-max" :unit="unitLabel" hint="0 = no limit.">
          <input
            id="dist-max"
            v-model.number="settings.maxDistance"
            type="number"
            min="0"
            step="any"
            class="field-input"
          />
        </SettingsField>
      </SettingsStep>
      <SettingsStep step="2" title="Sign" :effect="effects.sign" :inactive="!signable">
        <label class="checkbox-row"
          ><input v-model="settings.signed" type="checkbox" class="checkbox" :disabled="!signable" />
          <GlossaryTerm id="cloud-distance">Signed</GlossaryTerm> (above / below)</label
        >
      </SettingsStep>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !reference" @click="run">Compute</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
