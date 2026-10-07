<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import PresetCards from './ui/PresetCards.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import WarnBox from './ui/WarnBox.vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import { MESH_DEFAULTS, MESH_PRESETS, MESH_PRESET_META } from '../../core/defaults.user.js'
import { recommendMeshDepth } from '../../core/products/mesh.js'

// Build Mesh (screened Poisson over a dense cloud). Defaults are the single source of
// truth in core/defaults.user.js (core/products/mesh.js keeps matching fallbacks).
// `sources` is the store's `meshSources` (dense clouds WITH normals) and
// `defaultSourceId` its `meshSource` pick — the store consumes the same pick, so the
// Source line here is what will be meshed. `hasDense` (any dense cloud, normals or not)
// only words the warning when nothing is eligible.
const props = defineProps({
  sources: { type: Array, default: () => [] },
  defaultSourceId: { type: String, default: null },
  hasDense: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...MESH_DEFAULTS })
const sourceId = ref(props.defaultSourceId ?? props.sources[0]?.id ?? null)
const source = computed(() => props.sources.find((s) => s.id === sourceId.value) ?? null)
const sourceLabel = (s) => `${s.name} — ${s.count.toLocaleString()} points`
  + (s.derived ? ' · edited' : '') + (s.imported ? ' · imported' : '')

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

const TRIM_OPTIONS = [
  { id: 'off', label: 'Off' },
  { id: 'gentle', label: 'Gentle' },
  { id: 'strong', label: 'Strong' },
]
const trimHint = computed(() => ({
  off: 'Keep the whole closed Poisson surface, including the hull it extrapolates past the data.',
  gentle: 'Remove surface no points support: the extrapolated hull and the shells around stray specks.',
  strong: 'Also remove thinly observed surface. Can open holes where coverage is sparse.',
}[settings.value.trim]))

// Flag an octree depth that's high for this cloud's point count: too high mostly builds
// empty octree cells — slow and RAM-hungry with no real detail gain (see mesh.js).
const pointCount = computed(() => source.value?.count ?? 0)
const recommendedDepth = computed(() => recommendMeshDepth(pointCount.value))
const depthTooHigh = computed(() => pointCount.value > 0 && settings.value.depth > recommendedDepth.value)

function run() {
  emit('run', { ...settings.value, sourceId: sourceId.value })
}
</script>

<template>
  <ModalShell title="Build Mesh" @close="emit('close')">
    <WarnBox v-if="!sources.length && !hasDense">
      No dense point cloud yet. Run <strong>Densify</strong> first — meshing reconstructs a
      surface over the dense cloud.
    </WarnBox>
    <WarnBox v-else-if="!sources.length">
      No dense cloud has per-point normals, which screened Poisson requires. Re-run
      <strong>Densify</strong> to compute them, then build the mesh.
    </WarnBox>

    <div v-if="sources.length" class="source-row">
      <label class="field-label" for="mesh-source">Source</label>
      <select v-if="sources.length > 1" id="mesh-source" v-model="sourceId" class="field-select source-select">
        <option v-for="s in sources" :key="s.id" :value="s.id">{{ sourceLabel(s) }}</option>
      </select>
      <span v-else class="field-hint source-value">{{ sourceLabel(sources[0]) }}</span>
    </div>

    <PresetCards
      :model-value="activePreset"
      :base-id="baseId"
      :presets="MESH_PRESET_META"
      @select="selectPreset"
    />

    <SettingsGroup title="Cleanup">
      <SettingsField :hint="trimHint">
        <template #label>Surface trimming</template>
        <SegmentedControl v-model="settings.trim" :options="TRIM_OPTIONS" />
      </SettingsField>
      <SettingsField v-if="settings.trim !== 'off'"
        hint="Close small holes the trimming opened, where the surrounding surface is solid.">
        <template #label>Fill small holes</template>
        <label class="checkbox-row"><input v-model="settings.fillHoles" type="checkbox" class="checkbox" /> Enabled</label>
      </SettingsField>
      <SettingsField
        hint="Drop disconnected pieces that explain only a few of the cloud's points — stray specks and leftover clutter.">
        <template #label>Remove floating pieces</template>
        <label class="checkbox-row"><input v-model="settings.removeFloaters" type="checkbox" class="checkbox" /> Enabled</label>
      </SettingsField>
    </SettingsGroup>

    <AdvancedDisclosure label="Advanced settings">
      <SettingsGroup title="Surface">
        <SettingsField label-for="mesh-depth" unit="levels"
          hint="Detail limit. Lowered automatically when the cloud is too sparse to use it.">
          <template #label>
            <GlossaryTerm id="mesh">Octree depth</GlossaryTerm>
          </template>
          <input id="mesh-depth" v-model.number="settings.depth" type="number" min="4" max="12" step="1" class="field-input" />
        </SettingsField>
        <WarnBox v-if="depthTooHigh">
          Depth {{ settings.depth }} is high for {{ pointCount.toLocaleString() }} points
          (recommended ≤ {{ recommendedDepth }}). The Poisson solve may be slow and
          memory-hungry with little extra detail — consider lowering it.
        </WarnBox>
        <SettingsField label="Screening weight" label-for="mesh-screen"
          hint="How tightly the surface fits the points. 0 = smoothest/fastest; higher hugs the data.">
          <input id="mesh-screen" v-model.number="settings.screening" type="number" min="0" max="16" step="0.5" class="field-input" />
        </SettingsField>
        <SettingsField v-if="settings.removeFloaters" label="Floating piece size" label-for="mesh-minpiece" unit="%"
          hint="Pieces supported by less than this share of the main surface's points are removed.">
          <input id="mesh-minpiece" v-model.number="settings.minPiecePct" type="number" min="0" max="50" step="0.5" class="field-input" />
        </SettingsField>
        <SettingsField label="Distance trim" label-for="mesh-dist" unit="× spacing"
          hint="Also cut triangles farther than this many sample spacings from any point. 0 = off.">
          <input id="mesh-dist" v-model.number="settings.distanceTrim" type="number" min="0" max="32" step="1" class="field-input" />
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
      <button class="btn btn-primary" :disabled="!source" @click="run">Build Mesh</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
/* Source is a statement or a short pick, not a settings field: label and value on one line. */
.source-row { display: flex; align-items: baseline; gap: 8px; }
.source-value { color: var(--text); }
.source-select { flex: 1; min-width: 0; }
</style>
