<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import PresetCards from './ui/PresetCards.vue'
import WarnBox from './ui/WarnBox.vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import { MESH_DEFAULTS, MESH_PRESETS, MESH_PRESET_META } from '../../core/defaults.user.js'
import { recommendMeshDepth } from '../../core/products/mesh.js'

// Build Mesh (screened Poisson over the dense cloud). Defaults are the single source
// of truth in core/defaults.user.js (core/products/mesh.js keeps matching fallbacks).
// `hasDenseNormals` gates the run: Poisson needs the dense cloud's oriented normals,
// which only exist on a dense cloud produced after normals were plumbed.
const props = defineProps({
  hasDense: { type: Boolean, default: false },
  hasDenseNormals: { type: Boolean, default: false },
  denseCount: { type: Number, default: 0 },
})

const emit = defineEmits(['close', 'run'])

const settings = ref({ ...MESH_DEFAULTS })

// Quality presets set the octree depth (detail/cost lever; deltas over defaults).
const resolvePreset = (id) => ({ ...MESH_DEFAULTS, ...MESH_PRESETS[id] })
const baseId = ref('medium')
const activePreset = computed(() => {
  for (const { id } of MESH_PRESET_META) {
    const r = resolvePreset(id)
    if (Object.keys(r).every((k) => settings.value[k] === r[k])) return id
  }
  return 'custom'
})
function selectPreset(id) {
  settings.value = { ...resolvePreset(id) }
  baseId.value = id
}

// Flag an octree depth that's high for this cloud's point count: too high mostly builds
// empty octree cells — slow and RAM-hungry with no real detail gain (see mesh.js).
const recommendedDepth = computed(() => recommendMeshDepth(props.denseCount))
const depthTooHigh = computed(() => props.denseCount > 0 && settings.value.depth > recommendedDepth.value)

function run() {
  emit('run', { ...settings.value })
}
</script>

<template>
  <ModalShell title="Build Mesh" @close="emit('close')">
    <WarnBox v-if="!hasDense">
      No dense point cloud yet. Run <strong>Densify</strong> first — meshing reconstructs a
      surface over the dense cloud.
    </WarnBox>
    <WarnBox v-else-if="!hasDenseNormals">
      The dense cloud has no per-point normals, which screened Poisson requires. Re-run
      <strong>Densify</strong> to compute them, then build the mesh.
    </WarnBox>

    <PresetCards
      :model-value="activePreset"
      :base-id="baseId"
      :presets="MESH_PRESET_META"
      @select="selectPreset"
    />

    <AdvancedDisclosure label="Advanced settings">
      <SettingsGroup title="Surface">
        <SettingsField label-for="mesh-depth" unit="levels"
          hint="Surface resolution. Higher = more detail & triangles (much slower / more RAM).">
          <template #label>
            <GlossaryTerm id="mesh">Octree depth</GlossaryTerm>
          </template>
          <input id="mesh-depth" v-model.number="settings.depth" type="number" min="4" max="12" step="1" class="field-input" />
        </SettingsField>

        <WarnBox v-if="depthTooHigh">
          Depth {{ settings.depth }} is high for {{ denseCount.toLocaleString() }} points
          (recommended ≤ {{ recommendedDepth }}). The Poisson solve may be slow and
          memory-hungry with little extra detail — consider lowering it.
        </WarnBox>

        <SettingsField label="Screening weight" label-for="mesh-screen"
          hint="How tightly the surface fits the points. 0 = smoothest/fastest; higher hugs the data.">
          <input id="mesh-screen" v-model.number="settings.screening" type="number" min="0" max="16" step="0.5" class="field-input" />
        </SettingsField>

        <SettingsField
          hint="Keeps Poisson's closed surface so gaps in the cloud do not become mesh holes. This may retain extrapolated geometry near the boundary.">
          <template #label>Fill gaps (watertight mesh)</template>
          <label class="checkbox-row"><input v-model="settings.fillHoles" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>

        <SettingsField v-if="!settings.fillHoles" label="Trim factor" label-for="mesh-trim" unit="× cell"
          hint="Cull triangles farther than this many dense-cloud cells from any point. 0 = keep watertight.">
          <input id="mesh-trim" v-model.number="settings.trimFactor" type="number" min="0" max="32" step="1" class="field-input" />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Colour">
        <SettingsField hint="Colour each mesh vertex from the nearest dense point.">
          <template #label>Transfer colour from the
            <GlossaryTerm id="point-cloud">dense cloud</GlossaryTerm></template>
          <label class="checkbox-row"><input v-model="settings.colorize" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>
      </SettingsGroup>
    </AdvancedDisclosure>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!hasDense || !hasDenseNormals" @click="run">Build Mesh</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
