<script setup>
import { ref } from 'vue'

// Build DEM (Digital Surface Model). Rasterises the point cloud into a height
// grid in the chosen frame. Defaults mirror the worker's rasterizeDem fallbacks
// (core/dem.js). `canGeoreference` / `projectCrs` come from the reconstruction
// store: the CRS selector offers the local frame always, and the project CRS
// only when a georeference can be fit from camera poses.
defineProps({
  canGeoreference: { type: Boolean, default: false },
  projectCrs: { type: String, default: null },
})

const emit = defineEmits(['close', 'run'])

const settings = ref({
  crs: 'local',        // 'local' | 'project'
  gsd: 0,              // 0 = auto (√(area/n))
  aggregate: 'max',    // DSM top surface
  fillRadius: 2,       // IDW hole-fill radius (cells); 0 = none
})

function run() {
  // Pass gsd only when set (0 ⇒ let the worker auto-suggest).
  const { gsd, ...rest } = settings.value
  emit('run', gsd > 0 ? { ...rest, gsd } : rest)
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Build DEM">
      <div class="modal-header">
        <span class="modal-title">Build DEM</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="field">
          <label class="field-label" for="dem-crs">Coordinate frame</label>
          <select id="dem-crs" v-model="settings.crs" class="field-input field-select">
            <option value="local">Local (model units)</option>
            <option value="project" :disabled="!canGeoreference">
              {{ projectCrs || 'Project CRS' }}{{ canGeoreference ? '' : ' — needs camera poses' }}
            </option>
          </select>
          <span class="field-hint">
            Local uses an up-vector estimated from the cameras (up-to-scale). The project CRS
            fits a similarity to the imported camera poses, so heights &amp; GSD are real-world.
          </span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="dem-gsd">Ground sample distance</label>
          <div class="input-row">
            <input
              id="dem-gsd"
              v-model.number="settings.gsd"
              type="number" min="0" step="0.1"
              class="field-input"
            />
            <span class="field-unit">{{ settings.crs === 'project' ? 'm/px' : 'units/px' }}</span>
          </div>
          <span class="field-hint">Cell size. 0 = auto (≈ one point per cell). Smaller = finer &amp; slower.</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="dem-agg">Surface aggregation</label>
          <select id="dem-agg" v-model="settings.aggregate" class="field-input field-select">
            <option value="max">Max (DSM — top surface)</option>
            <option value="median">Median (robust)</option>
            <option value="mean">Mean</option>
            <option value="min">Min (ground-ish)</option>
          </select>
          <span class="field-hint">How multiple points in one cell collapse to a single height.</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="dem-fill">Hole fill radius</label>
          <div class="input-row">
            <input
              id="dem-fill"
              v-model.number="settings.fillRadius"
              type="number" min="0" max="16" step="1"
              class="field-input"
            />
            <span class="field-unit">px</span>
          </div>
          <span class="field-hint">Inverse-distance fill of empty cells within this radius. 0 = leave gaps.</span>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" @click="run">Build DEM</button>
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
  width: 480px; max-width: 90vw;
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
