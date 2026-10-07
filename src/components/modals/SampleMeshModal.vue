<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import WarnBox from './ui/WarnBox.vue'
import { SAMPLE_MESH_DEFAULTS } from '../../core/defaults.user.js'

// Sample to Points (Tools ▸ Mesh ▾) — area-uniform random samples of the surface
// as a NEW dense cloud with face normals and interpolated colour, so every cloud
// tool (and the DEM) can consume a mesh (core/products/meshEdit.js `sampleMesh`).
const props = defineProps({
  meshes: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...SAMPLE_MESH_DEFAULTS })
const sourceId = ref(props.meshes.some((m) => m.id === props.initialId) ? props.initialId : props.meshes[0]?.id ?? null)
const source = computed(() => props.meshes.find((m) => m.id === sourceId.value) ?? null)
const MAX = 50_000_000

function run() {
  emit('run', {
    sourceIds: [sourceId.value],
    settings: { count: Math.round(settings.value.count), seed: 1 },
    name: `${source.value?.name ?? 'Mesh'} (sampled)`,
  })
}
</script>

<template>
  <ModalShell title="Sample Mesh to Points" @close="emit('close')">
    <WarnBox v-if="!meshes.length">No mesh yet. Build one with <strong>Reconstruct ▸ Mesh</strong> or import one.</WarnBox>
    <template v-else>
      <SettingsGroup title="Source">
        <SettingsField label="Mesh" label-for="sample-src">
          <select id="sample-src" v-model="sourceId" class="field-select">
            <option v-for="m in meshes" :key="m.id" :value="m.id">{{ m.name }} — {{ m.count.toLocaleString() }} triangles</option>
          </select>
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title="Points">
        <SettingsField label="Number of points" label-for="sample-n"
          hint="Spread evenly by surface area. The same mesh and count always give the same points.">
          <input id="sample-n" v-model.number="settings.count" type="number" min="1000" :max="MAX" step="100000" class="field-input" />
        </SettingsField>
      </SettingsGroup>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !(settings.count >= 1000 && settings.count <= MAX)" @click="run">Sample</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
