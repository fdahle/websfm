<script setup>
import { ref } from 'vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import { RECONSTRUCT_DEFAULTS } from '../../core/defaults.user.js'

const emit = defineEmits(['close', 'run'])

// Prefill from the single source of truth (core/sfm/sfm.js falls back to the same
// values). Clone so edits don't mutate the shared constant.
const settings = ref({ ...RECONSTRUCT_DEFAULTS })

function run() {
  emit('run', { ...settings.value })
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Sparse Reconstruction">
      <div class="modal-header">
        <span class="modal-title">Sparse Reconstruction</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="field">
          <label class="field-label" for="minMatches">Min correspondences for registration</label>
          <div class="input-row">
            <input
              id="minMatches"
              v-model.number="settings.minMatchesForRegistration"
              type="number" min="6" max="500" step="1"
              class="field-input"
            />
            <span class="field-unit">pts</span>
          </div>
          <span class="field-hint">Minimum 3D–2D pairs required to register a new camera via PnP.</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="reprj">
            <GlossaryTerm id="reprojection-error">Reprojection threshold</GlossaryTerm>
            (PnP RANSAC)
          </label>
          <div class="input-row">
            <input
              id="reprj"
              v-model.number="settings.reprjThreshold"
              type="number" min="0.5" max="20" step="0.5"
              class="field-input"
            />
            <span class="field-unit">px</span>
          </div>
          <span class="field-hint">Inlier threshold for camera pose RANSAC. Lower = stricter.</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="baIter">
            <GlossaryTerm id="bundle-adjustment">Bundle adjustment</GlossaryTerm> iterations
          </label>
          <input
            id="baIter"
            v-model.number="settings.baIterations"
            type="number" min="0" max="200" step="5"
            class="field-input"
          />
          <span class="field-hint">Set to 0 to skip bundle adjustment.</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="refineIntr">Refine intrinsics (self-calibration)</label>
          <select id="refineIntr" v-model="settings.refineIntrinsics" class="field-input field-select">
            <option value="auto">Auto — self-calibrate focal + radial k1 for EXIF-only cameras (recommended)</option>
            <option value="none">Off (use sensor table)</option>
            <option value="f">Focal length</option>
            <option value="f,cxcy">Focal + principal point</option>
            <option value="f,k1">Focal + radial k1</option>
          </select>
          <span class="field-hint">
            Lets bundle adjustment solve one shared focal (and optionally principal
            point or a radial k1) per sensor, in the post-filter passes only. Weakly
            observed on short/single strips — the refined value is logged, never written
            back to the sensor table. <b>Auto</b> uses focal + radial k1 unless the
            sensor already has a calibrated distortion model.
          </span>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" @click="run">Run Reconstruction</button>
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
.field-select { width: auto; min-width: 180px; cursor: pointer; }
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
