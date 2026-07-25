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

<style scoped src="./ui/import-modal.css"></style>
<style scoped>
/* Only what differs from the shared import-preview chrome (see ui/import-modal.css).
   This modal styles the header row directly rather than through .role-cell /
   .header-cell, and keeps body cells in the UI font (no column-role assignment). */
.modal { width: 620px; }
.controls { grid-template-columns: auto 1fr; }
.preview th { background: var(--bg); color: var(--text-dim); font-weight: 600; position: sticky; top: 0; }
.preview td { color: var(--text); }
td .ok { color: #3fae6a; }
td .dim { color: var(--text-dim); }
</style>
