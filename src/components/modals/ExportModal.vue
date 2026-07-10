<script setup>
import { ref, computed } from 'vue'
import { EXPORT_DEFAULTS } from '../../core/defaults.user.js'

// One reusable export dialog, parameterised by `kind`. It collects a format + a
// few settings and emits them on run; App.vue maps the result to the right
// exporter. Options marked `disabled` are placeholders for formats/settings not
// wired up yet (kept visible so the surface is discoverable).
const props = defineProps({ kind: { type: String, required: true } })
const emit = defineEmits(['close', 'run'])

const CONFIG = {
  cloud: {
    title: 'Export Point Cloud',
    formats: [
      { value: 'ply-binary', label: 'PLY — binary (compact)' },
      { value: 'ply-ascii',  label: 'PLY — ASCII (text)' },
      { value: 'las',        label: 'LAS / LAZ', disabled: true },
    ],
  },
  model: {
    title: 'Export Model',
    formats: [
      { value: 'json', label: 'JSON — cameras + tracks' },
    ],
  },
  colmap: {
    title: 'Export COLMAP Model',
    formats: [
      { value: 'txt', label: 'Text (.txt) — zipped' },
      { value: 'bin', label: 'Binary (.bin)', disabled: true },
    ],
  },
  dem: {
    title: 'Export DEM',
    formats: [
      { value: 'geotiff', label: 'GeoTIFF (.tif) — georeferenced' },
      { value: 'asc',     label: 'ESRI ASCII grid (.asc)' },
      { value: 'png',     label: 'Hillshade PNG', disabled: true },
    ],
  },
  ortho: {
    title: 'Export Orthophoto',
    formats: [
      { value: 'geotiff', label: 'GeoTIFF (.tif) — georeferenced' },
      { value: 'png',     label: 'PNG + world file (.wld)' },
      { value: 'jpeg',    label: 'JPEG + world file', disabled: true },
    ],
  },
}

const cfg = computed(() => CONFIG[props.kind])

// `format` is chosen dynamically per kind; the rest are the single source of truth
// in core/defaults.user.js.
const settings = ref({
  format: cfg.value.formats.find((f) => !f.disabled)?.value,
  ...EXPORT_DEFAULTS,
})

// GeoTIFF compression is a placeholder (writer is uncompressed for now).
const isTiff = computed(() => settings.value.format === 'geotiff')

function run() {
  emit('run', { ...settings.value })
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" :aria-label="cfg.title">
      <div class="modal-header">
        <span class="modal-title">{{ cfg.title }}</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="field">
          <label class="field-label" for="fmt">Format</label>
          <select id="fmt" v-model="settings.format" class="field-input">
            <option v-for="f in cfg.formats" :key="f.value" :value="f.value" :disabled="f.disabled">
              {{ f.label }}{{ f.disabled ? ' — coming soon' : '' }}
            </option>
          </select>
        </div>

        <!-- Point cloud -->
        <template v-if="kind === 'cloud'">
          <label class="check-row">
            <input type="checkbox" v-model="settings.includeColor" />
            <span>Include vertex colours</span>
          </label>
          <label class="check-row disabled">
            <input type="checkbox" disabled />
            <span>Downsample / voxel filter <em>(coming soon)</em></span>
          </label>
        </template>

        <!-- Model JSON -->
        <template v-else-if="kind === 'model'">
          <label class="check-row">
            <input type="checkbox" v-model="settings.includeTracks" />
            <span>Include point tracks (image observations)</span>
          </label>
        </template>

        <!-- COLMAP model -->
        <template v-else-if="kind === 'colmap'">
          <p class="field-hint">
            Exports the sparse model as COLMAP <code>cameras.txt</code>, <code>images.txt</code>
            and <code>points3D.txt</code> in a ZIP — one PINHOLE camera per image, in the local
            SfM frame. Reads into COLMAP, Metashape/RealityCapture and NeRF / Gaussian-Splatting tools.
          </p>
        </template>

        <!-- DEM -->
        <template v-else-if="kind === 'dem'">
          <div class="field">
            <label class="field-label" for="nodata">NODATA value</label>
            <input id="nodata" v-model.number="settings.nodata" type="number" step="any" class="field-input short" />
            <span class="field-hint">Written for empty cells (holes with no measurement).</span>
          </div>
          <div class="field" :class="{ disabled: !isTiff }">
            <label class="field-label" for="comp">Compression <em>(coming soon)</em></label>
            <select id="comp" class="field-input" disabled>
              <option>None (uncompressed)</option>
            </select>
          </div>
        </template>

        <!-- Ortho -->
        <template v-else-if="kind === 'ortho'">
          <div class="field disabled">
            <label class="field-label" for="ocomp">Compression <em>(coming soon)</em></label>
            <select id="ocomp" class="field-input" disabled>
              <option>None (uncompressed)</option>
            </select>
          </div>
        </template>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" @click="run">Export</button>
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
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 600; color: var(--text); }
.field-label em, .check-row em { font-style: italic; color: var(--text-dim); font-weight: 400; }
.field-hint { font-size: 11px; color: var(--text-dim); }
.field-input {
  background: var(--bg); border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px; padding: 4px 8px;
}
.field-input.short { width: 110px; }
.field-input:focus { outline: none; border-color: var(--accent); }
.check-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); cursor: pointer; }
.check-row input { accent-color: var(--accent); width: 15px; height: 15px; }
.disabled { opacity: 0.5; }
.disabled .check-row, .check-row.disabled { cursor: not-allowed; }
.btn {
  background: none; border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px;
  padding: 5px 14px; cursor: pointer;
}
.btn:hover { background: var(--hover-bg); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover { opacity: 0.88; }
</style>
