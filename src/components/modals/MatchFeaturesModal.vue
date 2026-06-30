<script setup>
import { ref, computed } from 'vue'

const emit = defineEmits(['close', 'run'])

const strategy = ref('exhaustive')
const strategies = [
  { id: 'exhaustive', label: 'Exhaustive' },
  { id: 'sequential', label: 'Sequential' },
]

const settings = ref({
  ratioThreshold: 0.75,
  crossCheck: false,
  minMatches: 15,
  geometricVerification: true,
  ransacThreshPx: 2.0,
  minInlierRatio: 0.25,
  maxIters: 1000,
})

const runSettings = computed(() => ({
  strategy: strategy.value,
  ...settings.value,
}))

function run() {
  emit('run', runSettings.value)
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Match Features">
      <div class="modal-header">
        <span class="modal-title">Match Features</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="field">
          <span class="field-label">Strategy</span>
          <div class="detector-row">
            <button
              v-for="s in strategies"
              :key="s.id"
              class="detector-btn"
              :class="{ active: strategy === s.id }"
              @click="strategy = s.id"
            >{{ s.label }}</button>
          </div>
          <span class="field-hint">
            Exhaustive matches all pairs. Sequential matches consecutive images (aerial strips).
          </span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="field-label" for="ratio">Ratio threshold</label>
          <div class="input-row">
            <input
              id="ratio"
              v-model.number="settings.ratioThreshold"
              type="number" min="0.5" max="0.95" step="0.01"
              class="field-input"
            />
          </div>
          <span class="field-hint">Lowe's ratio test. Lower = fewer but more reliable matches.</span>
        </div>

        <div class="field">
          <label class="field-label" for="minMatches">Min matches per pair</label>
          <input
            id="minMatches"
            v-model.number="settings.minMatches"
            type="number" min="4" max="500" step="1"
            class="field-input"
          />
          <span class="field-hint">Pairs below this threshold are discarded.</span>
        </div>

        <div class="field">
          <label class="checkbox-row">
            <input v-model="settings.crossCheck" type="checkbox" class="checkbox" />
            <span class="field-label">Cross-check (mutual NN)</span>
          </label>
          <span class="field-hint">Keeps only matches that are mutual nearest neighbours. Slower but more precise.</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <label class="checkbox-row">
            <input v-model="settings.geometricVerification" type="checkbox" class="checkbox" />
            <span class="field-label">Geometric verification (RANSAC)</span>
          </label>
          <span class="field-hint">Filter outliers using the fundamental matrix. Strongly recommended.</span>
        </div>

        <template v-if="settings.geometricVerification">
          <div class="field">
            <label class="field-label" for="ransacThresh">RANSAC threshold</label>
            <div class="input-row">
              <input
                id="ransacThresh"
                v-model.number="settings.ransacThreshPx"
                type="number" min="0.5" max="8.0" step="0.5"
                class="field-input"
              />
              <span class="field-unit">px</span>
            </div>
            <span class="field-hint">Sampson distance threshold for inlier classification.</span>
          </div>

          <div class="field">
            <label class="field-label" for="minInlierRatio">Min inlier ratio</label>
            <input
              id="minInlierRatio"
              v-model.number="settings.minInlierRatio"
              type="number" min="0" max="0.9" step="0.05"
              class="field-input"
            />
            <span class="field-hint">Reject pairs whose inliers/raw is below this — kills false matches on repetitive structure.</span>
          </div>

          <div class="field">
            <label class="field-label" for="maxIters">RANSAC iterations</label>
            <input
              id="maxIters"
              v-model.number="settings.maxIters"
              type="number" min="100" max="5000" step="100"
              class="field-input"
            />
          </div>
        </template>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" @click="run">Run Matching</button>
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
  width: 400px;
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

.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }

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

.modal-close:hover { background: var(--hover-bg); color: var(--text); }

.modal-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 70vh;
  overflow-y: auto;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--panel-border);
}

.field { display: flex; flex-direction: column; gap: 5px; }

.field-label { font-size: 12px; font-weight: 600; color: var(--text); }

.field-hint { font-size: 11px; color: var(--text-dim); }

.detector-row { display: flex; gap: 4px; }

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

.detector-btn:hover { background: var(--hover-bg); }

.detector-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.section-sep { height: 1px; background: var(--panel-border); margin: 2px 0; }

.input-row { display: flex; align-items: center; gap: 6px; }

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

.field-input:focus { outline: none; border-color: var(--accent); }

.field-unit { font-size: 12px; color: var(--text-dim); }

.checkbox-row { display: flex; align-items: center; gap: 8px; cursor: pointer; }

.checkbox { width: 14px; height: 14px; cursor: pointer; accent-color: var(--accent); }

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

.btn:hover { background: var(--hover-bg); }

.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }

.btn-primary:hover { opacity: 0.88; }
</style>
