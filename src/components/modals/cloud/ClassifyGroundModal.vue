<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import NoSourceWarn from '../ui/NoSourceWarn.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import WarnBox from '../ui/WarnBox.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { useSourcePick, cloudOptionLabel } from '../../../composables/useSourcePick.js'
import { useComputeSettings } from '../../../composables/useComputeSettings.js'
import { GROUND_DEFAULTS } from '../../../core/defaults.user.js'
import { cloudUnits } from '../../../core/products/cloudUnits.js'
import { checkNumberFields } from '../../../utils/numberFields.js'

// Classify Ground (Tools ▸ Point Cloud ▾ ▸ Attributes) — labels every point of a
// dense cloud ground / above ground / low noise with a cloth simulation
// (core/products/groundFilter.js), so Build DEM ▸ Points ▸ Ground only can make a
// DTM. Adds a NEW cloud carrying a LAS `classification` attribute, coloured by it.
// The lengths are metres along the product vertical: the run handler resolves the
// frame (useDialogRuns groundRequest); a computed cloud without real-world scale
// is refused there, and this dialog says so before Run.
const props = defineProps({
  clouds: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
  // The store's currentFrameSignature: whether the project has metres at all.
  frameSignature: { type: Object, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...GROUND_DEFAULTS })
const { id: sourceId, item: source } = useSourcePick(() => props.clouds, { initialId: props.initialId })
// A streamed cloud's classes are in its octree's layout (it has no resident attributes).
const classified = (c) => !!c?.attributes?.classification || !!(c?.lod && !c.pos && c.lod.layout?.attributes?.some((a) => a.name === 'classification'))
const groundOptionLabel = (c) => `${cloudOptionLabel(c)}${classified(c) ? ' · classified' : ''}${c.lod && !c.pos ? ' · streamed' : ''}`
const units = computed(() => cloudUnits(source.value, props.frameSignature))
const noScale = computed(() => units.value.unit === 'model')
const { memBudgetBytes } = useComputeSettings()

const numbers = computed(() => checkNumberFields(settings.value, {
  clothResolution: { label: 'Cloth resolution', min: 0.05, max: 50 },
  classThreshold: { label: 'Ground tolerance', min: 0.01, max: 10 },
}))

function run() {
  emit('run', {
    sourceIds: [sourceId.value],
    settings: { ...settings.value, memBudgetBytes: memBudgetBytes.value },
    name: `${source.value?.name ?? 'Cloud'} (ground)`,
  })
}
</script>

<template>
  <ModalShell title="Classify Ground" @close="emit('close')">
    <NoSourceWarn v-if="!clouds.length" kind="cloud" />
    <template v-else>
      <SettingsGroup title="Source">
        <SourcePicker id="gnd-src" v-model="sourceId" label="Cloud" :items="clouds" :option-label="groundOptionLabel"
          hint="Adds a new cloud with every point classified; this one is left untouched." />
        <WarnBox v-if="noScale">
          This model has no real-world scale, so lengths in metres mean nothing yet.
          Georeference it or add scale bars first.
        </WarnBox>
        <WarnBox v-else-if="classified(source)">
          This cloud is already classified. The new cloud replaces those classes.
        </WarnBox>
        <p v-if="source?.imported" class="field-hint">
          An imported cloud is classified in its own coordinates: its z must point up, and its units are taken as metres.
        </p>
      </SettingsGroup>
      <SettingsGroup title="Cloth">
        <SettingsField label-for="gnd-res" unit="m"
          hint="Coarser spans wider roofs; finer follows steeper ground.">
          <template #label>
            <FieldHelp op="classify-ground" param="clothResolution" :value="settings.clothResolution"
              :default-value="GROUND_DEFAULTS.clothResolution">Cloth resolution</FieldHelp>
          </template>
          <input id="gnd-res" v-model.number="settings.clothResolution" :aria-invalid="numbers.bad.clothResolution"
            type="number" min="0.05" max="50" step="0.5" class="field-input" />
        </SettingsField>
        <SettingsField label-for="gnd-rigid" hint="How stiff the cloth is: steep ground needs a soft cloth.">
          <template #label><FieldHelp op="classify-ground" param="rigidness">Terrain</FieldHelp></template>
          <select id="gnd-rigid" v-model.number="settings.rigidness" class="field-input field-select">
            <option :value="1">Steep slopes (soft cloth)</option>
            <option :value="2">Rolling relief</option>
            <option :value="3">Flat (stiff cloth)</option>
          </select>
        </SettingsField>
        <SettingsField hint="Spread the cloth onto continuous steep ground it settled below.">
          <template #label>
            <FieldHelp op="classify-ground" param="slopeSmoothing" :value="settings.slopeSmoothing"
              :default-value="GROUND_DEFAULTS.slopeSmoothing">Slope smoothing</FieldHelp>
          </template>
          <label class="checkbox-row"><input v-model="settings.slopeSmoothing" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title="Classes">
        <SettingsField label-for="gnd-thr" unit="m" hint="Points this close to the cloth are ground.">
          <template #label>
            <FieldHelp op="classify-ground" param="classThreshold" :value="settings.classThreshold"
              :default-value="GROUND_DEFAULTS.classThreshold">Ground tolerance</FieldHelp>
          </template>
          <input id="gnd-thr" v-model.number="settings.classThreshold" :aria-invalid="numbers.bad.classThreshold"
            type="number" min="0.01" max="10" step="0.1" class="field-input" />
        </SettingsField>
        <SettingsField label-for="gnd-extent" hint="The same area a DEM covers by default.">
          <template #label><FieldHelp op="classify-ground" param="extent">Extent</FieldHelp></template>
          <select id="gnd-extent" v-model="settings.extent" class="field-input field-select">
            <option value="core">Dense core of the cloud</option>
            <option value="all">All points</option>
          </select>
        </SettingsField>
      </SettingsGroup>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || noScale || !numbers.valid"
        :title="noScale ? 'Needs a georeference or scale bars' : numbers.reason" @click="run">Classify</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.field-select { width: 100%; }
</style>
