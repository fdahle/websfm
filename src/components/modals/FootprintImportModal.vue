<script setup>
import { ref, computed } from 'vue'
import CrsPicker from '../controls/CrsPicker.vue'
import { geoJsonToFootprints, guessNameKey } from '../../core/io/geojson.js'

const props = defineProps({
  features:     { type: Array,  default: () => [] },
  propertyKeys: { type: Array,  default: () => [] },
  detectedCrs:  { type: String, default: 'EPSG:4326' },
  fileName:     { type: String, default: 'footprint file' },
  projectCrs:   { type: String, default: 'EPSG:4326' },
  images:       { type: Array,  default: () => [] },
})
const emit = defineEmits(['close', 'import'])

const sourceCrs = ref(props.detectedCrs || props.projectCrs)
const nameKey = ref(guessNameKey(props.propertyKeys))

// Footprints rebuilt whenever the chosen name field changes.
const built = computed(() => geoJsonToFootprints(props.features, nameKey.value))

// Resolve an image name to an image (case-insensitive, extension-tolerant) — mirrors useFootprints.
function matchImage(imageName) {
  if (!imageName) return null
  const lc = imageName.toLowerCase()
  const base = lc.replace(/\.[^.]+$/, '')
  return props.images.find((img) => {
    const n = img.name.toLowerCase()
    return n === lc || n.replace(/\.[^.]+$/, '') === base
  }) || null
}

const preview = computed(() =>
  built.value.slice(0, 12).map((fp) => ({
    name: fp.name,
    vertices: fp.rings.reduce((n, r) => n + r.length, 0),
    matched: !!matchImage(fp.imageName),
  }))
)

const matchedCount = computed(() => built.value.filter((fp) => matchImage(fp.imageName)).length)
const canImport = computed(() => built.value.length > 0)

function doImport() {
  if (!canImport.value) return
  emit('import', { footprints: built.value, sourceCrs: sourceCrs.value, name: props.fileName })
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Import footprints">
      <div class="modal-header">
        <span class="modal-title">Import Image Footprints</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="filename">{{ fileName }}</div>

        <div class="controls">
          <div class="ctrl" v-if="propertyKeys.length">
            <label class="ctrl-label">Name / image field</label>
            <select v-model="nameKey" class="ctrl-input">
              <option v-for="k in propertyKeys" :key="k" :value="k">{{ k }}</option>
            </select>
          </div>
          <div class="ctrl ctrl-crs">
            <label class="ctrl-label">Source CRS of these coordinates</label>
            <CrsPicker v-model="sourceCrs" />
          </div>
        </div>

        <label class="section-label">Preview</label>
        <div class="table-wrap">
          <table class="preview">
            <thead>
              <tr><th>Name</th><th>Vertices</th><th>Matched image</th></tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in preview" :key="i">
                <td>{{ p.name }}</td>
                <td>{{ p.vertices }}</td>
                <td>
                  <span v-if="p.matched" class="ok">✓</span>
                  <span v-else class="dim">no match</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="summary">
          <span v-if="!canImport" class="warn">No polygon features found.</span>
          <span v-else class="ok">
            {{ built.length }} footprint{{ built.length === 1 ? '' : 's' }}, {{ matchedCount }} matched to images
          </span>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn-secondary" @click="emit('close')">Cancel</button>
        <button class="btn-primary" :disabled="!canImport" @click="doImport">Import Footprints</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
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
  width: 620px;
  max-width: 94vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--panel-border);
}

.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }

.modal-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 1px 6px; border-radius: 4px;
}
.modal-close:hover { background: var(--hover-bg); color: var(--text); }

.modal-body { padding: 16px; overflow-y: auto; }

.filename {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 14px;
  font-family: monospace;
}

.controls {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: end;
  gap: 16px;
  margin-bottom: 18px;
}

.ctrl { display: flex; flex-direction: column; gap: 6px; }
.ctrl-crs { max-width: 360px; }

.ctrl-label, .section-label {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-dim);
}
.section-label { display: block; margin-bottom: 8px; }

.ctrl-input {
  background: var(--bg); border: 1px solid var(--panel-border); border-radius: 5px;
  color: var(--text); font: inherit; font-size: 13px; padding: 7px 10px; outline: none;
}
.ctrl-input:focus { border-color: var(--accent); }

.table-wrap {
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  overflow: auto;
  max-height: 260px;
}

.preview {
  border-collapse: collapse;
  font-size: 12px;
  width: 100%;
}

.preview th, .preview td {
  border: 1px solid var(--panel-border);
  padding: 4px 8px;
  text-align: left;
  white-space: nowrap;
}

.preview th { background: var(--bg); color: var(--text-dim); font-weight: 600; position: sticky; top: 0; }
.preview td { color: var(--text); }

.summary { margin-top: 12px; font-size: 12px; }
.summary .warn { color: #d89a3a; }
.summary .ok { color: var(--text-dim); }
td .ok { color: #3fae6a; }
td .dim { color: var(--text-dim); }

.modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--panel-border);
}

.btn-secondary {
  background: none; border: 1px solid var(--panel-border); border-radius: 5px;
  color: var(--text-dim); font: inherit; font-size: 12px; padding: 6px 14px; cursor: pointer;
}
.btn-secondary:hover { background: var(--hover-bg); color: var(--text); }

.btn-primary {
  background: var(--accent); border: none; border-radius: 5px;
  color: #fff; font: inherit; font-size: 12px; padding: 6px 16px; cursor: pointer;
}
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-primary:disabled { opacity: 0.45; cursor: default; }
</style>
