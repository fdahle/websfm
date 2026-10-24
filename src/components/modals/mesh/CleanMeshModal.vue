<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import AdvancedDisclosure from '../ui/AdvancedDisclosure.vue'
import NoSourceWarn from '../ui/NoSourceWarn.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import { useSourcePick, meshOptionLabel } from '../../../composables/useSourcePick.js'
import { CLEAN_MESH_DEFAULTS } from '../../../core/defaults.user.js'
import { cleanMeshEffects } from '../../../core/stepEffects/cleanMesh.js'

// Clean Mesh (Tools ▸ Mesh ▾) — the post-Poisson cleanup chain from
// core/products/meshEdit.js `cleanMesh`. Non-destructive: adds a NEW mesh.
const props = defineProps({
  meshes: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...CLEAN_MESH_DEFAULTS, methods: [...CLEAN_MESH_DEFAULTS.methods] })
const { id: sourceId, item: source } = useSourcePick(() => props.meshes, { initialId: props.initialId })

// Steps run in this order whatever is ticked (cleanMesh fixes it), so the numbered
// steps ARE the pipeline order.
const has = (id) => settings.value.methods.includes(id)
const ORDER = CLEAN_MESH_DEFAULTS.methods
function toggle(id) {
  const on = has(id)
  settings.value.methods = ORDER.filter((m) => (m === id ? !on : has(m)))
}
// What each step does to this mesh (core/stepEffects/cleanMesh.js).
const effects = computed(() => cleanMeshEffects(settings.value, { textured: !!source.value?.texture }))
// 0 = every loop, which closes an open surface's outer rim too.
const fillAll = computed({
  get: () => !(settings.value.maxHoleEdges > 0),
  set: (v) => {
    settings.value.maxHoleEdges = v ? 0 : CLEAN_MESH_DEFAULTS.maxHoleEdges
  },
})

function run() {
  const s = settings.value
  emit('run', {
    sourceIds: [sourceId.value],
    settings: {
      methods: [...s.methods],
      minTriangles: s.minTriangles,
      minFraction: s.minFraction,
      maxEdgeFactor: s.maxEdgeFactor,
      maxHoleEdges: s.maxHoleEdges > 0 ? s.maxHoleEdges : 0,
    },
    name: `${source.value?.name ?? 'Mesh'} (cleaned)`,
  })
}
</script>

<template>
  <ModalShell title="Clean Mesh" @close="emit('close')">
    <NoSourceWarn v-if="!meshes.length" kind="mesh" />
    <template v-else>
      <SettingsGroup title="Source">
        <SourcePicker
          id="clean-src"
          v-model="sourceId"
          label="Mesh"
          :items="meshes"
          :option-label="meshOptionLabel"
          hint="The result is a new mesh; this one is left untouched."
        />
      </SettingsGroup>

      <SettingsStep step="1" title="Weld duplicate vertices" :effect="effects.weld" :inactive="!has('weld')">
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('weld')" @change="toggle('weld')" /> Enabled</label
        >
      </SettingsStep>

      <SettingsStep step="2" title="Remove small pieces" :effect="effects.pieces" :inactive="!has('components')">
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('components')" @change="toggle('components')" />
          Enabled</label
        >
      </SettingsStep>

      <SettingsStep step="3" title="Remove long-edge bridges" :effect="effects.bridges" :inactive="!has('longEdges')">
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('longEdges')" @change="toggle('longEdges')" />
          Enabled</label
        >
      </SettingsStep>

      <SettingsStep step="4" title="Fill holes" :effect="effects.holes" :inactive="!has('holes')">
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('holes')" @change="toggle('holes')" /> Enabled</label
        >
        <template v-if="has('holes')">
          <SettingsField
            hint="Closes every opening, including an open surface's outer rim — for objects to 3D-print or measure volume, not for terrain."
          >
            <label class="checkbox-row"
              ><input v-model="fillAll" type="checkbox" class="checkbox" /> Close all holes (watertight)</label
            >
          </SettingsField>
        </template>
      </SettingsStep>

      <SettingsStep
        step="5"
        title="Drop unused vertices and flat triangles"
        :effect="effects.compact"
        :inactive="!has('compact')"
      >
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('compact')" @change="toggle('compact')" />
          Enabled</label
        >
      </SettingsStep>

      <AdvancedDisclosure
        v-if="has('components') || has('longEdges') || (has('holes') && !fillAll)"
        label="Advanced settings"
      >
        <SettingsStep v-if="has('components')" step="2" title="Remove small pieces — advanced">
          <SettingsField label="Smaller than" label-for="clean-frac" unit="× largest piece">
            <input
              id="clean-frac"
              v-model.number="settings.minFraction"
              type="number"
              min="0"
              max="1"
              step="0.005"
              class="field-input"
            />
          </SettingsField>
          <SettingsField label="Or fewer than" label-for="clean-min" unit="triangles">
            <input
              id="clean-min"
              v-model.number="settings.minTriangles"
              type="number"
              min="0"
              step="1"
              class="field-input"
            />
          </SettingsField>
        </SettingsStep>
        <SettingsStep v-if="has('longEdges')" step="3" title="Remove long-edge bridges — advanced">
          <SettingsField
            label="Longer than"
            label-for="clean-edge"
            unit="× median edge"
            hint="Poisson stretches long thin triangles across gaps in the data. Lower removes more."
          >
            <input
              id="clean-edge"
              v-model.number="settings.maxEdgeFactor"
              type="number"
              min="1.5"
              step="0.5"
              class="field-input"
            />
          </SettingsField>
        </SettingsStep>
        <SettingsStep v-if="has('holes') && !fillAll" step="4" title="Fill holes — advanced">
          <SettingsField label="Up to" label-for="clean-hole" unit="edges around the hole">
            <input
              id="clean-hole"
              v-model.number="settings.maxHoleEdges"
              type="number"
              min="3"
              step="1"
              class="field-input"
            />
          </SettingsField>
        </SettingsStep>
      </AdvancedDisclosure>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !settings.methods.length" @click="run">Clean</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
