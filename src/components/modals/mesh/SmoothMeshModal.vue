<script setup>
import FieldHelp from '../../guide/FieldHelp.vue'
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import ShowAdvancedSettings from '../ui/ShowAdvancedSettings.vue'
import { provideStepLayout } from '../../../composables/useStepLayout.js'
import NoSourceWarn from '../ui/NoSourceWarn.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import { useSourcePick, meshOptionLabel } from '../../../composables/useSourcePick.js'
import { SMOOTH_MESH_DEFAULTS } from '../../../core/defaults.user.js'
import { smoothMeshEffects, smoothMeshShorts } from '../../../core/stepEffects/smoothMesh.js'
import { withShorts } from '../../../core/stepEffects/format.js'

// Smooth Mesh (Tools ▸ Mesh ▾) — Taubin λ/μ smoothing (core/products/meshEdit.js
// `taubinSmooth`). Unlike repeated Laplacian smoothing it does not shrink the
// surface. Non-destructive: adds a NEW mesh.
const props = defineProps({
  meshes: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...SMOOTH_MESH_DEFAULTS })
const { id: sourceId, item: source } = useSourcePick(() => props.meshes, { initialId: props.initialId })
// μ must exceed λ in magnitude, or the second half-step cannot undo the shrink.
const valid = computed(
  () => settings.value.iterations >= 1 && settings.value.lambda > 0 && settings.value.mu < -settings.value.lambda,
)
// What the step does to this mesh (core/stepEffects/smoothMesh.js).
const effects = computed(() =>
  withShorts(
    smoothMeshEffects(settings.value, { triangles: source.value?.count ?? 0 }),
    smoothMeshShorts(settings.value, { triangles: source.value?.count ?? 0 }),
  ),
)

function run() {
  const s = settings.value
  emit('run', {
    sourceIds: [sourceId.value],
    settings: { iterations: s.iterations, lambda: s.lambda, mu: s.mu, fixBoundary: !!s.fixBoundary },
    name: `${source.value?.name ?? 'Mesh'} (smoothed)`,
  })
}

// One list of steps (useStepLayout.js): each registers for the step chain, its tuning
// folded in place.
provideStepLayout('smooth-mesh')
</script>

<template>
  <ModalShell title="Smooth Mesh" @close="emit('close')">
    <NoSourceWarn v-if="!meshes.length" kind="mesh" />
    <template v-else>
      <SettingsGroup title="Source">
        <SourcePicker
          id="smooth-src"
          v-model="sourceId"
          label="Mesh"
          :items="meshes"
          :option-label="meshOptionLabel"
          hint="The result is a new mesh; this one is left untouched."
        />
      </SettingsGroup>

      <SettingsStep step="1" title="Smooth" :effect="effects.smooth" :more="2">
        <SettingsField label-for="smooth-it" hint="Each pass removes finer noise; more passes also soften real edges.">
          <template #label
            ><FieldHelp
              op="smooth-mesh"
              param="iterations"
              :value="settings.iterations"
              :default-value="SMOOTH_MESH_DEFAULTS.iterations"
              >Iterations</FieldHelp
            ></template
          >
          <input
            id="smooth-it"
            v-model.number="settings.iterations"
            type="number"
            min="1"
            max="200"
            step="1"
            class="field-input"
          />
        </SettingsField>
        <SettingsField hint="Keeps the outline of an open surface (a terrain edge) where it is.">
          <label class="checkbox-row"
            ><input v-model="settings.fixBoundary" type="checkbox" class="checkbox" />
            <FieldHelp
              op="smooth-mesh"
              param="fixBoundary"
              :value="settings.fixBoundary"
              :default-value="SMOOTH_MESH_DEFAULTS.fixBoundary"
              >Keep the boundary fixed</FieldHelp
            ></label
          >
        </SettingsField>

        <template #tuning>
          <SettingsField label-for="smooth-l">
            <template #label
              ><FieldHelp
                op="smooth-mesh"
                param="lambda"
                :value="settings.lambda"
                :default-value="SMOOTH_MESH_DEFAULTS.lambda"
                >λ (smooth)</FieldHelp
              ></template
            >
            <input
              id="smooth-l"
              v-model.number="settings.lambda"
              type="number"
              min="0.01"
              max="1"
              step="0.01"
              class="field-input"
            />
          </SettingsField>
          <SettingsField label-for="smooth-m" hint="Must be more negative than −λ, or the mesh shrinks.">
            <template #label
              ><FieldHelp op="smooth-mesh" param="mu" :value="settings.mu" :default-value="SMOOTH_MESH_DEFAULTS.mu"
                >μ (inflate)</FieldHelp
              ></template
            >
            <input id="smooth-m" v-model.number="settings.mu" type="number" max="0" step="0.01" class="field-input" />
          </SettingsField>
        </template>
      </SettingsStep>
    </template>
    <template #footer>
      <ShowAdvancedSettings />

      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !valid" @click="run">Smooth</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
