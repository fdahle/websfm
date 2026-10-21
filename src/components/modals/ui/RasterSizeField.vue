<script setup>
// The raster size of Build DEM / Build Orthophoto: by cell size or by pixels on the
// longer side (`sizeBy`), one field for the chosen one, and a readout of the size the run
// will build (the store's estimateRasterSize, through `estimate`), so a GSD that a cap
// would coarsen shows before the run instead of in its log.
//
// `estimate`: 'loading' | null | { unavailable } | { width, height, gsd, coarsened,
// blocks, approx } (core/products/rasterSize.js via stores/reconstruction/productRuns.js).
import { computed } from 'vue'
import SettingsField from './SettingsField.vue'
import WarnBox from './WarnBox.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { formatBytes } from '../../../core/formatBytes.js'
import { MAX_RASTER_SIDE } from '../../../core/products/rasterSize.js'

const props = defineProps({
  id: { type: String, required: true },
  op: { type: String, required: true }, // the guide doc: 'dem' | 'orthophoto'
  defaults: { type: Object, required: true }, // DEM_DEFAULTS / ORTHO_DEFAULTS
  unit: { type: String, required: true }, // the cell size unit, e.g. 'm/px'
  gsdHint: { type: String, default: '' },
  invalid: { type: Object, default: () => ({}) }, // checkNumberFields' `bad`
  estimate: { type: [Object, String], default: null },
  bytesPerCell: { type: Number, default: 4 },
  autoCapped: { type: String, default: '' }, // why Auto stopped at one plane (DEM)
})
const sizeBy = defineModel('sizeBy', { type: String, default: 'gsd' })
const gsd = defineModel('gsd', { type: Number, default: 0 })
const longSide = defineModel('longSide', { type: Number, default: 0 })

const fmtGsd = (g) => (g >= 100 ? g.toFixed(0) : g.toPrecision(3))
const readout = computed(() => {
  const e = props.estimate
  if (e === 'loading') return 'Estimating the size…'
  if (!e) return ''
  if (e.unavailable) return `Raster size: ${e.unavailable}.`
  return (
    `${e.approx ? '≈ ' : ''}${e.width.toLocaleString()} × ${e.height.toLocaleString()} px at ` +
    `${fmtGsd(e.gsd)} ${props.unit} · ${formatBytes(e.width * e.height * props.bytesPerCell)} uncompressed`
  )
})
const warning = computed(() => {
  const e = props.estimate
  if (!e || typeof e !== 'object' || !e.coarsened) return ''
  if (!e.blocks) return props.autoCapped
  return (
    `A raster is at most ${MAX_RASTER_SIDE.toLocaleString()} px a side, so the run uses ${fmtGsd(e.gsd)} ` +
    `instead of ${fmtGsd(e.requestedGsd)} ${props.unit}. Limit the area (Tools ▸ Model ▸ Region) for a finer cell.`
  )
})
</script>

<template>
  <SettingsField
    :label-for="`${id}-sizeby`"
    hint="Set the cell size, or the pixels on the longer side and let the cell size follow from the extent."
  >
    <template #label><FieldHelp :op="op" param="sizeBy">Raster size by</FieldHelp></template>
    <select :id="`${id}-sizeby`" v-model="sizeBy" class="field-input field-select">
      <option value="gsd">Cell size (GSD)</option>
      <option value="px">Long side (px)</option>
    </select>
  </SettingsField>

  <SettingsField v-if="sizeBy === 'gsd'" :label-for="`${id}-gsd`" :unit="unit" :hint="gsdHint">
    <template #label>
      <FieldHelp :op="op" param="gsd" :value="gsd || 'Auto'" :default-value="defaults.gsd || 'Auto'"
        >Ground sample distance</FieldHelp
      >
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
  <SettingsField
    v-else
    :label-for="`${id}-longside`"
    unit="px"
    hint="Pixels on the longer side of the raster. 0 = auto."
  >
    <template #label>
      <FieldHelp :op="op" param="longSide" :value="longSide || 'Auto'" :default-value="defaults.longSide || 'Auto'"
        >Long side</FieldHelp
      >
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
