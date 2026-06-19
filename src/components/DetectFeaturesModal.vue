<script setup>
import { ref, computed } from 'vue'

const emit = defineEmits(['close', 'run'])

const detector = ref('sift')

const siftSettings = ref({
  maxDim: 1200,
  contrastThreshold: 0.03,
  maxKeypoints: 5000,
})

const detectors = [
  { id: 'sift', label: 'SIFT' },
  { id: 'orb', label: 'ORB', disabled: true },
  { id: 'akaze', label: 'AKAZE', disabled: true },
]

const settings = computed(() => {
  if (detector.value === 'sift') return { ...siftSettings.value }
  return {}
})

function run() {
  emit('run', { detector: detector.value, ...settings.value })
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Detect Features">
      <div class="modal-header">
        <span class="modal-title">Detect Features</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="field">
          <span class="field-label">Detector</span>
          <div class="detector-row">
            <button
              v-for="d in detectors"
              :key="d.id"
              class="detector-btn"
              :class="{ active: detector === d.id, disabled: d.disabled }"
              :disabled="d.disabled"
              :title="d.disabled ? 'Coming soon' : ''"
              @click="!d.disabled && (detector = d.id)"
            >
              {{ d.label }}
            </button>
          </div>
        </div>

        <template v-if="detector === 'sift'">
          <div class="section-sep"></div>

          <div class="field">
            <label class="field-label" for="maxDim">Max resolution</label>
            <div class="input-row">
              <input
                id="maxDim"
                v-model.number="siftSettings.maxDim"
                type="number"
                min="100"
                max="4000"
                step="100"
                class="field-input"
              />
              <span class="field-unit">px</span>
            </div>
            <span class="field-hint">Longest side used for detection. Lower = faster.</span>
          </div>

          <div class="field">
            <label class="field-label" for="contrast">Contrast threshold</label>
            <input
              id="contrast"
              v-model.number="siftSettings.contrastThreshold"
              type="number"
              min="0.001"
              max="0.5"
              step="0.001"
              class="field-input"
            />
            <span class="field-hint">Higher = fewer but more distinctive keypoints.</span>
          </div>

          <div class="field">
            <label class="field-label" for="maxKp">Max keypoints</label>
            <input
              id="maxKp"
              v-model.number="siftSettings.maxKeypoints"
              type="number"
              min="100"
              max="50000"
              step="100"
              class="field-input"
            />
          </div>
        </template>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" @click="run">Run on All Images</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
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
  width: 380px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
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
  gap: 12px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--panel-border);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.field-hint {
  font-size: 11px;
  color: var(--text-dim);
}

.detector-row {
  display: flex;
  gap: 4px;
}

.detector-btn {
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text);
  font-size: 12px;
  padding: 4px 14px;
  cursor: pointer;
  font: inherit;
}

.detector-btn:hover:not(.disabled) {
  background: var(--hover-bg);
}

.detector-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.detector-btn.disabled {
  opacity: 0.35;
  cursor: default;
}

.section-sep {
  height: 1px;
  background: var(--panel-border);
  margin: 2px 0;
}

.input-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.field-input {
  width: 100px;
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text);
  font-size: 13px;
  font: inherit;
  padding: 4px 8px;
}

.field-input:focus {
  outline: none;
  border-color: var(--accent);
}

.field-unit {
  font-size: 12px;
  color: var(--text-dim);
}

.btn {
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text);
  font-size: 13px;
  font: inherit;
  padding: 5px 14px;
  cursor: pointer;
}

.btn:hover {
  background: var(--hover-bg);
}

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.btn-primary:hover {
  opacity: 0.88;
}
</style>
