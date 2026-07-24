<script setup>
import { ref, computed, watch } from 'vue'
import FieldHelp from '../guide/FieldHelp.vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import PresetCards from './ui/PresetCards.vue'
import WarnBox from './ui/WarnBox.vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import { useComputeSettings } from '../../composables/useComputeSettings.js'
import { MATCH_DEFAULTS, MATCH_PRESETS, MATCH_PRESET_META } from '../../core/defaults.user.js'

const props = defineProps({
  // Largest detected keypoint count over all images (for the density auto-hint).
  detectedMaxKeypoints: { type: Number, default: 0 },
  // How many images can drive each preselect method (gates the method choice).
  posedImageCount: { type: Number, default: 0 },
  footprintImageCount: { type: Number, default: 0 },
})

const emit = defineEmits(['close', 'run'])

// GPU is a machine-level preference now (Settings ▸ Compute), injected on run.
const { useGpu } = useComputeSettings()

// Preselect needs ≥2 images carrying the relevant evidence to prune anything.
const hasPoses = computed(() => props.posedImageCount >= 2)
const hasFootprints = computed(() => props.footprintImageCount >= 2)
const preselectAvailable = computed(() => hasPoses.value || hasFootprints.value)

const strategy = ref('exhaustive')
const strategies = computed(() => [
  { id: 'exhaustive', label: 'Exhaustive' },
  { id: 'sequential', label: 'Sequential' },
  { id: 'preselect', label: 'Preselect', disabled: !preselectAvailable.value },
])
const preselectMethods = computed(() => [
  { id: 'position', label: 'Camera position', disabled: !hasPoses.value },
  { id: 'footprint', label: 'Footprint overlap', disabled: !hasFootprints.value },
])

// Keep the chosen preselect method on an *available* one: when the user opens
// Preselect, snap to whichever evidence they actually have.
watch(strategy, (s) => {
  if (s !== 'preselect') return
  const m = settings.value.preselectMethod
  if (m === 'position' && !hasPoses.value && hasFootprints.value) settings.value.preselectMethod = 'footprint'
  else if (m === 'footprint' && !hasFootprints.value && hasPoses.value) settings.value.preselectMethod = 'position'
})

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

// Quality presets tune the geometric-verification strictness (deltas over defaults).
const resolvePreset = (id) => ({ ...MATCH_DEFAULTS, ...MATCH_PRESETS[id] })
const baseId = ref('medium')
const activePreset = computed(() => {
  for (const { id } of MATCH_PRESET_META) {
    const r = resolvePreset(id)
    if (Object.keys(r).every((k) => settings.value[k] === r[k])) return id
  }
  return 'custom'
})
function selectPreset(id) {
  settings.value = { ...resolvePreset(id) }
  baseId.value = id
}

// P6: one "matching density" mental model instead of three overlapping caps. Fast =
// strongest N keypoints (plain path, lgTiled off); Full = tiled, uses every detected
// keypoint. The numeric caps stay under Advanced. `density` is a view over lgTiled.
const density = computed({
  get: () => (settings.value.lgTiled ? 'full' : 'fast'),
  set: (v) => { settings.value.lgTiled = v === 'full' },
})
const densityOptions = computed(() => [
  { id: 'fast', label: `Fast (${settings.value.lgMaxKeypoints > 0 ? 'strongest ' + settings.value.lgMaxKeypoints : 'all — uncapped'})` },
  { id: 'full', label: 'Full (tiled — all keypoints)' },
])

// Auto-hint: on the Fast path, warn when detection stored far more keypoints than the
// cap will use, so the loss is visible before running (the same is logged at match time).
const capBites = computed(() =>
  matcher.value === 'lightglue' && !settings.value.lgTiled
  && settings.value.lgMaxKeypoints > 0 // 0 = uncapped, nothing is dropped
  && props.detectedMaxKeypoints > settings.value.lgMaxKeypoints)

function run() {
  emit('run', { strategy: strategy.value, matcher: matcher.value, ...settings.value, useGpu: useGpu.value })
}
</script>

<template>
  <ModalShell title="Match Features" @close="emit('close')">
    <PresetCards
      :model-value="activePreset"
      :base-id="baseId"
      :presets="MATCH_PRESET_META"
      @select="selectPreset"
    />

    <SettingsGroup title="Strategy">
      <SettingsField
        hint="Exhaustive matches all pairs. Sequential uses a capture-order neighbour window and needs no GPS. Preselect prunes pairs by camera position or footprint overlap (needs imported poses or footprints).">
        <template #label>Pairing</template>
        <SegmentedControl v-model="strategy" :options="strategies" />
      </SettingsField>

      <template v-if="strategy === 'sequential'">
        <SettingsField label-for="sequentialOverlap"
          hint="Match each image to this many following images in capture order. Ten is a strong starting point for an orbit and is much denser than adjacent-only matching.">
          <template #label>Following images
            <FieldHelp op="match-features" param="sequentialOverlap" :default-value="settings.sequentialOverlap" /></template>
          <input id="sequentialOverlap" v-model.number="settings.sequentialOverlap" type="number" min="1" max="50" step="1" class="field-input" />
        </SettingsField>
        <SettingsField
          hint="For a complete orbit, also match the last images to the first images so the match graph closes around the object.">
          <template #label>Close capture loop</template>
          <label class="checkbox-row"><input v-model="settings.sequentialLoopClosure" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>
      </template>

      <template v-if="strategy === 'preselect'">
        <SettingsField
          hint="Camera position keeps each image's nearest cameras (needs imported poses). Footprint overlap keeps pairs whose footprints share ground (needs footprints) — better when views converge or point different ways.">
          <template #label>Preselect by</template>
          <SegmentedControl v-model="settings.preselectMethod" :options="preselectMethods" />
        </SettingsField>

        <SettingsField v-if="settings.preselectMethod === 'position'" label-for="maxNeighbors"
          hint="Match each image to its N nearest by camera position. Needs imported poses.">
          <template #label><GlossaryTerm id="camera-pose">Neighbours per image</GlossaryTerm>
            <FieldHelp op="match-features" param="maxNeighbors" :default-value="settings.maxNeighbors" /></template>
          <input id="maxNeighbors" v-model.number="settings.maxNeighbors" type="number" min="1" max="50" step="1" class="field-input" />
        </SettingsField>

        <SettingsField v-else label-for="minOverlap"
          hint="Keep a pair when the smaller footprint shares at least this much of its area with the other. Needs image footprints.">
          <template #label>Minimum overlap %</template>
          <input id="minOverlap" v-model.number="settings.minOverlap" type="number" min="1" max="100" step="1" class="field-input" />
        </SettingsField>
      </template>
    </SettingsGroup>

    <SettingsGroup title="Matcher">
      <SettingsField
        :hint="matcher === 'lightglue'
          ? 'Learned joint matcher — requires images detected with SuperPoint. Geometric verification still applies.'
          : 'Nearest-neighbour descriptor matching with Lowe\'s ratio test.'">
        <template #label>Algorithm</template>
        <SegmentedControl v-model="matcher" :options="matchers" />
      </SettingsField>

      <SettingsField v-if="matcher === 'bruteforce'" label-for="ratio"
        hint="Lowe's ratio test. Lower = fewer but more reliable matches.">
        <template #label><GlossaryTerm id="lowe-ratio-test">Ratio threshold</GlossaryTerm>
          <FieldHelp op="match-features" param="ratioThreshold" :default-value="settings.ratioThreshold" /></template>
        <input id="ratio" v-model.number="settings.ratioThreshold" type="number" min="0.5" max="0.95" step="0.01" class="field-input" />
      </SettingsField>

      <SettingsField v-if="matcher === 'lightglue'"
        :hint="density === 'full'
          ? 'Matches every detected keypoint in homography-guided tiles. Slower — best with GPU + tiled detection.'
          : (settings.lgMaxKeypoints > 0
            ? 'Matches only the strongest keypoints per image (LightGlue attention is O(N²)).'
            : 'Matches every detected keypoint per image (no cap — attention is O(N²)).')">
        <template #label>Matching density</template>
        <SegmentedControl v-model="density" :options="densityOptions" />
      </SettingsField>
      <WarnBox v-if="capBites">
        Detection stored up to {{ detectedMaxKeypoints }} keypoints — only the strongest
        {{ settings.lgMaxKeypoints }} will be matched. Switch to <b>Full</b> density to use all of them.
      </WarnBox>
    </SettingsGroup>

    <AdvancedDisclosure label="Advanced settings">
      <SettingsGroup title="Acceptance">
        <SettingsField label-for="minMatches"
          hint="Accept floor: pairs whose inliers fall below this aren't accepted as verified.">
          <template #label>Min matches per <GlossaryTerm id="match-graph">pair</GlossaryTerm>
            <FieldHelp op="match-features" param="minMatches" :default-value="settings.minMatches" /></template>
          <input id="minMatches" v-model.number="settings.minMatches" type="number" min="4" max="100" step="1" class="field-input" />
        </SettingsField>
        <WarnBox v-if="settings.minMatches > 30">
          A high min-matches threshold can sever the match graph on low-overlap datasets.
          Pairs above the weak-pair floor are kept as <b>PnP registration bridges</b>, but
          15 is recommended unless you have a specific reason to raise it.
        </WarnBox>

        <SettingsField v-if="matcher === 'bruteforce'"
          hint="Keeps only mutual nearest neighbours. Slower but more precise.">
          <template #label><GlossaryTerm id="lowe-ratio-test">Cross-check (mutual NN)</GlossaryTerm></template>
          <label class="checkbox-row"><input v-model="settings.crossCheck" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>

        <SettingsField v-if="matcher === 'bruteforce'"
          hint="Match a small spatially-uniform subset first; skip the full match for pairs that clearly don't overlap.">
          <template #label>Subset gate (fast pre-test)</template>
          <label class="checkbox-row"><input v-model="settings.subsetGate" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>
        <div v-if="matcher === 'bruteforce' && settings.subsetGate" class="input-row" style="gap: 12px;">
          <SettingsField label="Subset size" label-for="gateSize">
            <input id="gateSize" v-model.number="settings.subsetGateSize" type="number" min="50" max="1000" step="10" class="field-input" />
          </SettingsField>
          <SettingsField label="Min subset matches" label-for="gateThresh">
            <input id="gateThresh" v-model.number="settings.subsetGateThreshold" type="number" min="1" max="100" step="1" class="field-input" />
          </SettingsField>
        </div>
      </SettingsGroup>

      <SettingsGroup v-if="matcher === 'lightglue'" title="LightGlue keypoint caps">
        <SettingsField label="Max keypoints per image (Fast path)" label-for="lgMaxKpts"
          hint="Strongest-first cap on the Fast path. Runtime grows with the square of this; 0 = no cap.">
          <input id="lgMaxKpts" v-model.number="settings.lgMaxKeypoints" type="number" min="256" max="8192" step="256" class="field-input" />
        </SettingsField>
        <SettingsField v-if="settings.lgTiled" label="Keypoints per tile (Full path)" label-for="lgTileBudget"
          hint="Per-tile attention budget when tiled. Higher = denser matches per tile, slower.">
          <input id="lgTileBudget" v-model.number="settings.lgTileBudget" type="number" min="256" max="8192" step="256" class="field-input" />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Geometric verification">
        <SettingsField hint="Filter outliers using the fundamental matrix. Strongly recommended.">
          <template #label>
            <GlossaryTerm id="ransac">RANSAC</GlossaryTerm>
            <GlossaryTerm id="fundamental-matrix">verification</GlossaryTerm>
          </template>
          <label class="checkbox-row"><input v-model="settings.geometricVerification" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>

        <template v-if="settings.geometricVerification">
          <SettingsField label-for="ransacThresh" unit="px"
            hint="Sampson distance threshold for inlier classification.">
            <template #label><GlossaryTerm id="epipolar-geometry">RANSAC threshold</GlossaryTerm>
              <FieldHelp op="match-features" param="ransacThreshPx" :default-value="settings.ransacThreshPx" /></template>
            <input id="ransacThresh" v-model.number="settings.ransacThreshPx" type="number" min="0.5" max="8.0" step="0.5" class="field-input" />
          </SettingsField>

          <SettingsField label-for="minInlierRatio"
            hint="Reject pairs whose inliers/raw is below this — kills false matches on repetitive structure.">
            <template #label>Min inlier ratio
              <FieldHelp op="match-features" param="minInlierRatio" :default-value="settings.minInlierRatio" /></template>
            <input id="minInlierRatio" v-model.number="settings.minInlierRatio" type="number" min="0" max="0.9" step="0.05" class="field-input" />
          </SettingsField>

          <SettingsField label-for="maxIters">
            <template #label>RANSAC iterations
              <FieldHelp op="match-features" param="maxIters" :default-value="settings.maxIters" /></template>
            <input id="maxIters" v-model.number="settings.maxIters" type="number" min="100" max="5000" step="100" class="field-input" />
          </SettingsField>
        </template>
      </SettingsGroup>
    </AdvancedDisclosure>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" @click="run">Run Matching</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
