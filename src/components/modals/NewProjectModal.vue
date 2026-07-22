<script setup>
import { ref } from 'vue'
import CrsPicker from '../controls/CrsPicker.vue'
import { folderStorageSupported } from '../../core/io/folderProject.js'

defineProps({
  canCancel: { type: Boolean, default: true },
})

const emit = defineEmits(['create', 'cancel', 'open-file'])

const name = ref('My Project')
const sceneType = ref('aerial')
const crs = ref('EPSG:4326')

// Storage backend. OPFS ('browser') is the default everywhere; the folder option
// needs showDirectoryPicker, which is Chromium-only — hidden, not disabled,
// elsewhere, so the choice never looks broken.
const canUseFolder = folderStorageSupported()
const storage = ref('browser')
// Picked here rather than at submit time: the directory picker itself needs a
// user gesture, and it is also the only way to show *which* folder was chosen.
const folderHandle = ref(null)
const folderError = ref('')

async function pickFolder() {
  folderError.value = ''
  try {
    folderHandle.value = await window.showDirectoryPicker({ mode: 'readwrite' })
    storage.value = 'folder'
  } catch (err) {
    if (err?.name !== 'AbortError') folderError.value = String(err?.message ?? err)
  }
}

function submit() {
  const n = name.value.trim()
  if (!n) return
  if (storage.value === 'folder' && !folderHandle.value) { folderError.value = 'Choose a folder first.'; return }
  // Object-capture projects have no geographic CRS (scale is set manually).
  const crsValue = sceneType.value === 'object' ? null : crs.value
  emit('create', {
    name: n,
    sceneType: sceneType.value,
    crs: crsValue,
    dirHandle: storage.value === 'folder' ? folderHandle.value : null,
  })
}
</script>

<template>
  <div class="modal-overlay" @click.self="canCancel && emit('cancel')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="New Project">
      <div class="modal-header">
        <span class="modal-title">New Project</span>
        <button v-if="canCancel" class="modal-close" @click="emit('cancel')">×</button>
      </div>

      <div class="modal-body">
        <label class="field-label">Project name</label>
        <input
          v-model="name"
          class="name-input"
          type="text"
          placeholder="My Project"
          maxlength="80"
          autofocus
          @keydown.enter="submit"
        />

        <label class="field-label" style="margin-top: 20px">Scene type</label>
        <div class="scene-cards">
          <button
            class="scene-card"
            :class="{ active: sceneType === 'aerial' }"
            @click="sceneType = 'aerial'"
          >
            <span class="scene-icon">✈</span>
            <span class="scene-name">Aerial survey</span>
            <span class="scene-desc">Drone or aerial imagery with GPS coordinates, geo-referenced output</span>
          </button>
          <button
            class="scene-card"
            :class="{ active: sceneType === 'object' }"
            @click="sceneType = 'object'"
          >
            <span class="scene-icon">◼</span>
            <span class="scene-name">Object capture</span>
            <span class="scene-desc">Objects or scenes without GPS — scale set manually</span>
          </button>
        </div>

        <template v-if="canUseFolder">
          <label class="field-label" style="margin-top: 20px">Where to keep the files</label>
          <div class="scene-cards">
            <button
              class="scene-card"
              :class="{ active: storage === 'browser' }"
              @click="storage = 'browser'"
            >
              <span class="scene-icon">▤</span>
              <span class="scene-name">In this browser</span>
              <span class="scene-desc">Private browser storage. Nothing to manage — save a
                <code>.websfm</code> file when you want a copy.</span>
            </button>
            <button
              class="scene-card"
              :class="{ active: storage === 'folder' }"
              @click="pickFolder"
            >
              <span class="scene-icon">🗀</span>
              <span class="scene-name">In a folder…</span>
              <span class="scene-desc">
                <template v-if="folderHandle">Chosen: <code>{{ folderHandle.name }}</code></template>
                <template v-else>A folder on this computer, so the project lives with your other files.</template>
              </span>
            </button>
          </div>
          <span v-if="folderError" class="crs-hint error">{{ folderError }}</span>
        </template>

        <label class="field-label" style="margin-top: 20px">Coordinate system</label>
        <CrsPicker v-model="crs" :disabled="sceneType === 'object'" />
        <span class="crs-hint">{{
          sceneType === 'object'
            ? 'Object-capture projects have no coordinate system — scale is set manually.'
            : 'Working CRS for the map, GCPs and cameras. You can change it later in Settings.'
        }}</span>
      </div>

      <div class="modal-footer">
        <!-- On first launch this dialog is not cancellable, so it is also the only
             way in for someone whose project lives in a .websfm file. -->
        <button class="link-btn" @click="emit('open-file')">Open a project file…</button>
        <span class="footer-spacer" />
        <button v-if="canCancel" class="btn-secondary" @click="emit('cancel')">Cancel</button>
        <button class="btn-primary" :disabled="!name.trim()" @click="submit">Create project</button>
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
  width: 460px;
  max-width: 92vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--panel-border);
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 4px;
}

.modal-close:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.modal-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
}

.field-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  margin-bottom: 8px;
}

.name-input {
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  padding: 7px 10px;
  width: 100%;
  box-sizing: border-box;
  outline: none;
}

.name-input:focus {
  border-color: var(--accent);
}

.scene-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.scene-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 14px;
  background: var(--bg);
  border: 2px solid var(--panel-border);
  border-radius: 7px;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: var(--text);
  transition: border-color 0.1s;
}

.scene-card:hover {
  border-color: var(--text-dim);
}

.scene-card.active {
  border-color: var(--accent);
  background: rgba(14, 99, 156, 0.1);
}

.scene-icon {
  font-size: 22px;
  line-height: 1;
}

.scene-name {
  font-size: 13px;
  font-weight: 600;
}

.scene-desc {
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.4;
}

.crs-hint {
  display: block;
  margin-top: 7px;
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.4;
}

.crs-hint.error { color: #e55; }

.scene-desc code {
  font-size: 10px;
  padding: 0 3px;
  border-radius: 3px;
  background: var(--hover-bg);
}

.modal-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--panel-border);
}

.footer-spacer { flex: 1; }

.link-btn {
  background: none;
  border: none;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  padding: 4px 2px;
  cursor: pointer;
}

.link-btn:hover { text-decoration: underline; }

.btn-secondary {
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  padding: 6px 14px;
  cursor: pointer;
}

.btn-secondary:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.btn-primary {
  background: var(--accent);
  border: none;
  border-radius: 5px;
  color: #fff;
  font: inherit;
  font-size: 12px;
  padding: 6px 16px;
  cursor: pointer;
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-primary:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
