<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import AdvancedDisclosure from '../ui/AdvancedDisclosure.vue'
import WarnBox from '../ui/WarnBox.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import GlossaryTerm from '../../glossary/GlossaryTerm.vue'
import { useSourcePick, referenceOptionLabel } from '../../../composables/useSourcePick.js'
import { ICP_DEFAULTS } from '../../../core/defaults.user.js'
import { cloudBounds, estimateSpacing } from '../../../core/products/cloudEdit.js'
import { checkNumberFields } from '../../../utils/numberFields.js'

// Align to Reference (Tools ▸ Point Cloud ▾) — ICP, point-to-plane where the
// reference has normals (core/products/cloudAlign.js `icpAlign`). It REFINES: the
// two clouds must already overlap within the correspondence radius — do a rough
// alignment first (Align by point pairs, Transform, or georeferencing). Adds the
// aligned source as a NEW cloud; the transform and RMS go to the log.
const props = defineProps({
  clouds: { type: Array, default: () => [] },
  // Candidate references: dense clouds and meshes.
  references: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...ICP_DEFAULTS })
const { id: sourceId, item: source } = useSourcePick(() => props.clouds, { initialId: props.initialId })
// The reference is never the source: picking the current reference to move re-picks
// another one rather than leaving "Onto" blank.
const { id: referenceId, item: reference, options: refChoices } = useSourcePick(() => props.references, { exclude: sourceId })
const unitLabel = computed(() => (source.value?.imported ? 'file units' : 'model units'))
const autoRadius = computed(() => (source.value ? 10 * (estimateSpacing(cloudBounds(source.value), source.value.count) || 1) : 0))
const pointToPlaneNote = computed(() => (reference.value && reference.value.kind !== 'mesh' && !reference.value.nrm
  ? 'The reference has no normals, so ICP runs point-to-point (slower to converge). Estimate normals on it first for point-to-plane.' : ''))
// Align stays disabled while a field is blank or out of range (rules = the inputs'
// own min/max/step). A radius of 0 is auto; blank is not.
const numbers = computed(() => checkNumberFields(settings.value, {
  maxDistance: { label: 'Search radius', min: 0 },
  maxIterations: { label: 'Iterations', min: 1, max: 200, integer: true },
  sampleCount: { label: 'Sample points', min: 1000, integer: true },
}))

function run() {
  const s = settings.value
  emit('run', {
    sourceIds: [sourceId.value, referenceId.value],
    settings: {
      maxIterations: s.maxIterations, maxDistance: s.maxDistance > 0 ? s.maxDistance : 0,
      sampleCount: s.sampleCount, pointToPlane: !!s.pointToPlane, estimateScale: !!s.estimateScale,
      unitLabel: unitLabel.value,
    },
    name: `${source.value?.name ?? 'Cloud'} (aligned)`,
  })
}
</script>

<template>
  <ModalShell title="Align to Reference (ICP)" @close="emit('close')">
    <WarnBox v-if="!clouds.length || !refChoices.length">ICP needs a dense cloud to move and another cloud or a mesh to align it to.</WarnBox>
    <template v-else>
      <SettingsGroup title="Clouds">
        <SourcePicker id="icp-src" v-model="sourceId" label="Move" :items="clouds"
          hint="This cloud is aligned; a new aligned copy is added." />
        <SourcePicker id="icp-ref" v-model="referenceId" label="Onto" :items="refChoices" :option-label="referenceOptionLabel"
          hint="The reference stays where it is." />
      </SettingsGroup>
      <SettingsGroup title="Matching">
        <SettingsField label="Search radius" label-for="icp-radius" :unit="unitLabel"
          :hint="`Pairs farther apart are ignored. 0 = auto (${autoRadius.toPrecision(3)}, ten point spacings). Must exceed the current misalignment.`">
          <input id="icp-radius" v-model.number="settings.maxDistance" :aria-invalid="numbers.bad.maxDistance" type="number" min="0" step="any" class="field-input" />
        </SettingsField>
        <SettingsField hint="For clouds from different sensors or reconstructions with a scale mismatch. Point-to-point constrains scale better on flat scenes.">
          <label class="checkbox-row"><input v-model="settings.estimateScale" type="checkbox" class="checkbox" /> Also fit scale</label>
        </SettingsField>
      </SettingsGroup>
      <AdvancedDisclosure label="Advanced settings">
        <SettingsGroup title="Solver">
          <SettingsField label="Iterations" label-for="icp-it">
            <input id="icp-it" v-model.number="settings.maxIterations" :aria-invalid="numbers.bad.maxIterations" type="number" min="1" max="200" step="1" class="field-input" />
          </SettingsField>
          <SettingsField label="Sample points" label-for="icp-n" hint="Points of the moving cloud used per iteration.">
            <input id="icp-n" v-model.number="settings.sampleCount" :aria-invalid="numbers.bad.sampleCount" type="number" min="1000" step="10000" class="field-input" />
          </SettingsField>
          <SettingsField>
            <label class="checkbox-row"><input v-model="settings.pointToPlane" type="checkbox" class="checkbox" /> <GlossaryTerm id="icp">Point-to-plane</GlossaryTerm> (when the reference has normals)</label>
          </SettingsField>
        </SettingsGroup>
      </AdvancedDisclosure>
      <p v-if="pointToPlaneNote" class="field-hint">{{ pointToPlaneNote }}</p>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !reference || !numbers.valid" :title="numbers.reason" @click="run">Align</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
