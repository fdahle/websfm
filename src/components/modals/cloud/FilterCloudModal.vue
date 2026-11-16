<script setup>
import FieldHelp from '../../guide/FieldHelp.vue'
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import ShowAdvancedSettings from '../ui/ShowAdvancedSettings.vue'
import { provideStepLayout } from '../../../composables/useStepLayout.js'
import PresetCards from '../ui/PresetCards.vue'
import WarnBox from '../ui/WarnBox.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import { useSourcePick } from '../../../composables/useSourcePick.js'
import { usePresetSettings } from '../../../composables/usePresetSettings.js'
import { FILTER_CLOUD_DEFAULTS, FILTER_CLOUD_PRESETS, FILTER_CLOUD_PRESET_META } from '../../../core/defaults.user.js'
import { filterCloudEffects, filterCloudShorts } from '../../../core/stepEffects/filterCloud.js'
import { withShorts } from '../../../core/stepEffects/format.js'
import I18nText from '../../I18nText.vue'
import { t } from '../../../composables/useI18n.js'

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
// What each step does to this cloud (core/stepEffects/filterCloud.js): messages,
// SettingsStep draws them in the user's language.
const effects = computed(() =>
  withShorts(
    filterCloudEffects(settings.value, { mergeCell: props.mergeCell }),
    filterCloudShorts(settings.value, { mergeCell: props.mergeCell }),
  ),
)

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
    name: t('filterCloud.resultName', { name: source.value?.name ?? t('common.cloud') }),
  })
}

// One list of steps (useStepLayout.js): each registers for the step chain, its tuning
// folded in place.
provideStepLayout('filter-cloud')
</script>

<template>
  <ModalShell
    :title="t(`filterCloud.title.${startMethod === 'sor' || startMethod === 'voxel' ? startMethod : 'filter'}`)"
    @close="emit('close')"
  >
    <WarnBox v-if="!clouds.length"><I18nText k="filterCloud.noCloud" /></WarnBox>

    <template v-else>
      <PresetCards
        :model-value="activePreset"
        :base-id="baseId"
        :presets="FILTER_CLOUD_PRESET_META"
        @select="selectPreset"
      />

      <SettingsGroup :title="t('common.source')">
        <SourcePicker
          id="filter-src"
          v-model="sourceId"
          :label="t('common.cloud')"
          :items="clouds"
          :hint="t('filterCloud.sourceHint')"
        />
      </SettingsGroup>

      <SettingsStep step="1" :title="t('filterCloud.step.range')" :effect="effects.range" :inactive="!has('range')">
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('range')" @change="toggle('range')" />
          {{ t('common.enabled') }}</label
        >
        <template v-if="has('range')">
          <SettingsField :hint="t('filterCloud.field.zRange.hint')">
            <template #label
              ><FieldHelp op="filter-cloud" param="zRange">{{
                t('filterCloud.field.zRange.label')
              }}</FieldHelp></template
            >
            <div class="input-row">
              <input
                v-model.number="settings.zMin"
                type="number"
                step="any"
                class="field-input"
                :placeholder="t('common.min')"
              />
              <input
                v-model.number="settings.zMax"
                type="number"
                step="any"
                class="field-input"
                :placeholder="t('common.max')"
              />
            </div>
          </SettingsField>
          <SettingsField unit="0–255" :hint="t('filterCloud.field.lumaRange.hint')">
            <template #label
              ><FieldHelp op="filter-cloud" param="lumaRange">{{
                t('filterCloud.field.lumaRange.label')
              }}</FieldHelp></template
            >
            <div class="input-row">
              <input
                v-model.number="settings.lumaMin"
                type="number"
                min="0"
                max="255"
                step="1"
                class="field-input"
                :placeholder="t('common.min')"
              />
              <input
                v-model.number="settings.lumaMax"
                type="number"
                min="0"
                max="255"
                step="1"
                class="field-input"
                :placeholder="t('common.max')"
              />
            </div>
          </SettingsField>
        </template>
      </SettingsStep>

      <SettingsStep
        step="2"
        :title="t('filterCloud.step.voxel')"
        :effect="effects.voxel"
        :inactive="!has('voxel')"
        :more="(has('voxel') || has('isolated') || has('sor')) && has('voxel') ? 1 : 0"
      >
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('voxel')" @change="toggle('voxel')" />
          {{ t('common.enabled') }}</label
        >

        <template #tuning>
          <template v-if="(has('voxel') || has('isolated') || has('sor')) && has('voxel')">
            <SettingsField
              label-for="filter-voxel"
              :unit="t('common.units')"
              :hint="
                mergeCell > 0 && !(settings.voxelCell > 0)
                  ? t('filterCloud.field.voxelCell.hintMerge', { cell: mergeCell })
                  : t('filterCloud.field.voxelCell.hintAuto')
              "
            >
              <template #label
                ><FieldHelp
                  op="filter-cloud"
                  param="voxelCell"
                  :value="settings.voxelCell"
                  :default-value="FILTER_CLOUD_DEFAULTS.voxelCell"
                  >{{ t('filterCloud.field.voxelCell.label') }}</FieldHelp
                ></template
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
          </template>
        </template>
      </SettingsStep>

      <SettingsStep
        step="3"
        :title="t('filterCloud.step.isolated')"
        :effect="effects.isolated"
        :inactive="!has('isolated')"
        :more="(has('voxel') || has('isolated') || has('sor')) && has('isolated') ? 3 : 0"
      >
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('isolated')" @change="toggle('isolated')" />
          {{ t('common.enabled') }}</label
        >

        <template #tuning>
          <template v-if="(has('voxel') || has('isolated') || has('sor')) && has('isolated')">
            <SettingsField
              label-for="filter-iso-cell"
              :unit="t('common.units')"
              :hint="t('filterCloud.field.isolatedCell.hint')"
            >
              <template #label
                ><FieldHelp
                  op="filter-cloud"
                  param="isolatedCell"
                  :value="settings.isolatedCell"
                  :default-value="FILTER_CLOUD_DEFAULTS.isolatedCell"
                  >{{ t('filterCloud.field.isolatedCell.label') }}</FieldHelp
                ></template
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
            <SettingsField label-for="filter-iso-nb" :hint="t('filterCloud.field.isolatedMinNeighbors.hint')">
              <template #label
                ><FieldHelp
                  op="filter-cloud"
                  param="isolatedMinNeighbors"
                  :value="settings.isolatedMinNeighbors"
                  :default-value="FILTER_CLOUD_DEFAULTS.isolatedMinNeighbors"
                  >{{ t('filterCloud.field.isolatedMinNeighbors.label') }}</FieldHelp
                ></template
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
              label-for="filter-iso-sup"
              :unit="t('filterCloud.field.isolatedMaxSupport.unit')"
              :hint="t('filterCloud.field.isolatedMaxSupport.hint')"
            >
              <template #label
                ><FieldHelp
                  op="filter-cloud"
                  param="isolatedMaxSupport"
                  :value="settings.isolatedMaxSupport"
                  :default-value="FILTER_CLOUD_DEFAULTS.isolatedMaxSupport"
                  >{{ t('filterCloud.field.isolatedMaxSupport.label') }}</FieldHelp
                ></template
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
          </template>
        </template>
      </SettingsStep>

      <SettingsStep
        step="4"
        :title="t('filterCloud.step.sor')"
        :effect="effects.sor"
        :inactive="!has('sor')"
        :more="(has('voxel') || has('isolated') || has('sor')) && has('sor') ? 2 : 0"
      >
        <label class="checkbox-row"
          ><input type="checkbox" class="checkbox" :checked="has('sor')" @change="toggle('sor')" />
          {{ t('common.enabled') }}</label
        >

        <template #tuning>
          <template v-if="(has('voxel') || has('isolated') || has('sor')) && has('sor')">
            <SettingsField label-for="filter-sor-k" :hint="t('filterCloud.field.sorK.hint')">
              <template #label
                ><FieldHelp
                  op="filter-cloud"
                  param="sorK"
                  :value="settings.sorK"
                  :default-value="FILTER_CLOUD_DEFAULTS.sorK"
                  >{{ t('filterCloud.field.sorK.label') }}</FieldHelp
                ></template
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
            <SettingsField label-for="filter-sor-std" unit="σ" :hint="t('filterCloud.field.sorStdRatio.hint')">
              <template #label
                ><FieldHelp
                  op="filter-cloud"
                  param="sorStdRatio"
                  :value="settings.sorStdRatio"
                  :default-value="FILTER_CLOUD_DEFAULTS.sorStdRatio"
                  >{{ t('filterCloud.field.sorStdRatio.label') }}</FieldHelp
                ></template
              >
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
          </template>
        </template>
      </SettingsStep>
    </template>

    <template #footer>
      <ShowAdvancedSettings />

      <button class="btn" @click="emit('close')">{{ t('common.cancel') }}</button>
      <button
        class="btn btn-primary"
        :disabled="!source || !settings.methods.length"
        :title="
          !source
            ? t('filterCloud.disabled.noCloud')
            : !settings.methods.length
              ? t('filterCloud.disabled.noFilter')
              : null
        "
        @click="run"
      >
        {{ t('filterCloud.run') }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
