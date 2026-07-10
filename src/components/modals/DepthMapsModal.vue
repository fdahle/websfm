<script setup>
import { ref } from 'vue'
import { useComputeSettings } from '../../composables/useComputeSettings.js'
import { DEPTHMAP_DEFAULTS } from '../../core/defaults.user.js'

const emit = defineEmits(['close', 'run'])

// Memory budget for the dense pre-flight (Step 5) is a machine-level limit — it lives
// in Settings ▸ Compute now; read the persisted value here and apply it on run.
const { memBudgetGb } = useComputeSettings()

// Stage A — Build Depth Maps (PatchMatch MVS). Quality is the primary control
// (Metashape-style relative preset → the store resolves it to a working maxDim
// from the largest native image dimension). Advanced overrides are optional:
// maxDim (null ⇒ derive from quality) and bestK (null ⇒ auto per image).
// Defaults are the single source of truth in core/defaults.user.js; run() below
// transforms filterRelTol (%) and drops null overrides before dispatch.
const settings = ref({ ...DEPTHMAP_DEFAULTS })

function run() {
  const { filterRelTol, maxDim, bestK, ...rest } = settings.value
  const out = {
    ...rest,
    filterRelTol: filterRelTol / 100,
    memBudgetBytes: Math.max(0.25, memBudgetGb.value || 2) * 1024 * 1024 * 1024,
  }
  // Only forward the numeric overrides when actually set — otherwise let the
  // store/worker derive them (maxDim from quality, bestK per image).
  if (maxDim > 0) out.maxDim = maxDim
  if (bestK > 0) out.bestK = bestK
  emit('run', out)
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
          <label class="field-label" for="quality">Quality</label>
          <select id="quality" v-model="settings.quality" class="field-input field-select">
            <option value="low">Low (⅛ native)</option>
            <option value="medium">Medium (¼ native)</option>
            <option value="high">High (½ native)</option>
            <option value="ultra">Ultra (full native)</option>
          </select>
          <span class="field-hint">Working resolution as a fraction of the largest image. Higher = denser & far slower. Resolved against native size when the run starts (see the log).</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label">
            <input v-model="settings.speckleFilter" type="checkbox" />
            Speckle / median filter
          </label>
          <span class="field-hint">Cleans per-image depth noise (drops flying pixels, smooths to the local median) before fusion.</span>
        </div>

        <div v-if="settings.speckleFilter" class="field">
          <label class="field-label" for="filterRelTol">Speckle tolerance</label>
          <div class="input-row">
            <input
              id="filterRelTol"
              v-model.number="settings.filterRelTol"
              type="number" min="1" max="50" step="1"
              class="field-input"
            />
            <span class="field-unit">%</span>
          </div>
          <span class="field-hint">Drop a pixel whose depth differs from its 3×3 median by more than this. Lower = more aggressive.</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label">
            <input v-model="settings.useGpu" type="checkbox" />
            Use GPU (experimental)
          </label>
          <span class="field-hint">
            WebGPU backend (experimental) — multi-source best-K PatchMatch, much faster than CPU. Falls back to CPU
            if WebGPU is unavailable; the log shows the active backend and a GPU↔CPU validation line.
          </span>
        </div>

        <div class="section-sep"></div>

        <details class="advanced">
          <summary>Advanced</summary>
          <div class="advanced-body">
            <div class="field">
              <label class="field-label" for="maxDim">Working resolution override (longest side)</label>
              <div class="input-row">
                <input
                  id="maxDim"
                  v-model.number="settings.maxDim"
                  type="number" min="200" step="100" placeholder="auto (from quality)"
                  class="field-input"
                />
                <span class="field-unit">px</span>
              </div>
              <span class="field-hint">Leave blank to derive from Quality. No hard cap — a memory pre-flight guards very large values.</span>
            </div>

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

            <div class="field">
              <label class="field-label" for="bestK">Sources aggregated (best-K)</label>
              <input
                id="bestK"
                v-model.number="settings.bestK"
                type="number" min="1" max="16" step="1" placeholder="auto (per image)"
                class="field-input"
              />
              <span class="field-hint">Average the K best-matching sources per pixel. Blank = auto (≈half the sources, 1–4).</span>
            </div>

            <div class="field">
              <label class="field-label" for="window">Patch window radius</label>
              <div class="input-row">
                <input
                  id="window"
                  v-model.number="settings.window"
                  type="number" min="1" max="5" step="1"
                  class="field-input"
                />
                <span class="field-unit">px</span>
              </div>
              <span class="field-hint">Half-size of the correlation window (1–5 ⇒ 3×3…11×11). Larger helps
                low-texture / film-grain surfaces, at higher cost.</span>
            </div>

            <div class="field">
              <label class="field-label" for="iterations">PatchMatch iterations (per level)</label>
              <input
                id="iterations"
                v-model.number="settings.iterations"
                type="number" min="1" max="8" step="1"
                class="field-input"
              />
              <span class="field-hint">Propagation/refinement sweeps at the finest pyramid level (coarser levels get more).</span>
            </div>
          </div>
        </details>
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
.field-select { width: auto; min-width: 160px; }
.field-unit { font-size: 12px; color: var(--text-dim); }
.advanced > summary {
  font-size: 12px; font-weight: 600; color: var(--text-dim);
  cursor: pointer; user-select: none; list-style-position: inside;
}
.advanced > summary:hover { color: var(--text); }
.advanced-body { display: flex; flex-direction: column; gap: 12px; margin-top: 10px; }
.btn {
  background: none; border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px;
  padding: 5px 14px; cursor: pointer;
}
.btn:hover { background: var(--hover-bg); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover { opacity: 0.88; }
</style>
