<script setup>
import { ref } from 'vue'

const emit = defineEmits(['close', 'run'])

// Stage A — Build Depth Maps (PatchMatch MVS). Defaults mirror the worker's
// computeDepthMaps fallbacks (core/mvs.js + compute.worker.js).
const settings = ref({
  maxDim: 800,
  maxSources: 6,
  window: 2,
  iterations: 3,
  bestK: 3,
})

function run() {
  emit('run', { ...settings.value })
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Build Depth Maps">
      <div class="modal-header">
        <span class="modal-title">Build Depth Maps</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="field">
          <label class="field-label" for="maxDim">Working resolution (longest side)</label>
          <div class="input-row">
            <input
              id="maxDim"
              v-model.number="settings.maxDim"
              type="number" min="200" max="4000" step="100"
              class="field-input"
            />
            <span class="field-unit">px</span>
          </div>
          <span class="field-hint">Images are downscaled to this before matching. Higher = denser & far slower.</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="maxSources">Source views per image</label>
          <input
            id="maxSources"
            v-model.number="settings.maxSources"
            type="number" min="1" max="16" step="1"
            class="field-input"
          />
          <span class="field-hint">Neighbouring images compared against each reference (chosen by shared tie-points).</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="bestK">Sources aggregated (best-K)</label>
          <input
            id="bestK"
            v-model.number="settings.bestK"
            type="number" min="1" max="16" step="1"
            class="field-input"
          />
          <span class="field-hint">Average the K best-matching sources per pixel — robust to occlusion.</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="window">Patch window radius</label>
          <div class="input-row">
            <input
              id="window"
              v-model.number="settings.window"
              type="number" min="1" max="3" step="1"
              class="field-input"
            />
            <span class="field-unit">px</span>
          </div>
          <span class="field-hint">Half-size of the correlation window (1–3 ⇒ 3×3…7×7).</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="iterations">PatchMatch iterations</label>
          <input
            id="iterations"
            v-model.number="settings.iterations"
            type="number" min="1" max="8" step="1"
            class="field-input"
          />
          <span class="field-hint">Propagation/refinement sweeps. More = better but slower.</span>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" @click="run">Build Depth Maps</button>
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
  width: 380px; max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  display: flex; flex-direction: column;
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--panel-border);
}
.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }
.modal-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 1px 6px; border-radius: 4px;
}
.modal-close:hover { background: var(--hover-bg); color: var(--text); }
.modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--panel-border);
}
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 600; color: var(--text); }
.field-hint { font-size: 11px; color: var(--text-dim); }
.section-sep { height: 1px; background: var(--panel-border); margin: 2px 0; }
.input-row { display: flex; align-items: center; gap: 6px; }
.field-input {
  width: 100px;
  background: var(--bg); border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px; padding: 4px 8px;
}
.field-input:focus { outline: none; border-color: var(--accent); }
.field-unit { font-size: 12px; color: var(--text-dim); }
.btn {
  background: none; border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px;
  padding: 5px 14px; cursor: pointer;
}
.btn:hover { background: var(--hover-bg); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover { opacity: 0.88; }
</style>
