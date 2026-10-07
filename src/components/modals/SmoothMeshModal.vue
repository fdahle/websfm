<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import WarnBox from './ui/WarnBox.vue'
import { SMOOTH_MESH_DEFAULTS } from '../../core/defaults.user.js'

// Smooth Mesh (Tools ▸ Mesh ▾) — Taubin λ/μ smoothing (core/products/meshEdit.js
// `taubinSmooth`). Unlike repeated Laplacian smoothing it does not shrink the
// surface. Non-destructive: adds a NEW mesh.
const props = defineProps({
  meshes: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...SMOOTH_MESH_DEFAULTS })
const sourceId = ref(props.meshes.some((m) => m.id === props.initialId) ? props.initialId : props.meshes[0]?.id ?? null)
const source = computed(() => props.meshes.find((m) => m.id === sourceId.value) ?? null)
// μ must exceed λ in magnitude, or the second half-step cannot undo the shrink.
const valid = computed(() => settings.value.iterations >= 1 && settings.value.lambda > 0
  && settings.value.mu < -settings.value.lambda)

function run() {
  const s = settings.value
  emit('run', {
    sourceIds: [sourceId.value],
    settings: { iterations: s.iterations, lambda: s.lambda, mu: s.mu, fixBoundary: !!s.fixBoundary },
    name: `${source.value?.name ?? 'Mesh'} (smoothed)`,
  })
}
</script>

<template>
  <ModalShell title="Smooth Mesh" @close="emit('close')">
    <WarnBox v-if="!meshes.length">No mesh yet. Build one with <strong>Reconstruct ▸ Mesh</strong> or import one.</WarnBox>
    <template v-else>
      <SettingsGroup title="Source">
        <SettingsField label="Mesh" label-for="smooth-src" hint="The result is a new mesh; this one is left untouched.">
          <select id="smooth-src" v-model="sourceId" class="field-select">
            <option v-for="m in meshes" :key="m.id" :value="m.id">{{ m.name }} — {{ m.count.toLocaleString() }} triangles</option>
          </select>
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title="Smoothing">
        <SettingsField label="Iterations" label-for="smooth-it" hint="Each pass removes finer noise; more passes also soften real edges.">
          <input id="smooth-it" v-model.number="settings.iterations" type="number" min="1" max="200" step="1" class="field-input" />
        </SettingsField>
        <SettingsField hint="Keeps the outline of an open surface (a terrain edge) where it is.">
          <label class="checkbox-row"><input v-model="settings.fixBoundary" type="checkbox" class="checkbox" /> Keep the boundary fixed</label>
        </SettingsField>
      </SettingsGroup>
      <AdvancedDisclosure label="Advanced settings">
        <SettingsGroup title="Taubin weights">
          <SettingsField label="λ (smooth)" label-for="smooth-l">
            <input id="smooth-l" v-model.number="settings.lambda" type="number" min="0.01" max="1" step="0.01" class="field-input" />
          </SettingsField>
          <SettingsField label="μ (inflate)" label-for="smooth-m" hint="Must be more negative than −λ, or the mesh shrinks.">
            <input id="smooth-m" v-model.number="settings.mu" type="number" max="0" step="0.01" class="field-input" />
          </SettingsField>
        </SettingsGroup>
      </AdvancedDisclosure>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !valid" @click="run">Smooth</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
