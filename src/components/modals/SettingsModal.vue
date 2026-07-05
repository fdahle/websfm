<script setup>
import { ref } from 'vue'
import CrsPicker from '../controls/CrsPicker.vue'
import { useGlossarySettings } from '../../composables/useGlossarySettings.js'

const { glossaryTermsEnabled, setGlossaryTermsEnabled } = useGlossarySettings()

defineProps({
  theme: String,
  crs: { type: String, default: null },
  sceneType: { type: String, default: null },
})
const emit = defineEmits(['close', 'set-theme', 'set-crs'])

const tabs = [
  { id: 'project', label: 'Project' },
  { id: 'display', label: 'Display' },
  { id: 'storage', label: 'Storage' },
  { id: 'debug', label: 'Debug' },
]
const activeTab = ref('project')

// --- Mockup-only state (not wired to anything yet) ---
const gcpAccuracyH = ref('0.05')
const gcpAccuracyV = ref('0.10')
const units = ref('metric')
const baseLayer = ref('satellite')
const markerSize = ref(6)
const showDevConsole = ref(false)
const verboseLogging = ref(false)
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="modal-header">
        <span class="modal-title">Settings</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="tab-bar" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="tab"
          role="tab"
          :class="{ active: activeTab === tab.id }"
          :aria-selected="activeTab === tab.id"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>

      <div class="modal-body">
        <!-- Project -->
        <template v-if="activeTab === 'project'">
          <div v-if="crs && sceneType !== 'object'" class="setting-row setting-row-stacked">
            <div class="setting-info">
              <span class="setting-label">Coordinate system</span>
              <span class="setting-desc">Working CRS for this project's map, GCPs and cameras. Changing it re-projects existing data.</span>
            </div>
            <CrsPicker :model-value="crs" @update:model-value="emit('set-crs', $event)" />
          </div>
          <div v-else-if="sceneType === 'object'" class="setting-row setting-row-stacked">
            <div class="setting-info">
              <span class="setting-label">Coordinate system</span>
              <span class="setting-desc">Object-capture projects have no coordinate system — scale is set manually.</span>
            </div>
            <CrsPicker :model-value="crs || 'EPSG:4326'" disabled />
          </div>
          <div v-else class="empty-note">Open a project to edit its coordinate system.</div>

          <div class="setting-row setting-row-stacked">
            <div class="setting-info">
              <span class="setting-label">Default GCP accuracy <span class="badge">Coming soon</span></span>
              <span class="setting-desc">Assumed measurement accuracy for newly imported ground control points.</span>
            </div>
            <div class="field-grid">
              <label class="field">
                <span>Horizontal (m)</span>
                <input v-model="gcpAccuracyH" type="number" step="0.01" min="0" disabled>
              </label>
              <label class="field">
                <span>Vertical (m)</span>
                <input v-model="gcpAccuracyV" type="number" step="0.01" min="0" disabled>
              </label>
            </div>
          </div>
        </template>

        <!-- Display -->
        <template v-else-if="activeTab === 'display'">
          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Theme</span>
            </div>
            <div class="seg-toggle">
              <button :class="{ active: theme === 'dark' }" @click="emit('set-theme', 'dark')">Dark</button>
              <button :class="{ active: theme === 'light' }" @click="emit('set-theme', 'light')">Light</button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Glossary terms</span>
              <span class="setting-desc">Highlight explained keywords in the UI; hover one for a definition and “Read more”.</span>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                :checked="glossaryTermsEnabled"
                @change="setGlossaryTermsEnabled($event.target.checked)"
              >
              <span class="slider"></span>
            </label>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Units <span class="badge">Coming soon</span></span>
            </div>
            <div class="seg-toggle disabled">
              <button :class="{ active: units === 'metric' }" @click="units = 'metric'">Metric</button>
              <button :class="{ active: units === 'imperial' }" @click="units = 'imperial'">Imperial</button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Map base layer <span class="badge">Coming soon</span></span>
            </div>
            <select v-model="baseLayer" class="select" disabled>
              <option value="satellite">Satellite</option>
              <option value="streets">Streets</option>
              <option value="terrain">Terrain</option>
            </select>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Keypoint marker size <span class="badge">Coming soon</span></span>
            </div>
            <input v-model.number="markerSize" type="range" min="2" max="14" disabled>
          </div>
        </template>

        <!-- Storage -->
        <template v-else-if="activeTab === 'storage'">
          <div class="setting-row setting-row-stacked">
            <div class="setting-info">
              <span class="setting-label">Storage used <span class="badge">Coming soon</span></span>
              <span class="setting-desc">Local data stored in your browser (OPFS).</span>
            </div>
            <div class="usage-bar"><div class="usage-fill" style="width: 38%"></div></div>
            <span class="setting-desc">≈ 380 MB of 1 GB</span>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Clear cached data <span class="badge">Coming soon</span></span>
              <span class="setting-desc">Remove derived files (thumbnails, features). Projects are kept.</span>
            </div>
            <button class="btn" disabled>Clear cache</button>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Export / import project <span class="badge">Coming soon</span></span>
            </div>
            <div class="btn-group">
              <button class="btn" disabled>Export</button>
              <button class="btn" disabled>Import</button>
            </div>
          </div>
        </template>

        <!-- Debug -->
        <template v-else-if="activeTab === 'debug'">
          <div class="empty-note">Diagnostics and developer tools. Nothing here yet.</div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Show dev console <span class="badge">Coming soon</span></span>
            </div>
            <label class="switch">
              <input v-model="showDevConsole" type="checkbox" disabled>
              <span class="slider"></span>
            </label>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Verbose logging <span class="badge">Coming soon</span></span>
            </div>
            <label class="switch">
              <input v-model="verboseLogging" type="checkbox" disabled>
              <span class="slider"></span>
            </label>
          </div>
        </template>
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
  width: 480px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
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

.tab-bar {
  display: flex;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid var(--panel-border);
}

.tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 13px;
  padding: 10px 12px;
  margin-bottom: -1px;
  cursor: pointer;
}

.tab:hover:not(.active) {
  color: var(--text);
}

.tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}

.modal-body {
  padding: 8px 0;
  min-height: 220px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
}

.setting-row + .setting-row {
  border-top: 1px solid var(--panel-border);
}

.setting-row-stacked {
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.setting-label {
  font-size: 13px;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}

.setting-desc {
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.4;
}

.empty-note {
  padding: 16px;
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.5;
}

.badge {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  padding: 1px 5px;
}

/* Segmented toggle (theme/units) */
.seg-toggle {
  display: flex;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
}

.seg-toggle.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.seg-toggle button {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 12px;
  padding: 4px 16px;
  cursor: pointer;
  font: inherit;
}

.seg-toggle button:hover:not(.active) {
  background: var(--hover-bg);
  color: var(--text);
}

.seg-toggle button.active {
  background: var(--accent);
  color: #fff;
}

/* Generic inputs (mockups) */
.field-grid {
  display: flex;
  gap: 10px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  font-size: 11px;
  color: var(--text-dim);
}

.field input,
.text-input,
.select {
  background: var(--input-bg, var(--panel));
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 5px 8px;
}

.text-input {
  width: 100%;
}

input:disabled,
.select:disabled,
.btn:disabled,
input[type="range"]:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn {
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 5px 14px;
  cursor: pointer;
  flex-shrink: 0;
}

.btn-group {
  display: flex;
  gap: 8px;
}

.usage-bar {
  height: 8px;
  border-radius: 4px;
  background: var(--hover-bg);
  overflow: hidden;
}

.usage-fill {
  height: 100%;
  background: var(--accent);
}

/* Switch (debug toggles) */
.switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  inset: 0;
  background: var(--panel-border);
  border-radius: 20px;
  transition: background 0.15s;
}

.slider::before {
  content: '';
  position: absolute;
  height: 14px;
  width: 14px;
  left: 3px;
  top: 3px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.15s;
}

.switch input:checked + .slider {
  background: var(--accent);
}

.switch input:checked + .slider::before {
  transform: translateX(16px);
}
</style>
