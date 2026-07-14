<script setup>
import { ref, computed } from 'vue'
import { IMPORT_CLOUD_DEFAULTS } from '../../core/defaults.user.js'

// Import settings for an already-parsed point cloud / mesh (the parseCloud worker
// op ran before this opens): shows what the file contains and offers the few
// knobs the format itself can't answer — source units, up-axis, and an optional
// voxel subsample. Coordinates import verbatim into the current frame (no CRS
// reprojection). `data` is { parsed, stats, fileName } from useModalsStore.
const props = defineProps({ data: { type: Object, required: true } })
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...IMPORT_CLOUD_DEFAULTS })

const stats = computed(() => props.data.stats)
const isMesh = computed(() => stats.value.faces > 0)
const span = computed(() => {
  const { min, max } = stats.value.bbox
  return [0, 1, 2].map((i) => (max[i] - min[i]))
})
const fmt = (v) => Math.abs(v) >= 1000 ? v.toFixed(0) : v.toPrecision(4)

function run() {
  emit('run', { ...settings.value })
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Import Point Cloud">
      <div class="modal-header">
        <span class="modal-title">Import {{ isMesh ? 'Mesh' : 'Point Cloud' }}</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="filename">{{ data.fileName }}</div>
        <div class="stats">
          <span>{{ stats.points.toLocaleString() }} {{ isMesh ? 'vertices' : 'points' }}</span>
          <span v-if="stats.faces">{{ stats.faces.toLocaleString() }} triangles</span>
          <span>{{ stats.hasColor ? 'color' : 'no color' }}</span>
          <span v-if="!isMesh">{{ stats.hasNormals ? 'normals' : 'no normals' }}</span>
        </div>
        <div class="stats dim">
          <span>extent {{ span.map(fmt).join(' × ') }}</span>
        </div>

        <div class="field">
          <label class="field-label" for="unit">Source units</label>
          <select id="unit" v-model.number="settings.unitScale" class="field-input">
            <option :value="1">metres (×1)</option>
            <option :value="0.01">centimetres (×0.01)</option>
            <option :value="0.001">millimetres (×0.001)</option>
          </select>
        </div>

        <label class="check-row">
          <input type="checkbox" v-model="settings.swapYZ" />
          <span>Y-up source → Z-up (rotate about X)</span>
        </label>

        <div v-if="!isMesh" class="field">
          <label class="field-label" for="subcell">Voxel subsample cell</label>
          <input id="subcell" v-model.number="settings.subsampleCell" type="number" min="0" step="any" class="field-input short" />
          <span class="field-hint">World units after scaling; 0 = keep every point.</span>
        </div>

        <p class="field-hint">
          Coordinates import as-is into the current project frame — no CRS reprojection.
        </p>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" @click="run">Import</button>
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
  width: 400px; max-width: 90vw;
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
.modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--panel-border);
}
.filename { font-size: 13px; font-weight: 600; color: var(--text); word-break: break-all; }
.stats { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; color: var(--text); }
.stats.dim { color: var(--text-dim); }
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 600; color: var(--text); }
.field-hint { font-size: 11px; color: var(--text-dim); }
.field-input {
  background: var(--bg); border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px; padding: 4px 8px;
}
.field-input.short { width: 110px; }
.field-input:focus { outline: none; border-color: var(--accent); }
.check-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); cursor: pointer; }
.check-row input { accent-color: var(--accent); width: 15px; height: 15px; }
.btn {
  background: none; border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px;
  padding: 5px 14px; cursor: pointer;
}
.btn:hover { background: var(--hover-bg); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover { opacity: 0.88; }
</style>
