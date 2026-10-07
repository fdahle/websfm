<script setup>
import { ref, computed, watch } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import WarnBox from './ui/WarnBox.vue'
import StatTiles from './ui/StatTiles.vue'
import { meshMeasure } from '../../core/products/meshEdit.js'
import { cloudUnits, formatMeasure } from '../../core/products/cloudUnits.js'

// Area & Volume (Tools ▸ Mesh ▾) — read-only. One linear pass over the triangles
// (core/products/meshEdit.js `meshMeasure`), cheap enough to run on open. Volume is
// reported only for a watertight, consistently wound mesh; anything else would be
// a number with no meaning, so the dialog says why instead.
const props = defineProps({
  meshes: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
  // The store's currentFrameSignature: what a model unit means right now.
  frameSignature: { type: Object, default: null },
})
const emit = defineEmits(['close'])

const sourceId = ref(props.meshes.some((m) => m.id === props.initialId) ? props.initialId : props.meshes[0]?.id ?? null)
const source = computed(() => props.meshes.find((m) => m.id === sourceId.value) ?? null)
const units = computed(() => cloudUnits(source.value, props.frameSignature))
const result = ref(null)
watch(source, (m) => { result.value = m ? meshMeasure(m) : null }, { immediate: true })

const tiles = computed(() => {
  const r = result.value
  if (!r) return []
  return [
    { label: 'Surface area', value: formatMeasure(r.area, units.value, 2) },
    { label: 'Volume', value: r.volume == null ? 'not closed' : formatMeasure(r.volume, units.value, 3) },
    { label: 'Triangles', value: r.triangles.toLocaleString() },
    { label: 'Pieces', value: r.components.toLocaleString() },
  ]
})
const whyNoVolume = computed(() => {
  const r = result.value
  if (!r || r.volume != null) return ''
  const parts = []
  if (r.boundaryEdges) parts.push(`${r.boundaryEdges.toLocaleString()} open edges (holes)`)
  if (r.nonManifoldEdges) parts.push(`${r.nonManifoldEdges.toLocaleString()} non-manifold edges`)
  if (r.inconsistentEdges) parts.push(`${r.inconsistentEdges.toLocaleString()} inconsistently wound edges`)
  return parts.join(', ')
})
</script>

<template>
  <ModalShell title="Mesh Area & Volume" @close="emit('close')">
    <WarnBox v-if="!meshes.length">No mesh yet. Build one with <strong>Reconstruct ▸ Mesh</strong> or import one.</WarnBox>
    <template v-else>
      <SettingsGroup title="Mesh">
        <SettingsField label="Mesh" label-for="measure-src">
          <select id="measure-src" v-model="sourceId" class="field-select">
            <option v-for="m in meshes" :key="m.id" :value="m.id">{{ m.name }} — {{ m.count.toLocaleString() }} triangles</option>
          </select>
        </SettingsField>
      </SettingsGroup>
      <StatTiles :tiles="tiles" />
      <WarnBox v-if="whyNoVolume">
        No volume: the surface is not closed — {{ whyNoVolume }}. <strong>Mesh ▸ Clean mesh</strong> with
        “Close all holes” makes it watertight.
      </WarnBox>
      <p v-if="units.unit !== 'm'" class="field-hint">
        {{ units.unit === 'model'
          ? 'In model units: the project has no georeference or scale bars yet, so these are not metres.'
          : 'In the imported file’s own units.' }}
      </p>
    </template>
    <template #footer>
      <button class="btn btn-primary" @click="emit('close')">Close</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
