<script setup>
import { ref, computed } from 'vue'
import { DETECT_SIFT_DEFAULTS, DETECT_SUPERPOINT_DEFAULTS } from '../../core/defaults.user.js'

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

// SuperPoint's GPU path (ONNX Runtime's WebGPU EP) is gated to Chromium in
// core/features/ort.js (resolveBackend) — on Safari/Firefox it always runs on
// CPU WASM (and Safari ignores COEP `credentialless`, so single-threaded too).
// Surface that here, before the user commits to a slow run.
const isChromium = /Chrome\//.test(globalThis.navigator?.userAgent || '')

// Tiling defaults (Advanced): 'off' | 'auto' | 'manual'. When on, detection runs
// per overlapping tile at native-ish resolution then merges — more, better-
// localised keypoints, and it sidesteps the SuperPoint WebGPU OOM. `tileSize` 0
// means auto-derive; `overlap` dedups seam duplicates.
// Prefill from the single source of truth (see core/defaults.user.js). Cloned so
// edits don't mutate the shared constants.
const siftSettings = ref({ ...DETECT_SIFT_DEFAULTS })
const superpointSettings = ref({ ...DETECT_SUPERPOINT_DEFAULTS })

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
            <label class="field-label" for="maxDim">Detection resolution</label>
            <div class="input-row">
              <input
                id="maxDim"
                v-model.number="siftSettings.maxDim"
                type="number"
                min="100"
                max="10000"
                step="100"
                class="field-input"
              />
              <span class="field-unit">px</span>
            </div>
            <span class="field-hint">
              Images are downscaled to this longest side <em>before</em> detection
              (keypoint coordinates map back to native pixels). Tiling off: the
              detector sees the whole downscaled image in one pass. Tiling on: the
              same downscaled image is split into overlapping tiles, so you can
              raise this toward native resolution without a huge single pass.
            </span>
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

          <details class="advanced">
            <summary>Advanced</summary>
            <div class="advanced-body">
              <div class="field">
                <label class="field-label" for="sift-tiling">Tiling</label>
                <select id="sift-tiling" v-model="siftSettings.tiling" class="field-select">
                  <option value="off">Off</option>
                  <option value="auto">Auto (fit tile size)</option>
                  <option value="manual">Manual</option>
                </select>
                <span class="field-hint">
                  Detect on overlapping tiles at full resolution, then merge — more,
                  better-localised keypoints. Off = single downsampled pass.
                </span>
              </div>
              <div v-if="siftSettings.tiling === 'manual'" class="field">
                <label class="field-label" for="sift-tileSize">Tile size</label>
                <div class="input-row">
                  <input id="sift-tileSize" v-model.number="siftSettings.tileSize" type="number" min="256" max="4096" step="64" class="field-input" />
                  <span class="field-unit">px</span>
                </div>
              </div>
              <div v-if="siftSettings.tiling !== 'off'" class="field">
                <label class="field-label" for="sift-overlap">Tile overlap</label>
                <div class="input-row">
                  <input id="sift-overlap" v-model.number="siftSettings.overlap" type="number" min="0" max="512" step="16" class="field-input" />
                  <span class="field-unit">px</span>
                </div>
                <span class="field-hint">Seam margin so edge features aren't clipped; duplicates are merged.</span>
              </div>
            </div>
          </details>
        </template>

        <template v-else-if="detector === 'superpoint'">
          <div class="section-sep"></div>

          <div v-if="!isChromium" class="warn-box">
            This browser can't run SuperPoint on the GPU — WebGPU inference is
            Chromium-only for now, so it will run on the <strong>CPU</strong>
            (much slower; expect minutes per image at high resolution or with
            tiling). Use <strong>Chrome or Edge</strong> for GPU speed.
          </div>

          <div class="field">
            <label class="field-label" for="sp-maxDim">Detection resolution</label>
            <div class="input-row">
              <input
                id="sp-maxDim"
                v-model.number="superpointSettings.maxDim"
                type="number"
                min="100"
                max="10000"
                step="100"
                class="field-input"
              />
              <span class="field-unit">px</span>
            </div>
            <span class="field-hint">
              Images are downscaled to this longest side <em>before</em> detection
              (keypoint coordinates map back to native pixels). Raising it only
              helps with tiling on: tiles keep each network input small (≤ ~1024px
              on GPU), so high resolutions neither OOM the GPU nor cap keypoint
              density at the network's output grid.
            </span>
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
            <span class="field-hint">Top-K by score (global, after tile merge). LightGlue matching cost grows with this.</span>
          </div>

          <details class="advanced">
            <summary>Advanced</summary>
            <div class="advanced-body">
              <div class="field">
                <label class="field-label" for="sp-tiling">Tiling</label>
                <select id="sp-tiling" v-model="superpointSettings.tiling" class="field-select">
                  <option value="off">Off</option>
                  <option value="auto">Auto (fit GPU memory)</option>
                  <option value="manual">Manual</option>
                </select>
                <span class="field-hint">
                  Detect on overlapping tiles at full resolution, then merge — more
                  keypoints, and each tile fits GPU memory (avoids the OOM). Auto
                  derives the tile size from the GPU's buffer limit.
                </span>
              </div>
              <div v-if="superpointSettings.tiling === 'manual'" class="field">
                <label class="field-label" for="sp-tileSize">Tile size</label>
                <div class="input-row">
                  <input id="sp-tileSize" v-model.number="superpointSettings.tileSize" type="number" min="256" max="4096" step="64" class="field-input" />
                  <span class="field-unit">px</span>
                </div>
              </div>
              <div v-if="superpointSettings.tiling !== 'off'" class="field">
                <label class="field-label" for="sp-overlap">Tile overlap</label>
                <div class="input-row">
                  <input id="sp-overlap" v-model.number="superpointSettings.overlap" type="number" min="0" max="512" step="16" class="field-input" />
                  <span class="field-unit">px</span>
                </div>
                <span class="field-hint">Seam margin so edge features aren't clipped; duplicates are merged.</span>
              </div>
            </div>
          </details>

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

/* Advanced disclosure */
.advanced {
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 2px 10px;
}

.advanced > summary {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
  cursor: pointer;
  padding: 6px 0;
  user-select: none;
}

.advanced > summary:hover { color: var(--text); }

.advanced-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 6px 0 10px;
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
