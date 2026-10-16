<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import FieldHelp from '../guide/FieldHelp.vue'
import { useComputeSettings } from '../../composables/useComputeSettings.js'
import { DENSE_FUSE_DEFAULTS } from '../../core/defaults.user.js'
import { checkNumberFields } from '../../utils/numberFields.js'

const emit = defineEmits(['close', 'run'])

// Memory budget for the fusion pre-flight is machine-level (Settings ▸ Compute).
const { memBudgetBytes } = useComputeSettings()

// Stage B — Build Dense Cloud (fuse depth maps). `depthTolPct` is exposed as a
// percentage; converted to the fraction core/dense/mvs.js fuseDepthMaps expects. In
// Auto mode fusion picks minViews (from the map count) and the default maxCost.
// Defaults live in core/defaults.user.js; run() transforms depthTolPct (%) below.
// No dataset recommendation here by design: `auto` picks minViews from the map count,
// maxCost is a fixed loose backstop, and the geometric gates are dataset-independent
// (core/recommend.js `recommendFuse`). An empty banner is worse than none.
const settings = ref({ ...DENSE_FUSE_DEFAULTS })
// Run stays disabled while a field is blank or out of range (rules = the inputs'
// own min/max/step); the hidden manual thresholds are only checked when shown.
const numbers = computed(() => checkNumberFields(settings.value, {
  minViews: { label: 'Min consistent views', min: 1, max: 8, integer: true, when: !settings.value.auto },
  depthTolPct: { label: 'Depth agreement tolerance', min: 0.1, max: 10 },
  maxCost: { label: 'Max matching cost', min: 0.1, max: 2, when: !settings.value.auto },
  step: { label: 'Point density', min: 1, max: 8, integer: true },
  minTriAngleDeg: { label: 'Min triangulation angle', min: 0, max: 20 },
  maxIncidenceDeg: { label: 'Max surface incidence angle', min: 0, max: 90 },
}))

function run() {
  const { auto, minViews, depthTolPct, maxCost, step, minTriAngleDeg, maxIncidenceDeg, removeIsolated } = settings.value
  emit('run', {
    minViews: auto ? null : minViews,
    maxCost: auto ? null : maxCost,
    depthTolRel: depthTolPct / 100,
    step,
    minTriAngleDeg,
    maxIncidenceDeg,
    removeIsolated,
    memBudgetBytes: memBudgetBytes.value,
  })
}
</script>

<template>
  <ModalShell title="Build Dense Cloud" @close="emit('close')">
    <SettingsGroup title="Consistency">
      <SettingsField hint="Min-views from the image count, the default cost gate. Turn off to set them by hand.">
        <template #label><FieldHelp op="dense-cloud" param="auto" :value="settings.auto" :default-value="DENSE_FUSE_DEFAULTS.auto">Auto thresholds</FieldHelp> (recommended)</template>
        <label class="checkbox-row"><input v-model="settings.auto" type="checkbox" class="checkbox" /> Enabled</label>
      </SettingsField>

      <SettingsField v-if="!settings.auto" label-for="minViews"
        hint="A point is kept only if this many other depth maps agree on it. Higher = cleaner, sparser.">
        <template #label><FieldHelp op="dense-cloud" param="minViews" :value="settings.minViews" :default-value="DENSE_FUSE_DEFAULTS.minViews">Min consistent views</FieldHelp></template>
        <input id="minViews" v-model.number="settings.minViews" :aria-invalid="numbers.bad.minViews" type="number" min="1" max="8" step="1" class="field-input" />
      </SettingsField>

      <SettingsField label-for="depthTol" unit="%"
        hint="How closely a reprojected depth must match to count as agreement.">
        <template #label><FieldHelp op="dense-cloud" param="depthTolPct" :value="settings.depthTolPct" :default-value="DENSE_FUSE_DEFAULTS.depthTolPct">Depth agreement tolerance</FieldHelp></template>
        <input id="depthTol" v-model.number="settings.depthTolPct" :aria-invalid="numbers.bad.depthTolPct" type="number" min="0.1" max="10" step="0.1" class="field-input" />
      </SettingsField>

      <SettingsField v-if="!settings.auto" label-for="maxCost"
        hint="Discard pixels whose PatchMatch cost exceeds this (0 = perfect … 2 = none). Lower = stricter.">
        <template #label><FieldHelp op="dense-cloud" param="maxCost" :value="settings.maxCost" :default-value="DENSE_FUSE_DEFAULTS.maxCost">Max matching cost</FieldHelp></template>
        <input id="maxCost" v-model.number="settings.maxCost" :aria-invalid="numbers.bad.maxCost" type="number" min="0.1" max="2" step="0.1" class="field-input" />
      </SettingsField>
    </SettingsGroup>

    <SettingsGroup title="Density">
      <SettingsField label-for="step" unit="px"
        hint="Emit one point every N pixels. 1 = densest (largest cloud); higher = decimated.">
        <template #label>
          <FieldHelp op="dense-cloud" param="step" :value="settings.step" :default-value="DENSE_FUSE_DEFAULTS.step">Point density (sample step)</FieldHelp>
        </template>
        <input id="step" v-model.number="settings.step" :aria-invalid="numbers.bad.step" type="number" min="1" max="8" step="1" class="field-input" />
      </SettingsField>
    </SettingsGroup>

    <AdvancedDisclosure label="Geometric outlier filters">
      <SettingsGroup title="Outlier removal">
        <SettingsField label-for="minTriAngle" unit="°"
          hint="Drop points whose agreeing views are near-parallel (sky, distant haze). 0 disables.">
          <template #label><FieldHelp op="dense-cloud" param="minTriAngleDeg" :value="settings.minTriAngleDeg" :default-value="DENSE_FUSE_DEFAULTS.minTriAngleDeg">Min triangulation angle</FieldHelp></template>
          <input id="minTriAngle" v-model.number="settings.minTriAngleDeg" :aria-invalid="numbers.bad.minTriAngleDeg" type="number" min="0" max="20" step="0.5" class="field-input" />
        </SettingsField>

        <SettingsField label-for="maxIncidence" unit="°"
          hint="Drop points seen edge-on (thin vegetation, silhouettes). 0 or 90 disables.">
          <template #label><FieldHelp op="dense-cloud" param="maxIncidenceDeg" :value="settings.maxIncidenceDeg" :default-value="DENSE_FUSE_DEFAULTS.maxIncidenceDeg">Max surface incidence angle</FieldHelp></template>
          <input id="maxIncidence" v-model.number="settings.maxIncidenceDeg" :aria-invalid="numbers.bad.maxIncidenceDeg" type="number" min="0" max="90" step="5" class="field-input" />
        </SettingsField>

        <SettingsField hint="Drop lone low-support cells with too few neighbours (fusion flyers).">
          <template #label><FieldHelp op="dense-cloud" param="removeIsolated" :value="settings.removeIsolated" :default-value="DENSE_FUSE_DEFAULTS.removeIsolated">Remove isolated points</FieldHelp></template>
          <label class="checkbox-row"><input v-model="settings.removeIsolated" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>
      </SettingsGroup>
    </AdvancedDisclosure>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!numbers.valid" :title="numbers.reason" @click="run">Build Dense Cloud</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
