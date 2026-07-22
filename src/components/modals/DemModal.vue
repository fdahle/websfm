<script setup>
import { ref } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import { DEM_DEFAULTS } from '../../core/defaults.user.js'

// Build DEM (Digital Surface Model). Rasterises the point cloud into a height
// grid in the chosen frame. Defaults are the single source of truth in
// core/defaults.user.js (core/products/dem.js keeps matching defensive fallbacks).
// `canGeoreference` / `projectCrs` come from the reconstruction store.
defineProps({
  canGeoreference: { type: Boolean, default: false },
  projectCrs: { type: String, default: null },
})

const emit = defineEmits(['close', 'run'])

const settings = ref({ ...DEM_DEFAULTS })

function run() {
  // Pass gsd only when set (0 ⇒ let the worker auto-suggest).
  const { gsd, ...rest } = settings.value
  emit('run', gsd > 0 ? { ...rest, gsd } : rest)
}
</script>

<template>
  <ModalShell title="Build DEM" @close="emit('close')">
    <SettingsField label-for="dem-crs"
      hint="Local uses a camera-estimated up-vector (up-to-scale); the project CRS fits a similarity to imported poses for real-world heights & GSD.">
      <template #label>
        <GlossaryTerm id="coordinate-reference-system">Coordinate frame</GlossaryTerm>
      </template>
      <select id="dem-crs" v-model="settings.crs" class="field-input field-select">
        <option value="local">Local (model units)</option>
        <option value="project" :disabled="!canGeoreference">
          {{ projectCrs || 'Project CRS' }}{{ canGeoreference ? '' : ' — needs camera poses' }}
        </option>
      </select>
    </SettingsField>

    <SettingsField label-for="dem-gsd"
      :unit="settings.crs === 'project' ? 'm/px' : 'units/px'"
      hint="Cell size. 0 = auto (≈ one point per cell). Smaller = finer & slower.">
      <template #label>
        <GlossaryTerm id="ground-sample-distance">Ground sample distance</GlossaryTerm>
      </template>
      <input id="dem-gsd" v-model.number="settings.gsd" type="number" min="0" step="0.1" class="field-input" />
    </SettingsField>

    <SettingsField label="Surface aggregation" label-for="dem-agg"
      hint="How multiple points in one cell collapse to a single height.">
      <select id="dem-agg" v-model="settings.aggregate" class="field-input field-select">
        <option value="max">Max (DSM — top surface)</option>
        <option value="median">Median (robust)</option>
        <option value="mean">Mean</option>
        <option value="min">Min (ground-ish)</option>
      </select>
    </SettingsField>

    <SettingsField label="Hole fill radius" label-for="dem-fill" unit="px"
      hint="Inverse-distance fill of empty cells within this radius. 0 = leave gaps.">
      <input id="dem-fill" v-model.number="settings.fillRadius" type="number" min="0" max="16" step="1" class="field-input" />
    </SettingsField>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" @click="run">Build DEM</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
/* DEM/aggregation selects read better full-width. */
.field-select { width: 100%; }
</style>
