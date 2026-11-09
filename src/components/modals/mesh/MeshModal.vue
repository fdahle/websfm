<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsPresetsMenu from '../ui/SettingsPresetsMenu.vue'
import { useDialogSettings } from '../../../composables/useDialogSettings.js'
import SettingsField from '../ui/SettingsField.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import ShowAdvancedSettings from '../ui/ShowAdvancedSettings.vue'
import { provideStepLayout } from '../../../composables/useStepLayout.js'
import PresetCards from '../ui/PresetCards.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import WarnBox from '../ui/WarnBox.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import { useSourcePick, statusTags } from '../../../composables/useSourcePick.js'
import { usePresetSettings } from '../../../composables/usePresetSettings.js'
import FieldHelp from '../../guide/FieldHelp.vue'
import { MESH_DEFAULTS, MESH_PRESETS, MESH_PRESET_META } from '../../../core/defaults.user.js'
import { checkNumberFields } from '../../../utils/numberFields.js'
import { meshEffects, meshShorts } from '../../../core/stepEffects/mesh.js'
import { withShorts } from '../../../core/stepEffects/format.js'
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
  // (sourceId) → Auto depth's inputs { count, spacing, extent } | null (the store's
  // meshDepthInputs), so the effect line names the depth the run will pick.
  depthBasisOf: { type: Function, default: null },
})
const emit = defineEmits(['close', 'run'])

// The last run's settings in this project, and saved presets (useDialogSettings).
const dialog = useDialogSettings('mesh', MESH_DEFAULTS)
const settings = dialog.settings
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
const basis = computed(() => (source.value && props.depthBasisOf?.(sourceId.value)) ?? null)
const effects = computed(() => {
  const project = {
    source: source.value && { name: source.value.name, count: source.value.count },
    basis: basis.value,
  }
  return withShorts(meshEffects(settings.value, project), meshShorts(settings.value, project))
})

const TILE_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: 'off', label: 'Off' },
]

const TRIM_OPTIONS = [
  { id: 'off', label: 'Off' },
  { id: 'gentle', label: 'Gentle' },
  { id: 'strong', label: 'Strong' },
]

// Run stays disabled while a field is blank or out of range (rules = the inputs'
// own min/max/step); the floater size is only checked while that cleanup is on.
const numbers = computed(() =>
  checkNumberFields(settings.value, {
    depth: { label: 'Octree depth', min: 0, max: 12, integer: true },
    leafSpacings: { label: 'Leaf size', min: 1, max: 64, when: !(settings.value.depth > 0) },
    maxTriangles: {
      label: 'Triangle limit',
      min: 10000,
      max: 20000000,
      integer: true,
      when: !(settings.value.depth > 0),
    },
    screening: { label: 'Screening weight', min: 0, max: 16 },
    minPiecePct: { label: 'Floating piece size', min: 0, max: 50, when: settings.value.removeFloaters },
    distanceTrim: { label: 'Distance trim', min: 0, max: 32 },
  }),
)

// The machine's whole memory limit (Settings ▸ Compute): how many tiles solve at once.
const { memBudgetRamBytes } = useComputeSettings()

function run() {
  dialog.remember()
  emit('run', { ...settings.value, sourceId: sourceId.value, ramBudgetBytes: memBudgetRamBytes.value })
}

// One list of steps (useStepLayout.js): each registers for the step chain, its tuning
// folded in place.
provideStepLayout('mesh')
</script>

<template>
  <ModalShell title="Build Mesh" @close="emit('close')">
    <template #header>
      <span class="modal-title">Build Mesh</span>
      <SettingsPresetsMenu :dialog="dialog" />
    </template>
    <WarnBox v-if="!sources.length && !hasDense">
      No dense point cloud yet. Build one first (<strong>Reconstruct ▸ Dense Model</strong>): meshing reconstructs a
      surface over the dense cloud.
    </WarnBox>
    <WarnBox v-else-if="!sources.length">
      No dense cloud has per-point normals, which screened Poisson requires. Build the dense cloud again (<strong
        >Reconstruct ▸ Dense Model</strong
      >) to compute them, or estimate them (<strong>Tools ▸ Point Cloud ▾ ▸ Estimate normals…</strong>), then build the
      mesh.
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

    <SettingsStep step="1" title="Solve the surface" :effect="effects.solve" :more="settings.depth > 0 ? 3 : 5">
      <template #tuning>
        <SettingsField
          label-for="mesh-depth"
          unit="levels"
          hint="0 = Auto: picked from the cloud by the leaf size and triangle limit below."
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
            min="0"
            max="12"
            step="1"
            class="field-input"
          />
        </SettingsField>
        <template v-if="!(settings.depth > 0)">
          <SettingsField
            label-for="mesh-leaf"
            unit="× point spacing"
            hint="How fine Auto goes: the octree leaf it aims for, in the cloud's point spacings."
          >
            <template #label>
              <FieldHelp
                op="mesh"
                param="leafSpacings"
                :value="settings.leafSpacings"
                :default-value="MESH_DEFAULTS.leafSpacings"
                >Leaf size</FieldHelp
              >
            </template>
            <input
              id="mesh-leaf"
              v-model.number="settings.leafSpacings"
              :aria-invalid="numbers.bad.leafSpacings"
              type="number"
              min="1"
              max="64"
              step="1"
              class="field-input"
            />
          </SettingsField>
          <SettingsField
            label-for="mesh-maxtri"
            unit="triangles"
            hint="Auto lowers the depth until the mesh stays within this size."
          >
            <template #label>
              <FieldHelp
                op="mesh"
                param="maxTriangles"
                :value="settings.maxTriangles"
                :default-value="MESH_DEFAULTS.maxTriangles"
                >Triangle limit</FieldHelp
              >
            </template>
            <input
              id="mesh-maxtri"
              v-model.number="settings.maxTriangles"
              :aria-invalid="numbers.bad.maxTriangles"
              type="number"
              min="10000"
              max="20000000"
              step="10000"
              class="field-input"
            />
          </SettingsField>
        </template>
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
      </template>
    </SettingsStep>

    <SettingsStep step="2" title="Trim" :effect="effects.trim" :more="1">
      <SettingsField hint="How much of the closed Poisson surface is cut back to where the points are.">
        <template #label><FieldHelp op="mesh" param="trim">Surface trimming</FieldHelp></template>
        <SegmentedControl v-model="settings.trim" :options="TRIM_OPTIONS" />
      </SettingsField>

      <template #tuning>
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
      </template>
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
      :more="settings.removeFloaters ? 1 : 0"
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

      <template #tuning>
        <template v-if="settings.removeFloaters">
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
        </template>
      </template>
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

    <OutputStep
      v-model="settings.replaceMain"
      step="6"
      op="mesh"
      noun="mesh"
      :plan="output"
      :default-value="MESH_DEFAULTS.replaceMain"
    />

    <template #footer>
      <ShowAdvancedSettings />

      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !numbers.valid" :title="numbers.reason" @click="run">
        Build Mesh
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
