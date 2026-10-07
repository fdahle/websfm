<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import WarnBox from './ui/WarnBox.vue'
import { DECIMATE_MESH_DEFAULTS } from '../../core/defaults.user.js'

// Decimate Mesh (Tools ▸ Mesh ▾) — quadric edge collapse (Garland–Heckbert,
// core/products/meshDecimate.js): fewer triangles where the surface is flat, detail
// kept where it bends. Makes a big Poisson mesh light enough to view and share.
// Non-destructive: adds a NEW mesh.
const props = defineProps({
  meshes: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...DECIMATE_MESH_DEFAULTS })
const sourceId = ref(props.meshes.some((m) => m.id === props.initialId) ? props.initialId : props.meshes[0]?.id ?? null)
const source = computed(() => props.meshes.find((m) => m.id === sourceId.value) ?? null)
const MODES = [{ id: 'ratio', label: 'Share' }, { id: 'count', label: 'Triangle count' }]

const target = computed(() => {
  const n = source.value?.count ?? 0
  const s = settings.value
  return s.targetMode === 'ratio'
    ? Math.round(n * Math.min(1, Math.max(0, (s.targetRatio || 0))))
    : Math.min(n, Math.max(0, Math.round(s.targetTriangles || 0)))
})
const valid = computed(() => source.value && target.value >= 4 && target.value < source.value.count)

function run() {
  const s = settings.value
  emit('run', {
    sourceIds: [sourceId.value],
    settings: s.targetMode === 'ratio'
      ? { targetRatio: s.targetRatio, preserveBoundary: !!s.preserveBoundary }
      : { targetTriangles: Math.round(s.targetTriangles), preserveBoundary: !!s.preserveBoundary },
    name: `${source.value?.name ?? 'Mesh'} (decimated)`,
  })
}
</script>

<template>
  <ModalShell title="Decimate Mesh" @close="emit('close')">
    <WarnBox v-if="!meshes.length">No mesh yet. Build one with <strong>Reconstruct ▸ Mesh</strong> or import one.</WarnBox>
    <template v-else>
      <SettingsGroup title="Source">
        <SettingsField label="Mesh" label-for="dec-src" hint="The result is a new mesh; this one is left untouched.">
          <select id="dec-src" v-model="sourceId" class="field-select">
            <option v-for="m in meshes" :key="m.id" :value="m.id">{{ m.name }} — {{ m.count.toLocaleString() }} triangles</option>
          </select>
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title="Target">
        <SettingsField label="Reduce to">
          <SegmentedControl v-model="settings.targetMode" :options="MODES" />
        </SettingsField>
        <SettingsField v-if="settings.targetMode === 'ratio'" label="Share of triangles" label-for="dec-ratio" unit="× source">
          <input id="dec-ratio" v-model.number="settings.targetRatio" type="number" min="0.001" max="0.99" step="0.05" class="field-input" />
        </SettingsField>
        <SettingsField v-else label="Triangles" label-for="dec-count">
          <input id="dec-count" v-model.number="settings.targetTriangles" type="number" min="4" step="10000" class="field-input" />
        </SettingsField>
        <SettingsField hint="Keeps an open surface's outline (a terrain edge, a cut) from being eaten away.">
          <label class="checkbox-row"><input v-model="settings.preserveBoundary" type="checkbox" class="checkbox" /> Preserve the boundary</label>
        </SettingsField>
      </SettingsGroup>
      <p v-if="source" class="field-hint">
        {{ source.count.toLocaleString() }} → about {{ target.toLocaleString() }} triangles.
        A few million triangles take several seconds.
      </p>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!valid" @click="run">Decimate</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
