<script setup>
import { computed, onMounted, ref } from 'vue'
import CrsPicker from '../controls/CrsPicker.vue'
import { formatBytes, ARCHIVE_DERIVED_DIRS } from '../../core/io/projectArchive.js'
import { folderLabel, isFolderProject } from '../../core/io/folderProject.js'
import * as opfs from '../../utils/opfs.js'

const props = defineProps({
  project: { type: Object, required: true },
  clearDerived: { type: Function, required: true },
})
const emit = defineEmits(['close', 'rename', 'set-crs'])

const name = ref(props.project.name || '')
const measuring = ref(true)
const clearing = ref(false)
const error = ref('')
const sections = ref([])
const totalBytes = computed(() => sections.value.reduce((sum, row) => sum + row.bytes, 0))
const derivedBytes = computed(() => sections.value
  .filter((row) => ARCHIVE_DERIVED_DIRS.includes(row.id))
  .reduce((sum, row) => sum + row.bytes, 0))

const LABELS = {
  images: 'Source images',
  'images-derived': 'Image previews & transcodes',
  keypoints: 'Keypoints',
  matches: 'Matches',
  depthmaps: 'Depth maps',
  products: 'DEM & orthophoto products',
  project: 'Project metadata',
}

async function measure() {
  measuring.value = true
  error.value = ''
  try {
    const totals = new Map()
    for await (const { relPath, file } of opfs.walkProjectFiles(props.project.id)) {
      const parts = relPath.split('/')
      const id = parts.length > 1 ? parts[0] : 'project'
      totals.set(id, (totals.get(id) || 0) + file.size)
    }
    sections.value = [...totals.entries()]
      .map(([id, bytes]) => ({ id, label: LABELS[id] || id, bytes }))
      .sort((a, b) => b.bytes - a.bytes)
  } catch (err) {
    error.value = `Could not inspect project storage: ${err?.message ?? err}`
  } finally {
    measuring.value = false
  }
}

function commitName() {
  const value = name.value.trim()
  if (!value) { name.value = props.project.name; return }
  if (value !== props.project.name) emit('rename', value)
}

async function onClearDerived() {
  if (!derivedBytes.value) return
  if (!window.confirm(`Clear ${formatBytes(derivedBytes.value)} of derived data? Depth maps and raster products will need to be recomputed; source data and reconstructions are kept.`)) return
  clearing.value = true
  error.value = ''
  try {
    await props.clearDerived()
    await measure()
  } catch (err) {
    error.value = `Could not clear derived data: ${err?.message ?? err}`
  } finally {
    clearing.value = false
  }
}

onMounted(measure)
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Project settings">
      <div class="modal-header">
        <span class="modal-title">Project Settings</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <section class="section">
          <h3>Project</h3>
          <label class="field">
            <span>Name</span>
            <input v-model="name" maxlength="80" @change="commitName" @keydown.enter="commitName">
          </label>
          <div class="readout-row">
            <span>Capture type</span>
            <strong>{{ project.sceneType === 'object' ? 'Object capture' : 'Aerial / mapping' }}</strong>
          </div>
          <div class="readout-row">
            <span>Location</span>
            <strong>{{ isFolderProject(project) ? folderLabel(project) : 'Browser storage' }}</strong>
          </div>
        </section>

        <section v-if="project.sceneType !== 'object'" class="section">
          <h3>Coordinate system</h3>
          <p>Working CRS for maps, GCPs, footprints, and camera positions. Changing it reprojects existing spatial data.</p>
          <CrsPicker :model-value="project.crs || 'EPSG:4326'" @update:model-value="emit('set-crs', $event)" />
        </section>

        <section class="section">
          <div class="section-heading">
            <div>
              <h3>Project storage</h3>
              <p>Files owned by this project only.</p>
            </div>
            <strong v-if="!measuring">{{ formatBytes(totalBytes) }}</strong>
          </div>
          <div v-if="measuring" class="muted">Calculating…</div>
          <div v-else class="breakdown">
            <div v-for="row in sections" :key="row.id" class="breakdown-row">
              <span>{{ row.label }}</span>
              <span>{{ formatBytes(row.bytes) }}</span>
            </div>
            <div v-if="!sections.length" class="muted">No stored project files found.</div>
          </div>
          <div class="clear-row">
            <div>
              <span>Recomputable data</span>
              <small>Image transcodes, depth maps, DEMs, and orthophotos.</small>
            </div>
            <button class="btn danger" :disabled="clearing || measuring || !derivedBytes" @click="onClearDerived">
              Clear {{ derivedBytes ? formatBytes(derivedBytes) : '' }}
            </button>
          </div>
          <div v-if="error" class="error" aria-live="polite">{{ error }}</div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 210; }
.modal { width: 520px; max-width: 92vw; max-height: 86vh; overflow: auto; background: var(--panel); border: 1px solid var(--panel-border); border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 13px 16px; border-bottom: 1px solid var(--panel-border); }
.modal-title { font-size: 14px; font-weight: 600; }
.modal-close { border: 0; background: none; color: var(--text-dim); font-size: 20px; cursor: pointer; padding: 1px 6px; }
.modal-body { padding: 4px 0; }
.section { padding: 14px 16px; }
.section + .section { border-top: 1px solid var(--panel-border); }
h3 { font-size: 12px; font-weight: 650; margin-bottom: 8px; color: var(--text); }
p, .muted, small { display: block; font-size: 11px; line-height: 1.45; color: var(--text-dim); }
p { margin-bottom: 10px; }
.field { display: flex; flex-direction: column; gap: 5px; font-size: 11px; color: var(--text-dim); margin-bottom: 10px; }
.field input { width: 100%; padding: 6px 8px; border: 1px solid var(--panel-border); border-radius: 5px; background: var(--bg); color: var(--text); font: inherit; }
.readout-row, .breakdown-row, .clear-row, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.readout-row { padding: 5px 0; font-size: 12px; color: var(--text-dim); }
.readout-row strong, .section-heading strong { color: var(--text); font-size: 12px; font-weight: 550; }
.section-heading { align-items: flex-start; }
.section-heading h3 { margin-bottom: 2px; }
.breakdown { margin-top: 8px; border: 1px solid var(--panel-border); border-radius: 5px; overflow: hidden; }
.breakdown-row { padding: 6px 8px; font-size: 11px; }
.breakdown-row + .breakdown-row { border-top: 1px solid var(--panel-border); }
.breakdown-row span:last-child { color: var(--text-dim); }
.breakdown .muted { padding: 8px; }
.clear-row { margin-top: 12px; }
.clear-row > div > span { display: block; font-size: 12px; }
.btn { white-space: nowrap; }
.btn.danger:hover:not(:disabled) { color: #e66; border-color: #e66; background: rgba(220,50,50,.1); }
.error { margin-top: 10px; color: #e66; font-size: 11px; }
</style>
