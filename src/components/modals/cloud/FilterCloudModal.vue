<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import AdvancedDisclosure from '../ui/AdvancedDisclosure.vue'
import PresetCards from '../ui/PresetCards.vue'
import WarnBox from '../ui/WarnBox.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import { useSourcePick } from '../../../composables/useSourcePick.js'
import { usePresetSettings } from '../../../composables/usePresetSettings.js'
import GlossaryTerm from '../../glossary/GlossaryTerm.vue'
import { FILTER_CLOUD_DEFAULTS, FILTER_CLOUD_PRESETS, FILTER_CLOUD_PRESET_META } from '../../../core/defaults.user.js'
import { filterCloudEffects } from '../../../core/stepEffects/filterCloud.js'

// Filter Cloud — remove noise from a dense cloud. Non-destructive: the run adds a
// NEW cloud. Defaults are the single source of truth in core/defaults.user.js;
// core/products/cloudEdit.js keeps matching fallbacks. (Sparse gradual selection
// is its own tool now — Tools ▸ Model ▾ — since it acts on the model, not a cloud.)
const props = defineProps({
  clouds: { type: Array, default: () => [] },
  // The dense run's merge cell (≈ one ground-sample-distance), used as the sensible
  // auto voxel size. 0 when unknown (an imported cloud, or a legacy run).
  mergeCell: { type: Number, default: 0 },
  // A deep link (Point Cloud ▾ ▸ Remove outliers / Subsample) starts on ONE
  // method, with its settings open; null ⇒ the normal preset.
  startMethod: { type: String, default: null },
  // The cloud selected when the dialog opened (falls back to the first one).
  initialId: { type: String, default: null },
})

const emit = defineEmits(['close', 'run'])

const settings = ref({
  ...FILTER_CLOUD_DEFAULTS,
  methods: props.startMethod ? [props.startMethod] : [...FILTER_CLOUD_DEFAULTS.methods],
})
const { id: sourceId, item: source } = useSourcePick(() => props.clouds, { initialId: props.initialId })

// Methods run in this order, so the numbered steps ARE the pipeline order: cheap
// linear rejections first, the neighbour sweep last over the smallest cloud.
const METHODS = ['range', 'voxel', 'isolated', 'sor']
const has = (id) => settings.value.methods.includes(id)
function toggle(id) {
  const on = has(id)
  settings.value.methods = METHODS.filter((m) => (m === id ? !on : has(m)))
}

// A card (and Reset) restores every filter setting; any edit reads as "· modified".
const { baseId, activePreset, selectPreset } = usePresetSettings({
  settings,
  defaults: FILTER_CLOUD_DEFAULTS,
  presets: FILTER_CLOUD_PRESETS,
  cards: FILTER_CLOUD_PRESET_META,
  ownedKeys: Object.keys(FILTER_CLOUD_DEFAULTS),
})

// 0 ⇒ auto. Voxel auto uses the dense merge cell when we know it; the core module
// falls back to its own estimate otherwise.
const voxelAuto = computed(() => (settings.value.voxelCell > 0 ? settings.value.voxelCell : props.mergeCell))
// What each step does to this cloud (core/stepEffects/filterCloud.js).
const effects = computed(() => filterCloudEffects(settings.value, { mergeCell: props.mergeCell }))

function run() {
  const s = settings.value
  const nz = (v) => (Number.isFinite(v) ? v : null)
  emit('run', {
    sourceIds: [sourceId.value],
    settings: {
      methods: [...s.methods],
      sor: { k: s.sorK, stdRatio: s.sorStdRatio },
      voxel: { cell: voxelAuto.value },
      isolated: {
        cell: s.isolatedCell,
        minNeighbors: s.isolatedMinNeighbors,
        maxSupport: s.isolatedMaxSupport,
      },
      range: { zMin: nz(s.zMin), zMax: nz(s.zMax), lumaMin: nz(s.lumaMin), lumaMax: nz(s.lumaMax) },
    },
    name: `${source.value?.name ?? 'Cloud'} (filtered)`,
  })
}
</script>

<template>
  <ModalShell
    :title="startMethod === 'sor' ? 'Remove Outliers' : startMethod === 'voxel' ? 'Subsample Cloud' : 'Filter Cloud'"
    @close="emit('close')"
  >
    <WarnBox v-if="!clouds.length">
      No dense cloud is available. Run <strong>Dense Model</strong> first, or import one. To clean the sparse model, use
      <strong>Tools ▸ Model ▸ Gradual selection</strong>.
    </WarnBox>

    <template v-else>
      <PresetCards
        :model-value="activePreset"
        :base-id="baseId"
        :presets="FILTER_CLOUD_PRESET_META"
        @select="selectPreset"
      />

      <SettingsGroup title="Source">
        <SourcePicker
          id="filter-src"
          v-model="sourceId"
          label="Cloud"
          :items="clouds"
          hint="The filter adds a new cloud; this one is left untouched."
        />
      </SettingsGroup>

      <SettingsStep step="1" title="Elevation / brightness range" :effect="effects.range" :inactive="!has('range')">
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('range')" @change="toggle('range')" /> Enabled</label
        >
        <template v-if="has('range')">
          <SettingsField label="Elevation (Z)" hint="Leave empty for unbounded.">
            <div class="input-row">
              <input v-model.number="settings.zMin" type="number" step="any" class="field-input" placeholder="min" />
              <input v-model.number="settings.zMax" type="number" step="any" class="field-input" placeholder="max" />
            </div>
          </SettingsField>
          <SettingsField label="Brightness" unit="0–255" hint="Rec. 709 luma. Ignored on a cloud with no colour.">
            <div class="input-row">
              <input
                v-model.number="settings.lumaMin"
                type="number"
                min="0"
                max="255"
                step="1"
                class="field-input"
                placeholder="min"
              />
              <input
                v-model.number="settings.lumaMax"
                type="number"
                min="0"
                max="255"
                step="1"
                class="field-input"
                placeholder="max"
              />
            </div>
          </SettingsField>
        </template>
      </SettingsStep>

      <SettingsStep step="2" title="Voxel downsample" :effect="effects.voxel" :inactive="!has('voxel')">
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('voxel')" @change="toggle('voxel')" /> Enabled</label
        >
      </SettingsStep>

      <SettingsStep step="3" title="Isolated clusters" :effect="effects.isolated" :inactive="!has('isolated')">
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('isolated')" @change="toggle('isolated')" />
          Enabled</label
        >
      </SettingsStep>

      <SettingsStep step="4" title="Statistical outliers" :effect="effects.sor" :inactive="!has('sor')">
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('sor')" @change="toggle('sor')" /> Enabled</label
        >
      </SettingsStep>

      <AdvancedDisclosure
        v-if="has('voxel') || has('isolated') || has('sor')"
        label="Advanced settings"
        :default-open="!!startMethod"
      >
        <SettingsStep v-if="has('voxel')" step="2" title="Voxel downsample — advanced">
          <SettingsField
            label="Cell size"
            label-for="filter-voxel"
            unit="units"
            :hint="
              mergeCell > 0 && !(settings.voxelCell > 0)
                ? `0 = auto (the dense run's merge cell, ${mergeCell.toPrecision(3)})`
                : '0 = auto (about one point spacing)'
            "
          >
            <input
              id="filter-voxel"
              v-model.number="settings.voxelCell"
              type="number"
              min="0"
              step="any"
              class="field-input"
            />
          </SettingsField>
        </SettingsStep>

        <SettingsStep v-if="has('isolated')" step="3" title="Isolated clusters — advanced">
          <SettingsField
            label="Cell size"
            label-for="filter-iso-cell"
            unit="units"
            hint="Occupancy grid cell. 0 = auto (about 4× the point spacing)."
          >
            <input
              id="filter-iso-cell"
              v-model.number="settings.isolatedCell"
              type="number"
              min="0"
              step="any"
              class="field-input"
            />
          </SettingsField>
          <SettingsField
            label="Min occupied neighbours"
            label-for="filter-iso-nb"
            hint="A low-support cell needs this many of its 26 neighbours occupied to survive."
          >
            <input
              id="filter-iso-nb"
              v-model.number="settings.isolatedMinNeighbors"
              type="number"
              min="1"
              max="26"
              step="1"
              class="field-input"
            />
          </SettingsField>
          <SettingsField
            label="Max tested support"
            label-for="filter-iso-sup"
            unit="points"
            hint="Cells holding more points than this are never tested — they are real surface."
          >
            <input
              id="filter-iso-sup"
              v-model.number="settings.isolatedMaxSupport"
              type="number"
              min="1"
              max="64"
              step="1"
              class="field-input"
            />
          </SettingsField>
        </SettingsStep>

        <SettingsStep v-if="has('sor')" step="4" title="Statistical outliers — advanced">
          <SettingsField
            label="Neighbours"
            label-for="filter-sor-k"
            hint="How many nearest neighbours the per-point mean distance averages over."
          >
            <input
              id="filter-sor-k"
              v-model.number="settings.sorK"
              type="number"
              min="3"
              max="64"
              step="1"
              class="field-input"
            />
          </SettingsField>
          <SettingsField
            label-for="filter-sor-std"
            unit="σ"
            hint="Drop points above mean + ratio × σ. Lower is more aggressive."
          >
            <template #label><GlossaryTerm id="statistical-outlier-removal">Std-dev ratio</GlossaryTerm></template>
            <input
              id="filter-sor-std"
              v-model.number="settings.sorStdRatio"
              type="number"
              min="0.1"
              max="10"
              step="0.1"
              class="field-input"
            />
          </SettingsField>
        </SettingsStep>
      </AdvancedDisclosure>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !settings.methods.length" @click="run">Filter</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
