<script setup>
import { ref } from 'vue'
import { ORTHO_DEFAULTS } from '../../core/defaults.user.js'

// Build Orthophoto. Reprojects each DEM cell through the cached depth maps
// (occlusion via their depth planes, colour from their RGB planes). Requires a
// DEM (built first) and depth maps. Defaults are the single source of truth in
// core/defaults.user.js (core/products/ortho.js keeps defensive fallbacks); run()
// transforms depthTolRel (%) and maxCost (0 ⇒ Infinity). Output is aligned to the DEM.
defineProps({
  demCrs: { type: String, default: null },   // frame the DEM was built in (label only)
  demSize: { type: String, default: null },  // e.g. "1024×768" (label only)
})

const emit = defineEmits(['close', 'run'])

const settings = ref({ ...ORTHO_DEFAULTS })

function run() {
  const { depthTolRel, maxCost, ...rest } = settings.value
  emit('run', {
    ...rest,
    depthTolRel: depthTolRel / 100,
    maxCost: maxCost > 0 ? maxCost : Infinity,
  })
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Build Orthophoto">
      <div class="modal-header">
        <span class="modal-title">Build Orthophoto</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <p class="dem-note">
          Reprojects the current DEM<span v-if="demSize"> ({{ demSize }}<span v-if="demCrs">, {{ demCrs }}</span>)</span>
          into the source views. Rebuild the DEM first to change resolution or frame.
        </p>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="ortho-blend">View blending</label>
          <select id="ortho-blend" v-model="settings.blend" class="field-input field-select">
            <option value="best">Best view (sharpest)</option>
            <option value="average">Average (smoother seams)</option>
          </select>
          <span class="field-hint">Best picks the lowest-cost view per cell; average blends all visible views.</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="ortho-tol">Occlusion tolerance</label>
          <div class="input-row">
            <input
              id="ortho-tol"
              v-model.number="settings.depthTolRel"
              type="number" min="0.5" max="10" step="0.5"
              class="field-input"
            />
            <span class="field-unit">%</span>
          </div>
          <span class="field-hint">How closely a cell's depth must match a view's depth map to count as visible.</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="ortho-cost">Max match cost</label>
          <input
            id="ortho-cost"
            v-model.number="settings.maxCost"
            type="number" min="0" max="2" step="0.1"
            class="field-input"
          />
          <span class="field-hint">Drop colours from poorly-matched (high-cost) pixels. 0 = keep all.</span>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" @click="run">Build Orthophoto</button>
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
  width: 600px; max-width: 90vw;
  max-height: 90vh;
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
.modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; min-height: 0; }
.modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--panel-border);
}
.dem-note { font-size: 11px; color: var(--text-dim); margin: 0; line-height: 1.5; }
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
.field-select { width: 100%; }
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
