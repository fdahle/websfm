<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import AdvancedDisclosure from '../ui/AdvancedDisclosure.vue'
import PresetCards from '../ui/PresetCards.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import WarnBox from '../ui/WarnBox.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import { useSourcePick, statusTags } from '../../../composables/useSourcePick.js'
import { usePresetSettings } from '../../../composables/usePresetSettings.js'
import FieldHelp from '../../guide/FieldHelp.vue'
import { MESH_DEFAULTS, MESH_PRESETS, MESH_PRESET_META } from '../../../core/defaults.user.js'
import { recommendMeshDepth } from '../../../core/products/mesh.js'
import { checkNumberFields } from '../../../utils/numberFields.js'
import { meshEffects } from '../../../core/stepEffects/mesh.js'
import OutputStep from '../ui/OutputStep.vue'
import { useComputeSettings } from '../../../composables/useComputeSettings.js'

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
  // The store's outputPlan('mesh'): what step 6 (Output) adds or replaces.
  output: { type: Object, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...MESH_DEFAULTS })
const { id: sourceId, item: source } = useSourcePick(() => props.sources, { initialId: props.defaultSourceId })
const sourceLabel = (s) =>
  `${s.name} — ${s.count.toLocaleString()} points` +
  (s.derived ? ' · edited' : '') +
  (s.imported ? ' · imported' : '') +
  statusTags(s)

// Quality presets set the octree depth (detail/cost lever; deltas over defaults) —
// only the depth: trimming, hole filling, floaters and colour are the user's.
const { baseId, activePreset, selectPreset } = usePresetSettings({
  settings,
  defaults: MESH_DEFAULTS,
  presets: MESH_PRESETS,
  cards: MESH_PRESET_META,
})

// What each step does to this project (core/stepEffects/mesh.js).
const effects = computed(() =>
  meshEffects(settings.value, { source: source.value && { name: source.value.name, count: source.value.count } }),
)

const TILE_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: 'off', label: 'Off' },
]

const TRIM_OPTIONS = [
  { id: 'off', label: 'Off' },
  { id: 'gentle', label: 'Gentle' },
  { id: 'strong', label: 'Strong' },
]

// Flag an octree depth that's high for this cloud's point count: too high mostly builds
// empty octree cells — slow and RAM-hungry with no real detail gain (see mesh.js).
const pointCount = computed(() => source.value?.count ?? 0)
const recommendedDepth = computed(() => recommendMeshDepth(pointCount.value))
const depthTooHigh = computed(() => pointCount.value > 0 && settings.value.depth > recommendedDepth.value)

// Run stays disabled while a field is blank or out of range (rules = the inputs'
// own min/max/step); the floater size is only checked while that cleanup is on.
const numbers = computed(() =>
  checkNumberFields(settings.value, {
    depth: { label: 'Octree depth', min: 4, max: 12, integer: true },
    screening: { label: 'Screening weight', min: 0, max: 16 },
    minPiecePct: { label: 'Floating piece size', min: 0, max: 50, when: settings.value.removeFloaters },
    distanceTrim: { label: 'Distance trim', min: 0, max: 32 },
  }),
)

// The machine's whole memory limit (Settings ▸ Compute): how many tiles solve at once.
const { memBudgetRamBytes } = useComputeSettings()

function run() {
  emit('run', { ...settings.value, sourceId: sourceId.value, ramBudgetBytes: memBudgetRamBytes.value })
}
</script>

<template>
  <ModalShell title="Build Mesh" @close="emit('close')">
    <WarnBox v-if="!sources.length && !hasDense">
      No dense point cloud yet. Run <strong>Densify</strong> first — meshing reconstructs a surface over the dense
      cloud.
    </WarnBox>
    <WarnBox v-else-if="!sources.length">
      No dense cloud has per-point normals, which screened Poisson requires. Re-run
      <strong>Densify</strong> to compute them, then build the mesh.
    </WarnBox>

    <SourcePicker
      v-if="sources.length"
      id="mesh-source"
      v-model="sourceId"
      variant="inline"
      :items="sources"
      :option-label="sourceLabel"
    />

    <PresetCards :model-value="activePreset" :base-id="baseId" :presets="MESH_PRESET_META" @select="selectPreset" />

    <SettingsStep step="1" title="Solve the surface" :effect="effects.solve" />

    <SettingsStep step="2" title="Trim" :effect="effects.trim">
      <SettingsField hint="How much of the closed Poisson surface is cut back to where the points are.">
        <template #label><FieldHelp op="mesh" param="trim">Surface trimming</FieldHelp></template>
        <SegmentedControl v-model="settings.trim" :options="TRIM_OPTIONS" />
      </SettingsField>
    </SettingsStep>

    <SettingsStep step="3" title="Fill small holes" :effect="effects.holes" :inactive="settings.trim === 'off'">
      <SettingsField
        v-if="settings.trim !== 'off'"
        hint="Close small holes the trimming opened, where the surrounding surface is solid."
      >
        <template #label
          ><FieldHelp op="mesh" param="fillHoles" :value="settings.fillHoles" :default-value="MESH_DEFAULTS.fillHoles"
            >Fill small holes</FieldHelp
          ></template
        >
        <label class="checkbox-row"
          ><input v-model="settings.fillHoles" type="checkbox" class="checkbox" /> Enabled</label
        >
      </SettingsField>
    </SettingsStep>

    <SettingsStep
      step="4"
      title="Remove floating pieces"
      :effect="effects.floaters"
      :inactive="!settings.removeFloaters"
    >
      <SettingsField
        hint="Drop disconnected pieces that explain only a few of the cloud's points — stray specks and leftover clutter."
      >
        <template #label
          ><FieldHelp
            op="mesh"
            param="removeFloaters"
            :value="settings.removeFloaters"
            :default-value="MESH_DEFAULTS.removeFloaters"
            >Remove floating pieces</FieldHelp
          ></template
        >
        <label class="checkbox-row"
          ><input v-model="settings.removeFloaters" type="checkbox" class="checkbox" /> Enabled</label
        >
      </SettingsField>
    </SettingsStep>

    <AdvancedDisclosure label="Advanced settings">
      <SettingsStep step="1" title="Solve the surface — advanced">
        <SettingsField
          label-for="mesh-depth"
          unit="levels"
          hint="Detail limit. Lowered automatically when the cloud is too sparse to use it."
        >
          <template #label>
            <FieldHelp op="mesh" param="depth" :value="settings.depth" :default-value="MESH_DEFAULTS.depth"
              >Octree depth</FieldHelp
            >
          </template>
          <input
            id="mesh-depth"
            v-model.number="settings.depth"
            :aria-invalid="numbers.bad.depth"
            type="number"
            min="4"
            max="12"
            step="1"
            class="field-input"
          />
        </SettingsField>
        <WarnBox v-if="depthTooHigh">
          Depth {{ settings.depth }} is high for {{ pointCount.toLocaleString() }} points (recommended ≤
          {{ recommendedDepth }}). The Poisson solve may be slow and memory-hungry with little extra detail — consider
          lowering it.
        </WarnBox>
        <SettingsField
          label-for="mesh-screen"
          hint="How tightly the surface fits the points. 0 = smoothest/fastest; higher hugs the data."
        >
          <template #label
            ><FieldHelp op="mesh" param="screening" :value="settings.screening" :default-value="MESH_DEFAULTS.screening"
              >Screening weight</FieldHelp
            ></template
          >
          <input
            id="mesh-screen"
            v-model.number="settings.screening"
            :aria-invalid="numbers.bad.screening"
            type="number"
            min="0"
            max="16"
            step="0.5"
            class="field-input"
          />
        </SettingsField>
        <SettingsField hint="Auto: in tiles only when one solve would not fit in memory.">
          <template #label><FieldHelp op="mesh" param="tiles">Tiles</FieldHelp></template>
          <SegmentedControl v-model="settings.tiles" :options="TILE_OPTIONS" />
        </SettingsField>
      </SettingsStep>

      <SettingsStep step="2" title="Trim — advanced">
        <SettingsField
          label-for="mesh-dist"
          unit="× spacing"
          hint="Also cut triangles farther than this many sample spacings from any point. 0 = off."
        >
          <template #label
            ><FieldHelp
              op="mesh"
              param="distanceTrim"
              :value="settings.distanceTrim"
              :default-value="MESH_DEFAULTS.distanceTrim"
              >Distance trim</FieldHelp
            ></template
          >
          <input
            id="mesh-dist"
            v-model.number="settings.distanceTrim"
            :aria-invalid="numbers.bad.distanceTrim"
            type="number"
            min="0"
            max="32"
            step="1"
            class="field-input"
          />
        </SettingsField>
      </SettingsStep>

      <SettingsStep v-if="settings.removeFloaters" step="4" title="Remove floating pieces — advanced">
        <SettingsField
          label-for="mesh-minpiece"
          unit="%"
          hint="Pieces supported by less than this share of the main surface's points are removed."
        >
          <template #label
            ><FieldHelp
              op="mesh"
              param="minPiecePct"
              :value="settings.minPiecePct"
              :default-value="MESH_DEFAULTS.minPiecePct"
              >Floating piece size</FieldHelp
            ></template
          >
          <input
            id="mesh-minpiece"
            v-model.number="settings.minPiecePct"
            :aria-invalid="numbers.bad.minPiecePct"
            type="number"
            min="0"
            max="50"
            step="0.5"
            class="field-input"
          />
        </SettingsField>
      </SettingsStep>

      <SettingsStep step="5" title="Colour" :effect="effects.colour" :inactive="!settings.colorize">
        <SettingsField hint="Colour each mesh vertex from the nearest dense point.">
          <template #label
            ><FieldHelp op="mesh" param="colorize" :value="settings.colorize" :default-value="MESH_DEFAULTS.colorize"
              >Transfer colour from the dense cloud</FieldHelp
            ></template
          >
          <label class="checkbox-row"
            ><input v-model="settings.colorize" type="checkbox" class="checkbox" /> Enabled</label
          >
        </SettingsField>
      </SettingsStep>
    </AdvancedDisclosure>

    <OutputStep
      v-model="settings.replaceMain"
      step="6"
      op="mesh"
      noun="mesh"
      :plan="output"
      :default-value="MESH_DEFAULTS.replaceMain"
    />

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !numbers.valid" :title="numbers.reason" @click="run">
        Build Mesh
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
