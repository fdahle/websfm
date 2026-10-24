<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import NoSourceWarn from '../ui/NoSourceWarn.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import { useSourcePick, meshOptionLabel } from '../../../composables/useSourcePick.js'
import { SAMPLE_MESH_DEFAULTS } from '../../../core/defaults.user.js'
import { sampleMeshEffects } from '../../../core/stepEffects/sampleMesh.js'

// Sample to Points (Tools ▸ Mesh ▾) — area-uniform random samples of the surface
// as a NEW dense cloud with face normals and interpolated colour, so every cloud
// tool (and the DEM) can consume a mesh (core/products/meshEdit.js `sampleMesh`).
const props = defineProps({
  meshes: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...SAMPLE_MESH_DEFAULTS })
const { id: sourceId, item: source } = useSourcePick(() => props.meshes, { initialId: props.initialId })
const MAX = 50_000_000
// What the step does to this mesh (core/stepEffects/sampleMesh.js).
const effects = computed(() => sampleMeshEffects(settings.value, { triangles: source.value?.count ?? 0 }))

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
    <NoSourceWarn v-if="!meshes.length" kind="mesh" />
    <template v-else>
      <SettingsGroup title="Source">
        <SourcePicker id="sample-src" v-model="sourceId" label="Mesh" :items="meshes" :option-label="meshOptionLabel" />
      </SettingsGroup>
      <SettingsStep step="1" title="Sample the surface" :effect="effects.sample">
        <SettingsField label="Number of points" label-for="sample-n">
          <input
            id="sample-n"
            v-model.number="settings.count"
            type="number"
            min="1000"
            :max="MAX"
            step="100000"
            class="field-input"
          />
        </SettingsField>
      </SettingsStep>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button
        class="btn btn-primary"
        :disabled="!source || !(settings.count >= 1000 && settings.count <= MAX)"
        @click="run"
      >
        Sample
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
