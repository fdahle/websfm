<script setup>
import { computed, reactive, ref, watch, onMounted } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import { hillshadeRgba } from '../../../core/products/colormap.js'
import { rampCss } from '../../../core/products/cloudStyle.js'
import {
  DEM_RAMPS,
  DEFAULT_DEM_STYLE,
  DEFAULT_ORTHO_STYLE,
  resolveDemStyle,
  resolveOrthoStyle,
  demRenderOptions,
  demThumbnailGrid,
} from '../../../core/products/productStyle.js'
import { orthoAdjustFilter } from '../../../utils/orthoFilter.js'

// Products ▸ right-click ▸ Symbology… for the computed DEM or orthophoto
// (core/products/productStyle.js). Display only: the heights / pixels are kept.
//
// The preview is live and cheap on purpose — a DEM thumbnail rendered here from a
// sampled copy of the grid, an ortho preview under the same SVG filter the tab
// uses — while Apply re-bakes the DEM's full preview in the worker.
const props = defineProps({ kind: { type: String, required: true }, product: { type: Object, required: true } })
const emit = defineEmits(['close', 'apply'])

const isDem = computed(() => props.kind === 'dem')
const draft = reactive(
  isDem.value ? { ...resolveDemStyle(props.product.style) } : { ...resolveOrthoStyle(props.product.style) },
)
// Seed the manual limits with the DEM's own range, so switching to Manual starts
// from the numbers the automatic range showed.
if (isDem.value && draft.min == null) {
  draft.min = props.product.zMin
  draft.max = props.product.zMax
}

const validRange = computed(
  () =>
    !isDem.value ||
    draft.range !== 'manual' ||
    (Number.isFinite(draft.min) && Number.isFinite(draft.max) && draft.max > draft.min),
)
const shownRange = computed(() =>
  draft.range === 'manual' && validRange.value ? [draft.min, draft.max] : [props.product.zMin, props.product.zMax],
)
const fmtZ = (v) => (Number.isFinite(v) ? Number(v.toPrecision(6)).toLocaleString() : '—')
const unit = computed(() => (props.product.unit && props.product.unit !== 'model' ? props.product.unit : ''))

// DEM: a ≤320 px thumbnail, re-rendered on every change.
const canvas = ref(null)
const thumb = isDem.value ? demThumbnailGrid(props.product) : null
function drawThumb() {
  const c = canvas.value
  if (!c || !thumb) return
  c.width = thumb.width
  c.height = thumb.height
  const style = validRange.value ? draft : { ...draft, range: 'auto' }
  c.getContext('2d').putImageData(
    new ImageData(hillshadeRgba(thumb, demRenderOptions(style, props.product)), thumb.width, thumb.height),
    0,
    0,
  )
}
onMounted(drawThumb)
watch(draft, drawThumb)

const orthoFilter = computed(() => (isDem.value ? null : orthoAdjustFilter(draft)))
const pct = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`

function reset() {
  Object.assign(
    draft,
    isDem.value ? { ...DEFAULT_DEM_STYLE, min: props.product.zMin, max: props.product.zMax } : DEFAULT_ORTHO_STYLE,
  )
}
function apply(close = false) {
  if (!validRange.value) return
  emit('apply', { kind: props.kind, style: { ...draft } })
  if (close) emit('close')
}
</script>

<template>
  <ModalShell :title="isDem ? 'DEM symbology' : 'Orthophoto symbology'" @close="emit('close')">
    <div class="heading">
      <strong>{{ product.name || (isDem ? 'DEM' : 'Orthophoto') }}</strong>
      <span>{{ product.width.toLocaleString() }} × {{ product.height.toLocaleString() }} px</span>
    </div>

    <div class="preview-box" :class="{ checker: !isDem }">
      <canvas v-if="isDem" ref="canvas" class="preview" />
      <img
        v-else-if="product.previewUrl"
        :src="product.previewUrl"
        class="preview"
        alt=""
        :style="{ filter: orthoFilter ?? undefined }"
      />
    </div>

    <template v-if="isDem">
      <SettingsField label="Colour ramp" label-for="dem-style-ramp">
        <select id="dem-style-ramp" v-model="draft.ramp" class="field-input field-select">
          <option v-for="r in DEM_RAMPS" :key="r.value" :value="r.value">{{ r.label }}</option>
        </select>
      </SettingsField>
      <div class="ramp" :style="{ background: rampCss(draft.ramp) }"></div>
      <div class="range-labels">
        <span>{{ fmtZ(shownRange[0]) }} {{ unit }}</span
        ><span>{{ fmtZ(shownRange[1]) }} {{ unit }}</span>
      </div>
      <SettingsField label="Height range" label-for="dem-style-range">
        <select id="dem-style-range" v-model="draft.range" class="field-input field-select">
          <option value="auto">Automatic (DEM min–max)</option>
          <option value="manual">Manual</option>
        </select>
      </SettingsField>
      <div v-if="draft.range === 'manual'" class="range-inputs">
        <SettingsField label="Minimum" label-for="dem-style-min"
          ><input id="dem-style-min" v-model.number="draft.min" type="number" step="any" class="field-input"
        /></SettingsField>
        <SettingsField label="Maximum" label-for="dem-style-max"
          ><input id="dem-style-max" v-model.number="draft.max" type="number" step="any" class="field-input"
        /></SettingsField>
      </div>
      <p v-if="!validRange" class="error">Maximum must be greater than minimum.</p>
      <p v-else-if="draft.range === 'manual'" class="field-hint">
        Heights outside the range take the ramp's end colours.
      </p>
      <label class="checkbox-row"><input v-model="draft.hillshade" type="checkbox" class="checkbox" /> Hillshade</label>
    </template>

    <template v-else>
      <SettingsField label="Brightness" label-for="ortho-style-brightness" :unit="pct(draft.brightness)">
        <input
          id="ortho-style-brightness"
          v-model.number="draft.brightness"
          type="range"
          min="-1"
          max="1"
          step="0.01"
          class="field-input range"
        />
      </SettingsField>
      <SettingsField label="Contrast" label-for="ortho-style-contrast" :unit="pct(draft.contrast)">
        <input
          id="ortho-style-contrast"
          v-model.number="draft.contrast"
          type="range"
          min="-1"
          max="1"
          step="0.01"
          class="field-input range"
        />
      </SettingsField>
      <SettingsField label="Gamma" label-for="ortho-style-gamma" :unit="draft.gamma.toFixed(2)">
        <input
          id="ortho-style-gamma"
          v-model.number="draft.gamma"
          type="range"
          min="0.2"
          max="3"
          step="0.05"
          class="field-input range"
        />
      </SettingsField>
      <p class="field-hint">Above 1 brightens midtones; 1 leaves them unchanged.</p>
    </template>

    <p class="field-hint">
      Changes the display only. Exports and value readouts use the original {{ isDem ? 'heights' : 'pixels'
      }}{{ isDem ? '; the hillshade PNG export uses this styling' : '' }}.
    </p>

    <template #footer>
      <button class="btn reset" @click="reset">Reset</button>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn" :disabled="!validRange" @click="apply()">Apply</button>
      <button class="btn btn-primary" :disabled="!validRange" @click="apply(true)">OK</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.heading span,
.range-labels {
  font-size: 12px;
  color: var(--text-dim);
}
.preview-box {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 120px;
  max-height: 220px;
  padding: 6px;
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  background: var(--bg);
}
.preview-box.checker {
  background-image:
    linear-gradient(45deg, rgba(128, 128, 128, 0.1) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128, 128, 128, 0.1) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128, 128, 128, 0.1) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128, 128, 128, 0.1) 75%);
  background-size: 20px 20px;
  background-position:
    0 0,
    0 10px,
    10px -10px,
    -10px 0;
}
.preview {
  max-width: 100%;
  max-height: 206px;
  object-fit: contain;
}
.ramp {
  height: 14px;
  border-radius: 4px;
}
.range-labels {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: -6px;
}
.range-inputs {
  display: flex;
  gap: 12px;
}
.range-inputs > * {
  flex: 1;
  min-width: 0;
}
.range-inputs .field-input {
  width: 100%;
}
.error {
  color: var(--danger);
  font-size: 12px;
}
.reset {
  margin-right: auto;
}
</style>
