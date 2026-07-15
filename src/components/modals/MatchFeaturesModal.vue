<script setup>
import { ref, computed } from 'vue'
import FieldHelp from '../guide/FieldHelp.vue'
import { MATCH_DEFAULTS } from '../../core/defaults.user.js'

const props = defineProps({
  // Largest detected keypoint count over all images (for the density auto-hint).
  detectedMaxKeypoints: { type: Number, default: 0 },
})

const emit = defineEmits(['close', 'run'])

const strategy = ref('exhaustive')
const strategies = [
  { id: 'exhaustive', label: 'Exhaustive' },
  { id: 'sequential', label: 'Sequential' },
  { id: 'preselect', label: 'Preselect' },
]

// Matcher: brute-force NN + Lowe ratio (works on any descriptor) or LightGlue
// (learned; requires SuperPoint 256-d descriptors — the store guards mismatches).
const matcher = ref('bruteforce')
const matchers = [
  { id: 'bruteforce', label: 'Brute-force + RANSAC' },
  { id: 'lightglue', label: 'LightGlue (learned)' },
]

// Prefill from the single source of truth (core/defaults.user.js); useMatchesStore
// falls back to the same values. Cloned so edits don't mutate the shared constant.
const settings = ref({ ...MATCH_DEFAULTS })

// P6: one "matching density" mental model instead of three overlapping caps. Fast =
// strongest N keypoints (plain path, lgTiled off); Full = tiled, uses every detected
// keypoint. The numeric caps stay under Advanced. `density` is a view over lgTiled.
const density = computed({
  get: () => (settings.value.lgTiled ? 'full' : 'fast'),
  set: (v) => { settings.value.lgTiled = v === 'full' },
})
const showAdvanced = ref(false)

// Auto-hint: on the Fast path, warn when detection stored far more keypoints than the
// cap will use, so the loss is visible before running (the same is logged at match time).
const capBites = computed(() =>
  matcher.value === 'lightglue' && !settings.value.lgTiled
  && settings.value.lgMaxKeypoints > 0 // 0 = uncapped, nothing is dropped
  && props.detectedMaxKeypoints > settings.value.lgMaxKeypoints)

const runSettings = computed(() => ({
  strategy: strategy.value,
  matcher: matcher.value,
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
            Exhaustive matches all pairs. Sequential matches consecutive images.
            Preselect uses imported camera positions to match only nearby images (cuts O(N²) on strips/blocks).
          </span>
        </div>

        <div v-if="strategy === 'preselect'" class="field">
          <label class="field-label" for="maxNeighbors">Neighbours per image
            <FieldHelp op="match-features" param="maxNeighbors" :default-value="settings.maxNeighbors" /></label>
          <input
            id="maxNeighbors"
            v-model.number="settings.maxNeighbors"
            type="number" min="1" max="50" step="1"
            class="field-input"
          />
          <span class="field-hint">Match each image to its N nearest by camera position. Needs imported poses; images without a pose fall back to exhaustive.</span>
        </div>

        <div class="section-sep"></div>

        <div class="field">
          <span class="field-label">Matcher</span>
          <div class="detector-row">
            <button
              v-for="m in matchers"
              :key="m.id"
              class="detector-btn"
              :class="{ active: matcher === m.id }"
              @click="matcher = m.id"
            >{{ m.label }}</button>
          </div>
          <span class="field-hint">
            {{ matcher === 'lightglue'
              ? 'Learned joint matcher — requires images detected with SuperPoint. Geometric verification still applies.'
              : 'Nearest-neighbour descriptor matching with Lowe\'s ratio test.' }}
          </span>
        </div>

        <div v-if="matcher === 'bruteforce'" class="field">
          <label class="field-label" for="ratio">Ratio threshold
            <FieldHelp op="match-features" param="ratioThreshold" :default-value="settings.ratioThreshold" /></label>
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
          <label class="field-label" for="minMatches">Min matches per pair
            <FieldHelp op="match-features" param="minMatches" :default-value="settings.minMatches" /></label>
          <input
            id="minMatches"
            v-model.number="settings.minMatches"
            type="number" min="4" max="100" step="1"
            class="field-input"
          />
          <span class="field-hint">Accept floor: pairs whose inliers fall below this aren't accepted as verified.</span>
          <span v-if="settings.minMatches > 30" class="warn-box">
            ⚠ A high min-matches threshold can sever the match graph on low-overlap
            datasets (film strips, sparse blocks). Pairs above the weak-pair floor are now
            kept as <b>PnP registration bridges</b> rather than discarded, but the default of
            15 is recommended unless you have a specific reason to raise it.
          </span>
        </div>

        <div v-if="matcher === 'bruteforce'" class="field">
          <label class="checkbox-row">
            <input v-model="settings.crossCheck" type="checkbox" class="checkbox" />
            <span class="field-label">Cross-check (mutual NN)</span>
          </label>
          <span class="field-hint">Keeps only matches that are mutual nearest neighbours. Slower but more precise.</span>
        </div>

        <div v-if="matcher === 'bruteforce'" class="field">
          <label class="checkbox-row">
            <input v-model="settings.subsetGate" type="checkbox" class="checkbox" />
            <span class="field-label">Subset gate (fast pre-test)</span>
          </label>
          <span class="field-hint">
            Match a small spatially-uniform keypoint subset first; skip the full match for pairs
            that clearly don't overlap. Big speedup on exhaustive runs with no imported poses
            (a building shot in a circle). Only affects images with many keypoints.
          </span>
          <div v-if="settings.subsetGate" class="input-row" style="margin-top: 6px; gap: 8px;">
            <label class="field-label" for="gateSize" style="flex: 1;">Subset size
              <input
                id="gateSize"
                v-model.number="settings.subsetGateSize"
                type="number" min="50" max="1000" step="10"
                class="field-input"
              />
            </label>
            <label class="field-label" for="gateThresh" style="flex: 1;">Min subset matches
              <input
                id="gateThresh"
                v-model.number="settings.subsetGateThreshold"
                type="number" min="1" max="100" step="1"
                class="field-input"
              />
            </label>
          </div>
        </div>

        <div v-if="matcher === 'lightglue'" class="field">
          <span class="field-label">Matching density</span>
          <div class="detector-row">
            <button
              class="detector-btn"
              :class="{ active: density === 'fast' }"
              @click="density = 'fast'"
            >Fast ({{ settings.lgMaxKeypoints > 0 ? 'strongest ' + settings.lgMaxKeypoints : 'all — uncapped' }})</button>
            <button
              class="detector-btn"
              :class="{ active: density === 'full' }"
              @click="density = 'full'"
            >Full (tiled — all keypoints)</button>
          </div>
          <span class="field-hint">
            {{ density === 'full'
              ? 'Matches every detected keypoint in homography-guided tiles. Slower — best with GPU + tiled detection.'
              : (settings.lgMaxKeypoints > 0
                ? 'Matches only the strongest ' + settings.lgMaxKeypoints + ' keypoints per image (LightGlue attention is O(N²)).'
                : 'Matches every detected keypoint per image (no cap — LightGlue attention is O(N²)).') }}
          </span>
          <span v-if="capBites" class="field-hint cap-warn">
            ⚠ Detection stored up to {{ detectedMaxKeypoints }} keypoints — only the strongest
            {{ settings.lgMaxKeypoints }} will be matched. Switch to <b>Full</b> density to use all of them.
          </span>
        </div>

        <div v-if="matcher === 'lightglue'" class="field">
          <button class="link-btn" @click="showAdvanced = !showAdvanced">
            {{ showAdvanced ? '▾' : '▸' }} Advanced (keypoint caps)
          </button>
        </div>

        <div v-if="matcher === 'lightglue' && showAdvanced" class="field">
          <label class="field-label" for="lgMaxKpts">Max keypoints per image (Fast path only)</label>
          <input
            id="lgMaxKpts"
            v-model.number="settings.lgMaxKeypoints"
            type="number" min="256" max="8192" step="256"
            class="field-input"
          />
          <span class="field-hint">
            Strongest-first cap fed to LightGlue on the <b>Fast</b> path. Runtime grows with the
            square of this — 2048 ≈ 7 s/pair on CPU, 1024 ≈ 2 s/pair; 0 = no cap. Ignored on the
            <b>Full</b> (tiled) path, which caps per tile instead.
          </span>
        </div>

        <div v-if="matcher === 'lightglue' && showAdvanced && settings.lgTiled" class="field">
          <label class="field-label" for="lgTileBudget">Keypoints per tile (Full path)</label>
          <input
            id="lgTileBudget"
            v-model.number="settings.lgTileBudget"
            type="number" min="256" max="8192" step="256"
            class="field-input"
          />
          <span class="field-hint">Per-tile attention budget when tiled. Higher = denser matches per tile, slower.</span>
        </div>

        <div v-if="matcher === 'lightglue'" class="field">
          <label class="checkbox-row">
            <input v-model="settings.useGpu" type="checkbox" class="checkbox" />
            <span class="field-label">Use GPU (experimental)</span>
          </label>
          <span class="field-hint">Run LightGlue on WebGPU (Chrome/Edge only). Much faster than the CPU path; automatically falls back to CPU if the GPU can't run the model.</span>
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
            <label class="field-label" for="ransacThresh">RANSAC threshold
              <FieldHelp op="match-features" param="ransacThreshPx" :default-value="settings.ransacThreshPx" /></label>
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
            <label class="field-label" for="minInlierRatio">Min inlier ratio
              <FieldHelp op="match-features" param="minInlierRatio" :default-value="settings.minInlierRatio" /></label>
            <input
              id="minInlierRatio"
              v-model.number="settings.minInlierRatio"
              type="number" min="0" max="0.9" step="0.05"
              class="field-input"
            />
            <span class="field-hint">Reject pairs whose inliers/raw is below this — kills false matches on repetitive structure.</span>
          </div>

          <div class="field">
            <label class="field-label" for="maxIters">RANSAC iterations
              <FieldHelp op="match-features" param="maxIters" :default-value="settings.maxIters" /></label>
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
  width: 600px;
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

.cap-warn { color: var(--warn, #d08a2a); }

.warn-box {
  font-size: 11px;
  line-height: 1.4;
  color: var(--text);
  background: rgba(230, 160, 30, 0.12);
  border: 1px solid rgba(230, 160, 30, 0.45);
  border-radius: 5px;
  padding: 7px 9px;
  margin-top: 2px;
}

.link-btn {
  background: none;
  border: none;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  padding: 0;
  cursor: pointer;
  text-align: left;
}

.link-btn:hover { text-decoration: underline; }

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
