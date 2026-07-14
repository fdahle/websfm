<script setup>
import { ref } from 'vue'
import { MESH_DEFAULTS } from '../../core/defaults.user.js'

// Build Mesh (screened Poisson over the dense cloud). Defaults are the single source
// of truth in core/defaults.user.js (core/products/mesh.js keeps matching fallbacks).
// `hasDenseNormals` gates the run: Poisson needs the dense cloud's oriented normals,
// which only exist on a dense cloud produced after normals were plumbed — otherwise
// the user must re-run Densify.
defineProps({
  hasDense: { type: Boolean, default: false },
  hasDenseNormals: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'run'])

const settings = ref({ ...MESH_DEFAULTS })

function run() {
  emit('run', { ...settings.value })
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Build Mesh">
      <div class="modal-header">
        <span class="modal-title">Build Mesh</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div v-if="!hasDense" class="notice warn">
          No dense point cloud yet. Run <strong>Densify</strong> first — meshing reconstructs a
          surface over the dense cloud.
        </div>
        <div v-else-if="!hasDenseNormals" class="notice warn">
          The dense cloud has no per-point normals, which screened Poisson requires. Re-run
          <strong>Densify</strong> to compute them, then build the mesh.
        </div>

        <div class="field">
          <label class="field-label" for="mesh-depth">Octree depth</label>
          <div class="input-row">
            <input
              id="mesh-depth"
              v-model.number="settings.depth"
              type="number" min="4" max="12" step="1"
              class="field-input"
            />
            <span class="field-unit">levels</span>
          </div>
          <span class="field-hint">
            Surface resolution. Higher = more detail &amp; triangles (and much slower / more RAM).
            8 is a good default; drop to 6–7 for a quick preview.
          </span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="mesh-screen">Screening weight</label>
          <div class="input-row">
            <input
              id="mesh-screen"
              v-model.number="settings.screening"
              type="number" min="0" max="16" step="0.5"
              class="field-input"
            />
          </div>
          <span class="field-hint">
            How tightly the surface fits the points (Poisson screening). 0 = smoothest/fastest;
            higher hugs the data more closely. 4 is typical.
          </span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="mesh-trim">Trim factor</label>
          <div class="input-row">
            <input
              id="mesh-trim"
              v-model.number="settings.trimFactor"
              type="number" min="0" max="32" step="1"
              class="field-input"
            />
            <span class="field-unit">× cell</span>
          </div>
          <span class="field-hint">
            Cull triangles farther than this many dense-cloud cells from any point (removes
            Poisson's extrapolated bulges over holes). 0 = keep the full watertight surface.
          </span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="check-row">
            <input type="checkbox" v-model="settings.colorize" />
            <span>Transfer colour from the dense cloud</span>
          </label>
          <span class="field-hint">Colour each mesh vertex from the nearest dense point.</span>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="!hasDense || !hasDenseNormals" @click="run">Build Mesh</button>
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
.check-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); cursor: pointer; }
.field-input {
  width: 100px;
  background: var(--bg); border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px; padding: 4px 8px;
}
.field-input:focus { outline: none; border-color: var(--accent); }
.field-unit { font-size: 12px; color: var(--text-dim); }
.notice { font-size: 12px; padding: 8px 10px; border-radius: 6px; line-height: 1.4; }
.notice.warn { background: color-mix(in srgb, var(--warn, #d08a2a) 15%, transparent); color: var(--text); border: 1px solid var(--warn, #d08a2a); }
.btn {
  background: none; border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px;
  padding: 5px 14px; cursor: pointer;
}
.btn:hover { background: var(--hover-bg); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover { opacity: 0.88; }
</style>
