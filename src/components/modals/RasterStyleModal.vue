<script setup>
import { ref, computed, watch } from 'vue'
import { STRETCH_MODES, INDEX_PRESETS, resolveRasterStyle, describeStyle } from '../../core/io/rasterStyle.js'
import { RAMPS } from '../../core/products/colormap.js'

// Band math + contrast stretch for a multi-band / high-bit-depth reference
// raster. Opens from the Reference Data row's "Style bands…".
//
// Applying is a RE-DECODE of the original file (the stored plane is baked 8-bit
// RGBA — see useExternalStore.setRasterStyle), which on a 5000×5000 uint16 scene
// is seconds, not milliseconds. That is why this modal has an explicit Apply
// rather than a live preview on every dropdown change: a preview that re-reads
// 300 MB per keystroke would be worse than no preview. The header preview is the
// CURRENT style's thumbnail, so the user can see what they're changing away from.
const props = defineProps({ raster: { type: Object, required: true } })
const emit = defineEmits(['close', 'apply'])

const bandCount = computed(() => Math.max(1, props.raster.bands || 1))
const bandOptions = computed(() =>
  Array.from({ length: bandCount.value }, (_, i) => ({ value: i, label: `Band ${i + 1}` })))

// Seed from the raster's current style, normalised against its band count.
const s = ref(resolveRasterStyle(props.raster.style, props.raster))
watch(() => props.raster, (r) => { s.value = resolveRasterStyle(r.style, r) })

const isIndex = computed(() => s.value.mode === 'index')
const preset = computed(() => INDEX_PRESETS[s.value.index] || INDEX_PRESETS.ndvi)
const rampNames = Object.keys(RAMPS)

// Manual limits are per channel, and only meaningful once the user picks
// 'manual' — prefill them from the ranges the last decode actually resolved so
// the numbers start somewhere sane instead of at 0/1.
watch(() => s.value.stretch, (mode) => {
  if (mode !== 'manual' || s.value.manual) return
  const ranges = props.raster.style?.ranges
  s.value.manual = (ranges?.length ? ranges : [[0, 1]]).map((r) => (r ? [r[0], r[1]] : [0, 1]))
})

const summary = computed(() => describeStyle(s.value))

function apply() {
  // Strip the echoed-back ranges: they describe the PREVIOUS decode, and
  // carrying them into the next one would pin a percentile stretch to stale
  // limits. Manual limits are the user's input and do carry.
  const { ranges, ...style } = s.value
  emit('apply', { id: props.raster.id, style })
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Style raster bands">
      <div class="modal-header">
        <span class="modal-title">Style bands</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="filename">{{ raster.name }}</div>
        <div class="stats">
          <span>{{ raster.bands }} band{{ raster.bands === 1 ? '' : 's' }}</span>
          <span>{{ raster.sampleFormat === 3 ? 'float' : 'uint' }}{{ raster.bitsPerSample }}</span>
          <span>{{ raster.width.toLocaleString() }} × {{ raster.height.toLocaleString() }} px</span>
        </div>

        <img v-if="raster.previewDataUrl" :src="raster.previewDataUrl" class="preview" alt="" />
        <div class="preview-cap">Current: {{ describeStyle(raster.style) }}</div>

        <div class="field">
          <label class="field-label">Display</label>
          <div class="seg">
            <button class="seg-btn" :class="{ active: s.mode === 'gray' }" @click="s.mode = 'gray'">Greyscale</button>
            <button
              class="seg-btn" :class="{ active: s.mode === 'rgb' }"
              :disabled="bandCount < 3" @click="s.mode = 'rgb'"
            >RGB</button>
            <button
              class="seg-btn" :class="{ active: s.mode === 'index' }"
              :disabled="bandCount < 2" @click="s.mode = 'index'"
            >Index</button>
          </div>
        </div>

        <!-- Greyscale -->
        <div v-if="s.mode === 'gray'" class="field">
          <label class="field-label" for="b-gray">Band</label>
          <select id="b-gray" v-model.number="s.band" class="field-input short">
            <option v-for="b in bandOptions" :key="b.value" :value="b.value">{{ b.label }}</option>
          </select>
        </div>

        <!-- RGB composite -->
        <template v-if="s.mode === 'rgb'">
          <div class="band-grid">
            <label class="field-label" for="b-r">Red</label>
            <select id="b-r" v-model.number="s.bandR" class="field-input short">
              <option v-for="b in bandOptions" :key="b.value" :value="b.value">{{ b.label }}</option>
            </select>
            <label class="field-label" for="b-g">Green</label>
            <select id="b-g" v-model.number="s.bandG" class="field-input short">
              <option v-for="b in bandOptions" :key="b.value" :value="b.value">{{ b.label }}</option>
            </select>
            <label class="field-label" for="b-b">Blue</label>
            <select id="b-b" v-model.number="s.bandB" class="field-input short">
              <option v-for="b in bandOptions" :key="b.value" :value="b.value">{{ b.label }}</option>
            </select>
          </div>
          <span class="field-hint">
            Nothing in the file records which plane is which wavelength — for a Sentinel-2
            B2/B3/B4/B8… stack, true colour is bands 3, 2, 1.
          </span>
        </template>

        <!-- Normalised-difference index -->
        <template v-if="isIndex">
          <div class="field">
            <label class="field-label" for="idx">Index</label>
            <select id="idx" v-model="s.index" class="field-input">
              <option v-for="(p, k) in INDEX_PRESETS" :key="k" :value="k">{{ p.label }}</option>
            </select>
          </div>
          <div class="band-grid">
            <label class="field-label" for="b-a">{{ preset.roleA }}</label>
            <select id="b-a" v-model.number="s.bandA" class="field-input short">
              <option v-for="b in bandOptions" :key="b.value" :value="b.value">{{ b.label }}</option>
            </select>
            <label class="field-label" for="b-b2">{{ preset.roleB }}</label>
            <select id="b-b2" v-model.number="s.bandB2" class="field-input short">
              <option v-for="b in bandOptions" :key="b.value" :value="b.value">{{ b.label }}</option>
            </select>
          </div>
          <div class="field">
            <label class="field-label" for="ramp">Colour ramp</label>
            <select id="ramp" v-model="s.ramp" class="field-input short">
              <option v-for="r in rampNames" :key="r" :value="r">{{ r }}</option>
            </select>
            <span class="field-hint">
              Index values are rendered on their own fixed −1…1 scale, not stretched — a
              stretch would move the zero crossing that gives the index its meaning.
            </span>
          </div>
        </template>

        <!-- Stretch (not applicable to an index) -->
        <div v-if="!isIndex" class="field">
          <label class="field-label" for="stretch">Contrast stretch</label>
          <select id="stretch" v-model="s.stretch" class="field-input">
            <option v-for="m in STRETCH_MODES" :key="m" :value="m">
              {{ m === 'percentile' ? 'Percentile' : m === 'minmax' ? 'Min–max' : 'Manual' }}
            </option>
          </select>
          <span v-if="s.stretch === 'minmax'" class="field-hint">
            A single bright pixel (cloud, sensor artefact) sets the top of the range and
            darkens everything else — percentile is usually the better default.
          </span>
        </div>

        <div v-if="!isIndex && s.stretch === 'percentile'" class="row">
          <label class="field-label" for="lo">Low %</label>
          <input id="lo" v-model.number="s.loPct" type="number" min="0" max="100" step="0.5" class="field-input tiny" />
          <label class="field-label" for="hi">High %</label>
          <input id="hi" v-model.number="s.hiPct" type="number" min="0" max="100" step="0.5" class="field-input tiny" />
        </div>

        <div v-if="!isIndex && s.stretch === 'manual' && s.manual" class="field">
          <label class="field-label">Manual limits (per channel)</label>
          <div v-for="(m, i) in s.manual" :key="i" class="row">
            <span class="chan">{{ s.mode === 'rgb' ? ['R', 'G', 'B'][i] : 'V' }}</span>
            <input v-model.number="m[0]" type="number" step="any" class="field-input tiny" />
            <span class="dash">…</span>
            <input v-model.number="m[1]" type="number" step="any" class="field-input tiny" />
          </div>
        </div>

        <div class="field">
          <label class="field-label" for="gamma">Gamma</label>
          <input id="gamma" v-model.number="s.gamma" type="number" min="0.1" max="5" step="0.1" class="field-input tiny" />
          <span class="field-hint">Above 1 brightens midtones; 1 is a straight linear ramp.</span>
        </div>

        <div class="summary">Will apply: <strong>{{ summary }}</strong></div>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" @click="apply">Apply</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
}
.modal {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  width: 460px; max-width: 90vw; max-height: 88vh;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  display: flex; flex-direction: column;
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 13px 16px; border-bottom: 1px solid var(--panel-border);
}
.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }
.modal-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 1px 6px; border-radius: 4px;
}
.modal-close:hover { background: var(--hover-bg); color: var(--text); }
.modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--panel-border);
}
.filename { font-size: 13px; font-weight: 600; color: var(--text); word-break: break-all; }
.stats { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; color: var(--text-dim); }
.preview {
  max-width: 100%; max-height: 170px; align-self: center;
  border: 1px solid var(--panel-border); border-radius: 4px;
  image-rendering: pixelated; background: var(--bg);
}
.preview-cap { font-size: 11px; color: var(--text-dim); text-align: center; margin-top: -6px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 600; color: var(--text); }
.field-hint { font-size: 11px; color: var(--text-dim); }
.field-input {
  background: var(--bg); border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px; padding: 4px 8px;
}
.field-input.short { width: 160px; }
.field-input.tiny { width: 84px; }
.field-input:focus { outline: none; border-color: var(--accent); }
.band-grid {
  display: grid; grid-template-columns: 60px 1fr; gap: 6px 10px; align-items: center;
}
.row { display: flex; align-items: center; gap: 8px; }
.chan { font-size: 12px; color: var(--text-dim); width: 14px; }
.dash { color: var(--text-dim); }
.seg { display: flex; }
.seg-btn {
  flex: 1; background: var(--bg); border: 1px solid var(--panel-border);
  color: var(--text-dim); font: inherit; font-size: 12px; padding: 6px 10px; cursor: pointer;
}
.seg-btn:first-child { border-radius: 5px 0 0 5px; }
.seg-btn:last-child { border-radius: 0 5px 5px 0; }
.seg-btn:not(:first-child) { border-left: none; }
.seg-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.seg-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.summary {
  background: var(--bg); border: 1px solid var(--panel-border);
  border-radius: 5px; padding: 7px 10px; font-size: 11px; color: var(--text-dim);
}
.btn {
  background: none; border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px;
  padding: 5px 14px; cursor: pointer;
}
.btn:hover { background: var(--hover-bg); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover { opacity: 0.88; }
</style>
