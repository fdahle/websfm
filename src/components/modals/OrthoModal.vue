<script setup>
import { ref } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import { ORTHO_DEFAULTS } from '../../core/defaults.user.js'

// Build Orthophoto. Reprojects each DEM cell through the cached depth maps
// (occlusion via their depth planes, colour from their RGB planes). Requires a
// DEM (built first) and depth maps. Defaults are the single source of truth in
// core/defaults.user.js; run() transforms depthTolRel (%) and maxCost (0 ⇒ Infinity).
defineProps({
  demCrs: { type: String, default: null },   // frame the DEM was built in (label only)
  demSize: { type: String, default: null },  // e.g. "1024×768" (label only)
})

const emit = defineEmits(['close', 'run'])

const settings = ref({ ...ORTHO_DEFAULTS })

function run() {
  const { depthTolRel, maxCost, ...rest } = settings.value
  emit('run', {
    ...rest,
    depthTolRel: depthTolRel / 100,
    maxCost: maxCost > 0 ? maxCost : Infinity,
  })
}
</script>

<template>
  <ModalShell title="Build Orthophoto" @close="emit('close')">
    <p class="dem-note">
      Reprojects the current DEM<span v-if="demSize"> ({{ demSize }}<span v-if="demCrs">, {{ demCrs }}</span>)</span>
      into the source views. Rebuild the DEM first to change resolution or frame.
    </p>

    <SettingsField label="View blending" label-for="ortho-blend"
      hint="Best picks the lowest-cost view per cell; average blends all visible views.">
      <select id="ortho-blend" v-model="settings.blend" class="field-input field-select">
        <option value="best">Best view (sharpest)</option>
        <option value="average">Average (smoother seams)</option>
      </select>
    </SettingsField>

    <SettingsField label-for="ortho-tol" unit="%"
      hint="How closely a cell's depth must match a view's depth map to count as visible.">
      <template #label>
        <GlossaryTerm id="depth-map">Occlusion tolerance</GlossaryTerm>
      </template>
      <input id="ortho-tol" v-model.number="settings.depthTolRel" type="number" min="0.5" max="10" step="0.5" class="field-input" />
    </SettingsField>

    <SettingsField label-for="ortho-cost"
      hint="Drop colours from poorly-matched (high-cost) pixels. 0 = keep all.">
      <template #label>
        Max <GlossaryTerm id="photometric-consistency">match cost</GlossaryTerm>
      </template>
      <input id="ortho-cost" v-model.number="settings.maxCost" type="number" min="0" max="2" step="0.1" class="field-input" />
    </SettingsField>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" @click="run">Build Orthophoto</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.dem-note { font-size: 11px; color: var(--text-dim); margin: 0; line-height: 1.5; }
.field-select { width: 100%; }
</style>
