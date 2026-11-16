<script setup>
// The raster size of Build DEM / Build Orthophoto: by cell size or by pixels on the
// longer side (`sizeBy`), one field for the chosen one, and a readout of the size the run
// will build (the store's estimateRasterSize, through `estimate`), so a GSD that a cap
// would coarsen shows before the run instead of in its log.
//
// `estimate`: 'loading' | null | { unavailable } | { width, height, gsd, coarsened,
// blocks, approx, auto } (core/products/rasterSize.js via stores/reconstruction/productRuns.js).
import { computed } from 'vue'
import SettingsField from './SettingsField.vue'
import WarnBox from './WarnBox.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { formatBytes } from '../../../core/formatBytes.js'
import { MAX_RASTER_SIDE } from '../../../core/products/rasterSize.js'
import { msg } from '../../../core/i18n/index.js'
import { t, tx } from '../../../composables/useI18n.js'

const props = defineProps({
  id: { type: String, required: true },
  op: { type: String, required: true }, // the guide doc: 'dem' | 'orthophoto'
  defaults: { type: Object, required: true }, // DEM_DEFAULTS / ORTHO_DEFAULTS
  unit: { type: String, required: true }, // the cell size unit, e.g. 'm/px'
  gsdHint: { type: [String, Object], default: '' },
  invalid: { type: Object, default: () => ({}) }, // checkNumberFields' `bad`
  estimate: { type: [Object, String], default: null },
  bytesPerCell: { type: Number, default: 4 },
})
const sizeBy = defineModel('sizeBy', { type: String, default: 'gsd' })
const gsd = defineModel('gsd', { type: Number, default: 0 })
const longSide = defineModel('longSide', { type: Number, default: 0 })

// A cell size: three significant digits, whole numbers from 100.
const cell = (g) => msg('dialog.rasterSize.cell', { g, whole: g >= 100 ? 'yes' : 'no' })
const readout = computed(() => {
  const e = props.estimate
  if (e === 'loading') return t('dialog.rasterSize.estimating')
  if (!e) return ''
  if (e.unavailable) return t('dialog.rasterSize.unavailable', { reason: tx(e.unavailable) })
  return t('dialog.rasterSize.readout', {
    approx: e.approx ? 'yes' : 'no',
    width: e.width,
    height: e.height,
    gsd: cell(e.gsd),
    unit: props.unit,
    bytes: formatBytes(e.width * e.height * props.bytesPerCell),
  })
})
const warning = computed(() => {
  const e = props.estimate
  // Auto's own cap is the step's effect line to say (stepEffects/raster.js); this is for
  // a size the user chose that the raster cap coarsened.
  if (!e || typeof e !== 'object' || !e.coarsened || e.auto) return ''
  return t('dialog.rasterSize.capped', {
    max: MAX_RASTER_SIDE,
    gsd: cell(e.gsd),
    requested: cell(e.requestedGsd),
    unit: props.unit,
  })
})
</script>

<template>
  <SettingsField :label-for="`${id}-sizeby`" :hint="t('dialog.rasterSize.sizeBy.hint')">
    <template #label
      ><FieldHelp :op="op" param="sizeBy">{{ t('dialog.rasterSize.sizeBy.label') }}</FieldHelp></template
    >
    <select :id="`${id}-sizeby`" v-model="sizeBy" class="field-input field-select">
      <option value="gsd">{{ t('dialog.rasterSize.sizeBy.gsd') }}</option>
      <option value="px">{{ t('dialog.rasterSize.sizeBy.px') }}</option>
    </select>
  </SettingsField>

  <SettingsField v-if="sizeBy === 'gsd'" :label-for="`${id}-gsd`" :unit="unit" :hint="tx(gsdHint)">
    <template #label>
      <FieldHelp :op="op" param="gsd" :value="gsd || 'Auto'" :default-value="defaults.gsd || 'Auto'">{{
        t('dialog.rasterSize.gsd.label')
      }}</FieldHelp>
    </template>
    <input
      :id="`${id}-gsd`"
      v-model.number="gsd"
      :aria-invalid="invalid.gsd"
      type="number"
      min="0"
      step="0.01"
      class="field-input"
    />
  </SettingsField>
  <SettingsField v-else :label-for="`${id}-longside`" unit="px" :hint="t('dialog.rasterSize.longSide.hint')">
    <template #label>
      <FieldHelp :op="op" param="longSide" :value="longSide || 'Auto'" :default-value="defaults.longSide || 'Auto'">{{
        t('dialog.rasterSize.longSide.label')
      }}</FieldHelp>
    </template>
    <input
      :id="`${id}-longside`"
      v-model.number="longSide"
      :aria-invalid="invalid.longSide"
      type="number"
      min="0"
      step="1"
      class="field-input"
    />
  </SettingsField>

  <p v-if="readout" class="field-hint size-readout" aria-live="polite">{{ readout }}</p>
  <WarnBox v-if="warning">{{ warning }}</WarnBox>
</template>

<style scoped src="./modal.css"></style>
<style scoped>
.field-select {
  width: 100%;
}
.size-readout {
  margin-top: -4px;
  color: var(--text);
}
</style>
