<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import WarnBox from './ui/WarnBox.vue'
import { CLEAN_MESH_DEFAULTS } from '../../core/defaults.user.js'

// Clean Mesh (Tools ▸ Mesh ▾) — the post-Poisson cleanup chain from
// core/products/meshEdit.js `cleanMesh`. Non-destructive: adds a NEW mesh.
const props = defineProps({
  meshes: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...CLEAN_MESH_DEFAULTS, methods: [...CLEAN_MESH_DEFAULTS.methods] })
const sourceId = ref(props.meshes.some((m) => m.id === props.initialId) ? props.initialId : props.meshes[0]?.id ?? null)
const source = computed(() => props.meshes.find((m) => m.id === sourceId.value) ?? null)

// Steps run in this order whatever is ticked (cleanMesh fixes it), so the list
// order IS the pipeline order.
const STEPS = [
  { id: 'weld',       label: 'Weld duplicate vertices' },
  { id: 'components', label: 'Remove small pieces' },
  { id: 'longEdges',  label: 'Remove long-edge bridges' },
  { id: 'holes',      label: 'Fill holes' },
  { id: 'compact',    label: 'Drop unused vertices and degenerate triangles' },
]
const has = (id) => settings.value.methods.includes(id)
function toggle(id) {
  const on = has(id)
  settings.value.methods = STEPS.filter((s) => (s.id === id ? !on : has(s.id))).map((s) => s.id)
}
// 0 = every loop, which closes an open surface's outer rim too.
const fillAll = computed({
  get: () => !(settings.value.maxHoleEdges > 0),
  set: (v) => { settings.value.maxHoleEdges = v ? 0 : CLEAN_MESH_DEFAULTS.maxHoleEdges },
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
    <WarnBox v-if="!meshes.length">No mesh yet. Build one with <strong>Reconstruct ▸ Mesh</strong> or import one.</WarnBox>
    <template v-else>
      <SettingsGroup title="Source">
        <SettingsField label="Mesh" label-for="clean-src" hint="The result is a new mesh; this one is left untouched.">
          <select id="clean-src" v-model="sourceId" class="field-select">
            <option v-for="m in meshes" :key="m.id" :value="m.id">{{ m.name }} — {{ m.count.toLocaleString() }} triangles</option>
          </select>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Steps">
        <SettingsField hint="Ticked steps run top to bottom, each on the previous one's result.">
          <label v-for="s in STEPS" :key="s.id" class="checkbox-row">
            <input type="checkbox" class="checkbox" :checked="has(s.id)" @change="toggle(s.id)" /> {{ s.label }}
          </label>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup v-if="has('components')" title="Small pieces">
        <SettingsField label="Smaller than" label-for="clean-frac" unit="× largest piece"
          hint="A piece is removed when it has fewer triangles than this share of the largest piece.">
          <input id="clean-frac" v-model.number="settings.minFraction" type="number" min="0" max="1" step="0.005" class="field-input" />
        </SettingsField>
        <SettingsField label="Or fewer than" label-for="clean-min" unit="triangles">
          <input id="clean-min" v-model.number="settings.minTriangles" type="number" min="0" step="1" class="field-input" />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup v-if="has('longEdges')" title="Long-edge bridges">
        <SettingsField label="Longer than" label-for="clean-edge" unit="× median edge"
          hint="Poisson stretches long thin triangles across gaps in the data. Lower removes more.">
          <input id="clean-edge" v-model.number="settings.maxEdgeFactor" type="number" min="1.5" step="0.5" class="field-input" />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup v-if="has('holes')" title="Holes">
        <SettingsField hint="Watertight closes every opening, including an open surface's outer rim — for objects to 3D-print or measure volume, not for terrain.">
          <label class="checkbox-row"><input v-model="fillAll" type="checkbox" class="checkbox" /> Close all holes (watertight)</label>
        </SettingsField>
        <SettingsField v-if="!fillAll" label="Up to" label-for="clean-hole" unit="edges around the hole">
          <input id="clean-hole" v-model.number="settings.maxHoleEdges" type="number" min="3" step="1" class="field-input" />
        </SettingsField>
      </SettingsGroup>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !settings.methods.length" @click="run">Clean</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
