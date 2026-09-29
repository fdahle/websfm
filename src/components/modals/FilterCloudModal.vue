<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import PresetCards from './ui/PresetCards.vue'
import WarnBox from './ui/WarnBox.vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import GradualSelectionModal from './GradualSelectionModal.vue'
import {
  FILTER_CLOUD_DEFAULTS, FILTER_CLOUD_PRESETS, FILTER_CLOUD_PRESET_META,
} from '../../core/defaults.user.js'

// Filter Cloud — remove noise from a dense cloud. Non-destructive: the run adds a
// NEW cloud. Defaults are the single source of truth in core/defaults.user.js;
// core/products/cloudEdit.js keeps matching fallbacks.
const props = defineProps({
  sparseCloud: { type: Object, default: null },
  clouds: { type: Array, default: () => [] },
  // The dense run's merge cell (≈ one ground-sample-distance), used as the sensible
  // auto voxel size. 0 when unknown (an imported cloud, or a legacy run).
  mergeCell: { type: Number, default: 0 },
})

const emit = defineEmits(['close', 'run'])
const gradual = ref(false)

const settings = ref({ ...FILTER_CLOUD_DEFAULTS })
const sourceId = ref(props.clouds[0]?.id ?? null)
const source = computed(() => props.clouds.find((c) => c.id === sourceId.value) ?? null)

// Methods run in the listed order, so the checkbox order IS the pipeline order:
// cheap linear rejections first, the neighbour sweep last over the smallest cloud.
const METHODS = [
  { id: 'range',    label: 'Elevation / brightness range' },
  { id: 'voxel',    label: 'Voxel downsample' },
  { id: 'isolated', label: 'Isolated clusters' },
  { id: 'sor',      label: 'Statistical outliers' },
]
const has = (id) => settings.value.methods.includes(id)
function toggle(id) {
  const on = has(id)
  settings.value.methods = METHODS
    .filter((m) => (m.id === id ? !on : has(m.id)))
    .map((m) => m.id)
}

const resolvePreset = (id) => ({ ...FILTER_CLOUD_DEFAULTS, ...FILTER_CLOUD_PRESETS[id] })
const baseId = ref('medium')
const activePreset = computed(() => {
  for (const { id } of FILTER_CLOUD_PRESET_META) {
    const r = resolvePreset(id)
    const same = Object.keys(r).every((k) => (k === 'methods'
      ? r.methods.join() === settings.value.methods.join()
      : settings.value[k] === r[k]))
    if (same) return id
  }
  return 'custom'
})
function selectPreset(id) {
  settings.value = { ...resolvePreset(id), methods: [...resolvePreset(id).methods] }
  baseId.value = id
}

// 0 ⇒ auto. Voxel auto uses the dense merge cell when we know it; the core module
// falls back to its own estimate otherwise.
const voxelAuto = computed(() => (settings.value.voxelCell > 0 ? settings.value.voxelCell : props.mergeCell))

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
  <GradualSelectionModal v-if="gradual && sparseCloud" :cloud="sparseCloud" @close="gradual = false" @run="emit('run', $event)" />
  <ModalShell v-else title="Filter Cloud" @close="emit('close')">
    <button v-if="sparseCloud" class="btn" @click="gradual = true">Sparse gradual selection…</button>
    <WarnBox v-if="!clouds.length">
      No dense cloud is available. Use sparse gradual selection above, or run <strong>Densify</strong> for dense filtering.
    </WarnBox>

    <template v-else>
      <PresetCards
        :model-value="activePreset"
        :base-id="baseId"
        :presets="FILTER_CLOUD_PRESET_META"
        @select="selectPreset"
      />

      <SettingsGroup title="Source">
        <SettingsField label="Cloud" label-for="filter-src"
          hint="The filter adds a new cloud; this one is left untouched.">
          <select id="filter-src" v-model="sourceId" class="field-select">
            <option v-for="c in clouds" :key="c.id" :value="c.id">
              {{ c.name }} — {{ c.count.toLocaleString() }} points
            </option>
          </select>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Filters">
        <SettingsField hint="Enabled filters run top to bottom, each on the previous one's output.">
          <label v-for="m in METHODS" :key="m.id" class="checkbox-row">
            <input type="checkbox" class="checkbox" :checked="has(m.id)" @change="toggle(m.id)" />
            {{ m.label }}
          </label>
        </SettingsField>
      </SettingsGroup>

      <AdvancedDisclosure label="Advanced settings">
        <SettingsGroup v-if="has('sor')" title="Statistical outliers">
          <SettingsField label="Neighbours" label-for="filter-sor-k"
            hint="How many nearest neighbours the per-point mean distance averages over.">
            <input id="filter-sor-k" v-model.number="settings.sorK" type="number" min="3" max="64" step="1" class="field-input" />
          </SettingsField>
          <SettingsField label="Std-dev ratio" label-for="filter-sor-std" unit="σ"
            hint="Drop points above mean + ratio × σ. Lower is more aggressive.">
            <input id="filter-sor-std" v-model.number="settings.sorStdRatio" type="number" min="0.1" max="10" step="0.1" class="field-input" />
          </SettingsField>
        </SettingsGroup>

        <SettingsGroup v-if="has('voxel')" title="Voxel downsample">
          <SettingsField label-for="filter-voxel" unit="units"
            :hint="mergeCell > 0 && !(settings.voxelCell > 0)
              ? `0 = auto (the dense run's merge cell, ${mergeCell.toPrecision(3)})`
              : '0 = auto (about one point spacing)'">
            <template #label>
              One averaged <GlossaryTerm id="point-cloud">point</GlossaryTerm> per cell
            </template>
            <input id="filter-voxel" v-model.number="settings.voxelCell" type="number" min="0" step="any" class="field-input" />
          </SettingsField>
        </SettingsGroup>

        <SettingsGroup v-if="has('isolated')" title="Isolated clusters">
          <SettingsField label="Cell size" label-for="filter-iso-cell" unit="units"
            hint="Occupancy grid cell. 0 = auto (about 4× the point spacing).">
            <input id="filter-iso-cell" v-model.number="settings.isolatedCell" type="number" min="0" step="any" class="field-input" />
          </SettingsField>
          <SettingsField label="Min occupied neighbours" label-for="filter-iso-nb"
            hint="A low-support cell needs this many of its 26 neighbours occupied to survive.">
            <input id="filter-iso-nb" v-model.number="settings.isolatedMinNeighbors" type="number" min="1" max="26" step="1" class="field-input" />
          </SettingsField>
          <SettingsField label="Max tested support" label-for="filter-iso-sup" unit="points"
            hint="Cells holding more points than this are never tested — they are real surface.">
            <input id="filter-iso-sup" v-model.number="settings.isolatedMaxSupport" type="number" min="1" max="64" step="1" class="field-input" />
          </SettingsField>
        </SettingsGroup>

        <SettingsGroup v-if="has('range')" title="Elevation / brightness range">
          <SettingsField label="Elevation (Z)" hint="Leave empty for unbounded.">
            <div class="input-row">
              <input v-model.number="settings.zMin" type="number" step="any" class="field-input" placeholder="min" />
              <input v-model.number="settings.zMax" type="number" step="any" class="field-input" placeholder="max" />
            </div>
          </SettingsField>
          <SettingsField label="Brightness" unit="0–255"
            hint="Rec. 709 luma. Ignored on a cloud with no colour.">
            <div class="input-row">
              <input v-model.number="settings.lumaMin" type="number" min="0" max="255" step="1" class="field-input" placeholder="min" />
              <input v-model.number="settings.lumaMax" type="number" min="0" max="255" step="1" class="field-input" placeholder="max" />
            </div>
          </SettingsField>
        </SettingsGroup>
      </AdvancedDisclosure>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !settings.methods.length" @click="run">Filter</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
