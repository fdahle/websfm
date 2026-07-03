<script setup>
import { ref } from 'vue'

const emit = defineEmits(['close', 'run'])

// Stage B — Build Dense Cloud (fuse depth maps). `depthTolPct` is exposed as a
// percentage; converted to the fraction core/mvs.js fuseDepthMaps expects. In
// Auto mode minViews + maxCost are derived by fusion from the data (minViews =
// min(2, nMaps−1); maxCost = p70 of the pooled valid-pixel costs).
const settings = ref({
  auto: true,
  minViews: 2,
  depthTolPct: 1.0,
  maxCost: 0.6,
  step: 2,
})

function run() {
  const { auto, minViews, depthTolPct, maxCost, step } = settings.value
  emit('run', {
    minViews: auto ? null : minViews,
    maxCost: auto ? null : maxCost,
    depthTolRel: depthTolPct / 100,
    step,
  })
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Build Dense Cloud">
      <div class="modal-header">
        <span class="modal-title">Build Dense Cloud</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="field">
          <label class="field-label">
            <input v-model="settings.auto" type="checkbox" />
            Auto thresholds (recommended)
          </label>
          <span class="field-hint">Derive min-views and max-cost from the data. Uncheck to set them by hand.</span>
        </div>

        <div class="section-sep"></div>

        <div v-if="!settings.auto" class="field">
          <label class="field-label" for="minViews">Min consistent views</label>
          <input
            id="minViews"
            v-model.number="settings.minViews"
            type="number" min="1" max="8" step="1"
            class="field-input"
          />
          <span class="field-hint">A point is kept only if this many other depth maps agree on it. Higher = cleaner, sparser.</span>
        </div>

        <div v-if="!settings.auto" class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="depthTol">Depth agreement tolerance</label>
          <div class="input-row">
            <input
              id="depthTol"
              v-model.number="settings.depthTolPct"
              type="number" min="0.1" max="10" step="0.1"
              class="field-input"
            />
            <span class="field-unit">%</span>
          </div>
          <span class="field-hint">How closely a reprojected depth must match to count as agreement.</span>
        </div>

        <div v-if="!settings.auto" class="section-sep"></div>

        <div v-if="!settings.auto" class="field">
          <label class="field-label" for="maxCost">Max matching cost</label>
          <input
            id="maxCost"
            v-model.number="settings.maxCost"
            type="number" min="0.1" max="2" step="0.1"
            class="field-input"
          />
          <span class="field-hint">Discard pixels whose PatchMatch cost exceeds this (0 = perfect … 2 = none). Lower = stricter.</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="step">Point density (sample step)</label>
          <div class="input-row">
            <input
              id="step"
              v-model.number="settings.step"
              type="number" min="1" max="8" step="1"
              class="field-input"
            />
            <span class="field-unit">px</span>
          </div>
          <span class="field-hint">Emit one point every N pixels. 1 = densest (largest cloud); higher = decimated.</span>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" @click="run">Build Dense Cloud</button>
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
