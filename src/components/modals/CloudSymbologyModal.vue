<script setup>
import { computed, reactive, watch } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import { resolveCloudStyle, styleFields, classEntries, scalarRange, sharedElevationRange, rampCss, countOf } from '../../core/products/cloudStyle.js'

const props = defineProps({ cloud: { type: Object, required: true }, clouds: { type: Array, default: () => [] } })
const emit = defineEmits(['close', 'apply'])
const draft = reactive(JSON.parse(JSON.stringify(resolveCloudStyle(props.cloud))))
const fields = computed(() => styleFields(props.cloud))
watch(() => draft.field, field => {
  if (field !== 'elevation' && draft.range === 'local') draft.range = 'auto'
})
const entries = computed(() => classEntries(props.cloud))
for (const entry of entries.value) {
  draft.classes[entry.value] = { colour: entry.colour, visible: true, ...draft.classes[entry.value] }
}
const isScalar = computed(() => !['rgb', 'single', 'attribute:classification'].includes(draft.field))
const automaticRange = computed(() => {
  if (!isScalar.value) return null
  if (draft.field === 'elevation' && draft.range === 'auto') {
    return sharedElevationRange([...props.clouds.filter(c => c.id !== props.cloud.id), { ...props.cloud, style: draft }])
  }
  return scalarRange(props.cloud, draft.field)
})
const validRange = computed(() => !isScalar.value || draft.range !== 'manual'
  || (Number.isFinite(draft.min) && Number.isFinite(draft.max) && draft.max > draft.min))
const displayedRange = computed(() => draft.range === 'manual' && validRange.value ? draft : automaticRange.value)
function apply(close = false) {
  if (!validRange.value) return
  emit('apply', { id: props.cloud.id, style: JSON.parse(JSON.stringify(draft)) })
  if (close) emit('close')
}
</script>

<template>
  <ModalShell title="Point cloud symbology" @close="emit('close')">
    <div class="cloud-heading"><strong>{{ cloud.name }}</strong><span>{{ countOf(cloud).toLocaleString() }} {{ cloud.kind === 'mesh' ? 'vertices' : 'points' }}</span></div>
    <SettingsField label="Colour by" label-for="cloud-style-field">
      <select id="cloud-style-field" v-model="draft.field" class="field-input field-select"><option v-for="field in fields" :key="field.value" :value="field.value">{{ field.label }}</option></select>
    </SettingsField>
    <p v-if="draft.field === 'rgb'" class="field-hint">Use the original RGB colours stored in this cloud.</p>
    <SettingsField v-else-if="draft.field === 'single'" label="Colour" label-for="cloud-style-colour">
      <input id="cloud-style-colour" v-model="draft.colour" type="color" />
    </SettingsField>
    <template v-else-if="draft.field === 'attribute:classification'">
      <div class="class-heading"><span>Classes present in this cloud</span><span>Points</span></div>
      <div class="class-list">
        <div v-for="entry in entries" :key="entry.value" class="class-row">
          <input v-if="cloud.kind !== 'mesh'" v-model="draft.classes[entry.value].visible" type="checkbox" class="checkbox" :aria-label="`Show ${entry.label}`" />
          <input v-model="draft.classes[entry.value].colour" type="color" :aria-label="`${entry.label} colour`" />
          <span>{{ entry.value }} · {{ entry.label }}</span><span class="class-count">{{ entry.count.toLocaleString() }}</span>
        </div>
      </div>
    </template>
    <template v-else>
      <SettingsField label="Colour ramp" label-for="cloud-style-ramp">
        <select id="cloud-style-ramp" v-model="draft.ramp" class="field-input field-select"><option value="viridis">Viridis</option><option value="turbo">Blue → red</option><option value="gray">Greyscale</option><option value="rdylgn">Red → green</option><option value="rdbu">Blue → white → red</option></select>
      </SettingsField>
      <div class="ramp" :style="{ background: rampCss(draft.ramp) }"></div>
      <div class="range-labels"><span>{{ displayedRange?.min.toLocaleString() }}</span><span>{{ displayedRange?.max.toLocaleString() }}</span></div>
      <SettingsField label="Range" label-for="cloud-style-range">
        <select id="cloud-style-range" v-model="draft.range" class="field-input field-select">
          <option value="auto">{{ draft.field === 'elevation' ? 'Automatic (all elevation clouds)' : 'Automatic (this cloud)' }}</option>
          <option v-if="draft.field === 'elevation'" value="local">Automatic (this cloud only)</option>
          <option value="manual">Manual</option>
        </select>
      </SettingsField>
      <p v-if="draft.field === 'elevation' && draft.range === 'auto'" class="field-hint">A shared height range keeps colours comparable across elevation clouds using the same ramp. Hidden clouds stay in the range.</p>
      <div v-if="draft.range === 'manual'" class="range-inputs">
        <SettingsField label="Minimum" label-for="cloud-style-min"><input id="cloud-style-min" v-model.number="draft.min" type="number" step="any" class="field-input" /></SettingsField>
        <SettingsField label="Maximum" label-for="cloud-style-max"><input id="cloud-style-max" v-model.number="draft.max" type="number" step="any" class="field-input" /></SettingsField>
      </div>
      <p v-if="!validRange" class="error">Maximum must be greater than minimum.</p>
    </template>
    <SettingsField label="Opacity" label-for="cloud-style-opacity" :unit="`${Math.round(draft.opacity * 100)}%`">
      <input id="cloud-style-opacity" v-model.number="draft.opacity" type="range" min="0" max="1" step="0.01" class="field-input range" />
    </SettingsField>
    <p class="field-hint">Only fields stored in this cloud are listed. Styling changes its display; original point values are preserved.</p>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn" :disabled="!validRange" @click="apply()">Apply</button>
      <button class="btn btn-primary" :disabled="!validRange" @click="apply(true)">OK</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.cloud-heading { display: flex; flex-direction: column; gap: 4px; font-size: 13px; overflow-wrap: anywhere; }
.cloud-heading span, .class-count, .range-labels { font-size: 12px; color: var(--text-dim); }
input[type='color'] { width: 28px; height: 26px; padding: 1px; border: 1px solid var(--panel-border); background: transparent; border-radius: 4px; cursor: pointer; }
.class-heading, .range-labels { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }
.range-labels { margin-top: -6px; }
.class-list { max-height: 260px; overflow: auto; margin-bottom: 18px; }
.class-row { display: flex; align-items: center; gap: 10px; padding: 5px 0; font-size: 12px; }
.class-count { margin-left: auto; font-variant-numeric: tabular-nums; }
.ramp { height: 14px; border-radius: 4px; }
.range-inputs { display: flex; gap: 12px; }
.range-inputs > * { flex: 1; min-width: 0; }
.range-inputs .field-input { width: 100%; }
.error { color: var(--danger); font-size: 12px; }
</style>
