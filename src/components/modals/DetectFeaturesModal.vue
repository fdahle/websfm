<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  // Current image list — used to warn when Append mode would leave a mix of
  // detectors (e.g. some SIFT, some SuperPoint), which breaks LightGlue.
  images: { type: Array, default: () => [] },
})

const emit = defineEmits(['close', 'run'])

const overwrite = ref(false)
const detector = ref('sift')

// Images already detected with a *different* detector than the one selected. In
// Append mode these are skipped (kpStatus === 'done'), so their old descriptors
// survive — a silent footgun for LightGlue, which needs all-SuperPoint. Overwrite
// re-detects everything, so the warning only applies to Append.
const staleDetectorImages = computed(() =>
  props.images.filter(
    (img) => img.kpStatus === 'done' && (img.detector ?? 'sift') !== detector.value,
  ),
)
const showMixWarning = computed(() => !overwrite.value && staleDetectorImages.value.length > 0)

const siftSettings = ref({
  maxDim: 1200,
  contrastThreshold: 0.01,
  maxKeypoints: 5000,
})

// SuperPoint has no contrast knob (learned detection threshold is baked into the
// model); keep the cap modest — LightGlue's attention cost grows with keypoint
// count, so 2048 is the usual sweet spot.
const superpointSettings = ref({
  maxDim: 1200,
  maxKeypoints: 2048,
})

const detectors = [
  { id: 'sift',       label: 'SIFT' },
  { id: 'superpoint', label: 'SuperPoint (learned)' },
  { id: 'orb',        label: 'ORB (coming soon)',   disabled: true },
  { id: 'akaze',      label: 'AKAZE (coming soon)',  disabled: true },
]

const settings = computed(() => {
  if (detector.value === 'sift') return { ...siftSettings.value }
  if (detector.value === 'superpoint') return { ...superpointSettings.value }
  return {}
})

function run() {
  emit('run', { detector: detector.value, overwrite: overwrite.value, ...settings.value })
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Detect Features">
      <div class="modal-header">
        <span class="modal-title">Detect Features</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">

        <!-- Append / Overwrite toggle -->
        <div class="field">
          <span class="field-label">Mode</span>
          <div class="seg-ctrl">
            <button
              class="seg-btn"
              :class="{ active: !overwrite }"
              @click="overwrite = false"
            >Append</button>
            <button
              class="seg-btn"
              :class="{ active: overwrite }"
              @click="overwrite = true"
            >Overwrite</button>
          </div>
          <span class="field-hint">
            {{ overwrite
              ? 'Re-detect all images, replacing existing keypoints.'
              : 'Skip images that already have keypoints.' }}
          </span>
          <div v-if="showMixWarning" class="warn-box">
            {{ staleDetectorImages.length }} image{{ staleDetectorImages.length !== 1 ? 's' : '' }}
            already detected with a different detector will be
            <strong>skipped</strong> in Append mode, leaving a mix of descriptor
            types. LightGlue matching needs every image to use SuperPoint — switch
            to <strong>Overwrite</strong> to make them consistent.
          </div>
        </div>

        <div class="section-sep"></div>

        <!-- Detector select -->
        <div class="field">
          <label class="field-label" for="detector-sel">Detector</label>
          <select id="detector-sel" v-model="detector" class="field-select">
            <option
              v-for="d in detectors"
              :key="d.id"
              :value="d.id"
              :disabled="d.disabled"
            >{{ d.label }}</option>
          </select>
        </div>

        <template v-if="detector === 'sift'">
          <div class="section-sep"></div>

          <div class="field">
            <label class="field-label" for="maxDim">Max resolution</label>
            <div class="input-row">
              <input
                id="maxDim"
                v-model.number="siftSettings.maxDim"
                type="number"
                min="100"
                max="4000"
                step="100"
                class="field-input"
              />
              <span class="field-unit">px</span>
            </div>
            <span class="field-hint">Longest side used for detection. Lower = faster.</span>
          </div>

          <div class="field">
            <label class="field-label" for="contrast">Contrast threshold</label>
            <input
              id="contrast"
              v-model.number="siftSettings.contrastThreshold"
              type="number"
              min="0.001"
              max="0.5"
              step="0.001"
              class="field-input"
            />
            <span class="field-hint">Higher = fewer but more distinctive keypoints.</span>
          </div>

          <div class="field">
            <label class="field-label" for="maxKp">Max keypoints</label>
            <input
              id="maxKp"
              v-model.number="siftSettings.maxKeypoints"
              type="number"
              min="100"
              max="50000"
              step="100"
              class="field-input"
            />
          </div>
        </template>

        <template v-else-if="detector === 'superpoint'">
          <div class="section-sep"></div>

          <div class="field">
            <label class="field-label" for="sp-maxDim">Max resolution</label>
            <div class="input-row">
              <input
                id="sp-maxDim"
                v-model.number="superpointSettings.maxDim"
                type="number"
                min="100"
                max="4000"
                step="100"
                class="field-input"
              />
              <span class="field-unit">px</span>
            </div>
            <span class="field-hint">Longest side used for detection. Lower = faster.</span>
          </div>

          <div class="field">
            <label class="field-label" for="sp-maxKp">Max keypoints</label>
            <input
              id="sp-maxKp"
              v-model.number="superpointSettings.maxKeypoints"
              type="number"
              min="128"
              max="8192"
              step="128"
              class="field-input"
            />
            <span class="field-hint">Top-K by score. LightGlue matching cost grows with this.</span>
          </div>

          <div class="field">
            <span class="field-hint">
              Runs the SuperPoint neural net (WebGPU, WASM fallback). Pair with the
              LightGlue matcher for best results. Requires the model in
              <code>public/models/</code>.
            </span>
          </div>
        </template>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" @click="run">Run on All Images</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  width: 380px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--panel-border);
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 4px;
}

.modal-close:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.modal-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--panel-border);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.field-hint {
  font-size: 11px;
  color: var(--text-dim);
}

.warn-box {
  font-size: 11px;
  line-height: 1.4;
  color: var(--text);
  background: rgba(230, 160, 30, 0.12);
  border: 1px solid rgba(230, 160, 30, 0.45);
  border-radius: 5px;
  padding: 7px 9px;
  margin-top: 2px;
}

/* Segmented control */
.seg-ctrl {
  display: flex;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  overflow: hidden;
  width: fit-content;
}

.seg-btn {
  background: none;
  border: none;
  border-right: 1px solid var(--panel-border);
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  padding: 4px 16px;
  cursor: pointer;
}

.seg-btn:last-child { border-right: none; }

.seg-btn:hover:not(.active) {
  background: var(--hover-bg);
  color: var(--text);
}

.seg-btn.active {
  background: var(--accent);
  color: #fff;
}

.section-sep {
  height: 1px;
  background: var(--panel-border);
  margin: 2px 0;
}

/* Inputs */
.input-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.field-input {
  width: 100px;
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  padding: 4px 8px;
}

.field-input:focus {
  outline: none;
  border-color: var(--accent);
}

.field-unit {
  font-size: 12px;
  color: var(--text-dim);
}

.field-select {
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  padding: 4px 8px;
  cursor: pointer;
  width: fit-content;
}

.field-select:focus {
  outline: none;
  border-color: var(--accent);
}

.btn {
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  padding: 5px 14px;
  cursor: pointer;
}

.btn:hover { background: var(--hover-bg); }

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.btn-primary:hover { opacity: 0.88; }
</style>
