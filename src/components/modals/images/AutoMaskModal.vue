<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import ShowAdvancedSettings from '../ui/ShowAdvancedSettings.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { provideStepLayout } from '../../../composables/useStepLayout.js'
import { AUTO_MASK_DEFAULTS } from '../../../core/defaults.user.js'
import { autoMaskEffects, autoMaskShorts, autoMaskDoesSomething } from '../../../core/stepEffects/autoMask.js'
import { withShorts } from '../../../core/stepEffects/format.js'
import { t } from '../../../composables/useI18n.js'

// Auto Mask (Tools ▸ Images ▾): masks from a rule rather than a painted or imported
// file, in two steps the run applies in this order: the edges (a fixed strip, or the
// film frame found on each scan) and the text on the photos; then the result is merged
// with or replaces a mask a photo already has. Run closes the dialog and the masks are
// written in the progress window (composables/useAutoMaskRun.js). Masked pixels are
// EXCLUDED from feature detection and depth maps on their next run (core/mask.js).
const props = defineProps({
  images: { type: Array, default: () => [] },
  sensors: { type: Array, default: () => [] },
  // Whether the photos' text has been read (useImagesStore hasPhotoText).
  hasText: { type: Function, default: () => false },
})
const emit = defineEmits(['close', 'run'])

const SIDE_KEYS = ['top', 'right', 'bottom', 'left']
const D = AUTO_MASK_DEFAULTS
const filmProject = props.sensors.some((s) => s.kind === 'film')
const settings = ref({
  edges: D.edges ?? (filmProject ? 'frame' : 'off'),
  sides: Object.fromEntries(SIDE_KEYS.map((k) => [k, D.border])),
  linked: D.linked,
  frameInset: D.frameInset,
  text: D.text,
  textPad: D.textPad,
  textRecurring: D.textRecurring,
  existing: D.existing,
})

// Which photos: all, or those of one sensor (a film roll, a camera) when there are
// several.
const scope = ref('all')
const scopeOptions = computed(() => {
  const counts = new Map()
  for (const img of props.images) counts.set(img.sensorId, (counts.get(img.sensorId) ?? 0) + 1)
  const used = props.sensors.filter((s) => counts.has(s.id))
  return [
    { id: 'all', label: t('autoMask.photos.all', { n: props.images.length }) },
    ...(used.length > 1
      ? used.map((s) => ({ id: s.id, label: t('autoMask.photos.sensor', { name: s.label, n: counts.get(s.id) }) }))
      : []),
  ]
})
const photos = computed(() =>
  scope.value === 'all' ? props.images : props.images.filter((img) => img.sensorId === scope.value),
)
const sized = computed(() => photos.value.filter((img) => img.meta?.width > 0 && img.meta?.height > 0))

const methods = computed(() => [
  { id: 'off', label: t('autoMask.edges.off') },
  { id: 'strip', label: t('autoMask.edges.strip') },
  { id: 'frame', label: t('autoMask.edges.frame') },
])

function onSideInput(key, e) {
  const v = Math.max(0, Math.round(Number(e.target.value) || 0))
  const s = settings.value.sides
  if (settings.value.linked) for (const k of SIDE_KEYS) s[k] = v
  else s[key] = v
}
// The four margins as the help box's "Current" value: one number while all agree.
const borderText = computed(() => {
  const v = SIDE_KEYS.map((k) => settings.value.sides[k])
  return `${v.every((x) => x === v[0]) ? v[0] : v.join(' / ')} ${t('autoMask.px')}`
})

// What each step does to these photos (core/stepEffects/autoMask.js).
const effects = computed(() => {
  const project = {
    photos: sized.value.length,
    unsized: photos.value.length - sized.value.length,
    unread: sized.value.filter((img) => !props.hasText(img)).length,
    masked: sized.value.filter((img) => img.mask).length,
  }
  return withShorts(autoMaskEffects(settings.value, project), autoMaskShorts(settings.value))
})
const masked = computed(() => sized.value.some((img) => img.mask))

const runReason = computed(() =>
  !sized.value.length
    ? t('autoMask.disabled.noSizes')
    : !autoMaskDoesSomething(settings.value)
      ? t('autoMask.disabled.nothing')
      : null,
)

function run() {
  const s = settings.value
  emit('run', {
    imageIds: photos.value.map((img) => img.id),
    edges: s.edges,
    sides: { ...s.sides },
    frameInset: s.frameInset,
    text: s.text,
    textPad: s.textPad,
    textRecurring: s.textRecurring,
    existing: s.existing,
  })
}

provideStepLayout('auto-mask')
</script>

<template>
  <ModalShell class="auto-mask" :title="t('autoMask.title')" @close="emit('close')">
    <p class="field-hint">{{ t('autoMask.intro') }}</p>

    <SourcePicker
      id="am-photos"
      v-model="scope"
      variant="inline"
      :label="t('autoMask.photos.label')"
      :items="scopeOptions"
      :option-label="(o) => o.label"
    />

    <SettingsStep
      step="1"
      :title="t('autoMask.step.edges')"
      :effect="effects.edges"
      :inactive="settings.edges === 'off'"
      :more="settings.edges === 'off' ? 0 : null"
    >
      <SettingsField>
        <template #label
          ><FieldHelp op="masks" param="edges">{{ t('autoMask.edges.method') }}</FieldHelp></template
        >
        <SegmentedControl v-model="settings.edges" :options="methods" />
      </SettingsField>
      <SettingsField v-if="settings.edges === 'strip'" :unit="t('autoMask.px')">
        <template #label
          ><FieldHelp
            op="masks"
            param="border"
            :value="borderText"
            :default-value="`${AUTO_MASK_DEFAULTS.border} px`"
            >{{ t('autoMask.edges.strip') }}</FieldHelp
          ></template
        >
        <div class="sides">
          <label v-for="k in SIDE_KEYS" :key="k" class="side">
            <span class="side-label">{{ t(`autoMask.edges.side.${k}`) }}</span>
            <input
              class="field-input"
              type="number"
              min="0"
              step="1"
              :value="settings.sides[k]"
              @input="onSideInput(k, $event)"
            />
          </label>
        </div>
      </SettingsField>

      <template #tuning>
        <label v-if="settings.edges === 'strip'" class="checkbox-row"
          ><input v-model="settings.linked" type="checkbox" class="checkbox" />
          <FieldHelp op="masks" param="linked" :value="settings.linked" :default-value="AUTO_MASK_DEFAULTS.linked">{{
            t('autoMask.edges.linked')
          }}</FieldHelp></label
        >
        <SettingsField v-if="settings.edges === 'frame'" label-for="am-inset" :unit="t('autoMask.edges.insetUnit')">
          <template #label
            ><FieldHelp
              op="masks"
              param="frameInset"
              :value="settings.frameInset"
              :default-value="AUTO_MASK_DEFAULTS.frameInset"
              >{{ t('autoMask.edges.inset') }}</FieldHelp
            ></template
          >
          <input
            id="am-inset"
            v-model.number="settings.frameInset"
            class="field-input"
            type="number"
            min="0"
            max="10"
            step="0.1"
          />
        </SettingsField>
      </template>
    </SettingsStep>

    <SettingsStep
      step="2"
      :title="t('autoMask.step.text')"
      :effect="effects.text"
      :inactive="!settings.text"
      :more="settings.text ? null : 0"
      experimental="textMask"
    >
      <label class="checkbox-row"
        ><input v-model="settings.text" type="checkbox" class="checkbox" />
        <FieldHelp op="masks" param="text" :value="settings.text" :default-value="AUTO_MASK_DEFAULTS.text">{{
          t('autoMask.text.enabled')
        }}</FieldHelp></label
      >

      <template #tuning>
        <template v-if="settings.text">
          <SettingsField label-for="am-pad" :unit="t('autoMask.px')">
            <template #label
              ><FieldHelp
                op="masks"
                param="textPad"
                :value="settings.textPad"
                :default-value="AUTO_MASK_DEFAULTS.textPad"
                >{{ t('autoMask.text.pad') }}</FieldHelp
              ></template
            >
            <input id="am-pad" v-model.number="settings.textPad" class="field-input" type="number" min="0" step="1" />
          </SettingsField>
          <label class="checkbox-row"
            ><input v-model="settings.textRecurring" type="checkbox" class="checkbox" />
            <FieldHelp
              op="masks"
              param="textRecurring"
              :value="settings.textRecurring"
              :default-value="AUTO_MASK_DEFAULTS.textRecurring"
              >{{ t('autoMask.text.recurring') }}</FieldHelp
            ></label
          >
        </template>
      </template>
    </SettingsStep>

    <SettingsStep step="3" :title="t('autoMask.step.existing')" :effect="effects.existing" :inactive="!masked">
      <SettingsField>
        <template #label
          ><FieldHelp op="masks" param="existing">{{ t('autoMask.existing.label') }}</FieldHelp></template
        >
        <div class="input-row">
          <label class="checkbox-row"
            ><input v-model="settings.existing" type="radio" class="checkbox" value="merge" />
            {{ t('autoMask.existing.merge') }}</label
          >
          <label class="checkbox-row"
            ><input v-model="settings.existing" type="radio" class="checkbox" value="replace" />
            {{ t('autoMask.existing.replace') }}</label
          >
        </div>
      </SettingsField>
    </SettingsStep>

    <template #footer>
      <ShowAdvancedSettings />
      <button class="btn" @click="emit('close')">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" :disabled="!!runReason" :title="runReason" @click="run">
        {{ t('autoMask.run', { n: sized.length }) }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.sides {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}
.side {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.side-label {
  font-size: 12px;
  color: var(--text-dim);
}
.side .field-input {
  width: 64px;
}
</style>
