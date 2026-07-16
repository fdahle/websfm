<script setup>
import { ref } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import { useComputeSettings } from '../../composables/useComputeSettings.js'
import { DENSE_FUSE_DEFAULTS } from '../../core/defaults.user.js'

const emit = defineEmits(['close', 'run'])

// Memory budget for the fusion pre-flight is machine-level (Settings ▸ Compute).
const { memBudgetGb } = useComputeSettings()

// Stage B — Build Dense Cloud (fuse depth maps). `depthTolPct` is exposed as a
// percentage; converted to the fraction core/dense/mvs.js fuseDepthMaps expects. In
// Auto mode minViews + maxCost are derived by fusion from the data.
// Defaults live in core/defaults.user.js; run() transforms depthTolPct (%) below.
const settings = ref({ ...DENSE_FUSE_DEFAULTS })

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
    memBudgetBytes: Math.max(0.25, memBudgetGb.value || 2) * 1024 * 1024 * 1024,
  })
}
</script>

<template>
  <ModalShell title="Build Dense Cloud" @close="emit('close')">
    <SettingsGroup title="Consistency">
      <SettingsField hint="Derive min-views and max-cost from the data. Turn off to set them by hand.">
        <template #label>Auto thresholds (recommended)</template>
        <label class="checkbox-row"><input v-model="settings.auto" type="checkbox" class="checkbox" /> Enabled</label>
      </SettingsField>

      <SettingsField v-if="!settings.auto" label="Min consistent views" label-for="minViews"
        hint="A point is kept only if this many other depth maps agree on it. Higher = cleaner, sparser.">
        <input id="minViews" v-model.number="settings.minViews" type="number" min="1" max="8" step="1" class="field-input" />
      </SettingsField>

      <SettingsField label="Depth agreement tolerance" label-for="depthTol" unit="%"
        hint="How closely a reprojected depth must match to count as agreement.">
        <input id="depthTol" v-model.number="settings.depthTolPct" type="number" min="0.1" max="10" step="0.1" class="field-input" />
      </SettingsField>

      <SettingsField v-if="!settings.auto" label="Max matching cost" label-for="maxCost"
        hint="Discard pixels whose PatchMatch cost exceeds this (0 = perfect … 2 = none). Lower = stricter.">
        <input id="maxCost" v-model.number="settings.maxCost" type="number" min="0.1" max="2" step="0.1" class="field-input" />
      </SettingsField>
    </SettingsGroup>

    <SettingsGroup title="Density">
      <SettingsField label="Point density (sample step)" label-for="step" unit="px"
        hint="Emit one point every N pixels. 1 = densest (largest cloud); higher = decimated.">
        <input id="step" v-model.number="settings.step" type="number" min="1" max="8" step="1" class="field-input" />
      </SettingsField>
    </SettingsGroup>

    <AdvancedDisclosure label="Geometric outlier filters">
      <SettingsGroup title="Outlier removal">
        <SettingsField label="Min triangulation angle" label-for="minTriAngle" unit="°"
          hint="Drop points whose agreeing views are near-parallel (sky, distant haze). 0 disables.">
          <input id="minTriAngle" v-model.number="settings.minTriAngleDeg" type="number" min="0" max="20" step="0.5" class="field-input" />
        </SettingsField>

        <SettingsField label="Max surface incidence angle" label-for="maxIncidence" unit="°"
          hint="Drop points seen edge-on (thin vegetation, silhouettes). 0 or 90 disables.">
          <input id="maxIncidence" v-model.number="settings.maxIncidenceDeg" type="number" min="0" max="90" step="5" class="field-input" />
        </SettingsField>

        <SettingsField hint="Drop lone low-support cells with too few neighbours (fusion flyers).">
          <template #label>Remove isolated points</template>
          <label class="checkbox-row"><input v-model="settings.removeIsolated" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>
      </SettingsGroup>
    </AdvancedDisclosure>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" @click="run">Build Dense Cloud</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
