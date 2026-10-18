<script setup>
import { ref, computed, watch } from 'vue'
import FieldHelp from '../guide/FieldHelp.vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsStep from './ui/SettingsStep.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import PresetCards from './ui/PresetCards.vue'
import WarnBox from './ui/WarnBox.vue'
import { useComputeSettings } from '../../composables/useComputeSettings.js'
import { useDatasetRecommendations } from '../../composables/useDatasetRecommendations.js'
import { useLog } from '../../composables/useLog.js'
import { usePresetSettings } from '../../composables/usePresetSettings.js'
import { MATCH_DEFAULTS, MATCH_PRESETS, MATCH_PRESET_META } from '../../core/defaults.user.js'
import { initialMatchStrategy } from '../../core/recommend.js'
import { MATCH_TUNING } from '../../core/tuning.js'
import { estimatePairCount, subsetGateStatus } from '../../core/features/matchPlan.js'
import { checkNumberFields } from '../../utils/numberFields.js'

const props = defineProps({
  // Largest detected keypoint count over all images (for the density auto-hint).
  detectedMaxKeypoints: { type: Number, default: 0 },
  // Images with finished detection — what the pair-count readout counts over.
  detectedImageCount: { type: Number, default: 0 },
  // How many images can drive each preselect method (gates the method choice).
  posedImageCount: { type: Number, default: 0 },
  footprintImageCount: { type: Number, default: 0 },
})

const emit = defineEmits(['close', 'run'])

// GPU is a machine-level preference now (Settings ▸ Compute), injected on run.
const { useGpu } = useComputeSettings()
const { recommendations } = useDatasetRecommendations()
const { log } = useLog()

// Preselect needs ≥2 images carrying the relevant evidence to prune anything.
const hasPoses = computed(() => props.posedImageCount >= 2)
const hasFootprints = computed(() => props.footprintImageCount >= 2)
const preselectAvailable = computed(() => hasPoses.value || hasFootprints.value)

const strategy = ref(initialMatchStrategy(props.posedImageCount))
const strategyTouched = ref(false)
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

// Metadata/CRS synchronization is asynchronous. If positions become ready while
// this modal is open, select proximity automatically only while the field is still
// pristine; never override an explicit user choice.
watch(hasPoses, (ready) => {
  if (ready && !strategyTouched.value && strategy.value === 'exhaustive') {
    strategy.value = 'preselect'
    settings.value = { ...settings.value, preselectMethod: 'position' }
  }
})

function selectStrategy(value) {
  strategyTouched.value = true
  strategy.value = value
}

// Matcher: brute-force NN + Lowe ratio (works on any descriptor) or LightGlue
// (learned; requires one learned detector — SuperPoint, DISK or ALIKED — on every image;
// the store picks the matching weights and guards mismatches).
const matcher = ref('bruteforce')
const matchers = [
  { id: 'bruteforce', label: 'Brute-force + RANSAC' },
  { id: 'lightglue', label: 'LightGlue (learned)' },
]

// Prefill from the single source of truth (core/defaults.user.js); useMatchesStore
// falls back to the same values. Cloned so edits don't mutate the shared constant.
const settings = ref({ ...MATCH_DEFAULTS })

// Quality presets tune the geometric-verification strictness (deltas over defaults)
// and own only the keys they patch (ratio, inlier ratio, RANSAC iterations): a card
// leaves the pairing window, preselect method, density and LightGlue caps alone, and
// changing those does not read as "· modified".
const { baseId, activePreset, selectPreset } = usePresetSettings({
  settings, defaults: MATCH_DEFAULTS, presets: MATCH_PRESETS, cards: MATCH_PRESET_META,
})

// The derived knob here is the pairing STRATEGY, which is not what the quality
// presets tune — so the recommendation is surfaced on the strategy field itself
// rather than as a card that would silently reach past its own dimension.
const matchRecommendations = computed(() => {
  const out = { ...recommendations.value.match }
  // A project can contain an unmatched imported pose. The modal's matched-image
  // count is the authority on whether position preselection can actually run.
  if (out.strategy?.value === 'preselect' && !preselectAvailable.value) {
    delete out.strategy
    delete out.preselectMethod
  }
  return out
})
const strategyRec = computed(() => matchRecommendations.value.strategy ?? null)
const strategyRecLabel = computed(
  () => strategies.value.find((s) => s.id === strategyRec.value?.value)?.label ?? strategyRec.value?.value,
)
const strategyRecApplied = computed(() => strategy.value === strategyRec.value?.value)
function applyStrategyRecommendation() {
  const rec = strategyRec.value
  if (!rec) return
  strategy.value = rec.value
  log(`Recommended matching: Pairing strategy = ${rec.value} — ${rec.reason}`, 'info', 'Recommend')
  const method = matchRecommendations.value.preselectMethod
  if (method) {
    settings.value = { ...settings.value, preselectMethod: method.value }
    log(`Recommended matching: Preselect by = ${method.value} — ${method.reason}`, 'info', 'Recommend')
  }
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

// ── Live readout: what each step will do, in the order matchAll does it ───────
const fmt = (n) => Number(n).toLocaleString('en-US')
const pairs = computed(() => estimatePairCount(props.detectedImageCount, { strategy: strategy.value, ...settings.value }))
const pairsEffect = computed(() => {
  const n = props.detectedImageCount
  if (n < 2) return 'Needs at least 2 images with keypoints.'
  const { count, exact } = pairs.value
  const all = (n * (n - 1)) / 2
  if (count == null) return `${fmt(n)} images: pairs whose footprints overlap enough, out of ${fmt(all)} possible.`
  const share = all > 0 && count < all ? ` (${Math.round((100 * count) / all)} % of all ${fmt(all)})` : ''
  return `${fmt(n)} images → ${exact ? '' : 'at most '}${fmt(count)} pairs${share}.`
})
// Subset gate: the store bypasses it for an overlap-prefiltered pair set or a
// small one; say so here instead of offering a knob that will be ignored.
const gate = computed(() => subsetGateStatus({
  matcher: matcher.value, strategy: strategy.value, subsetGate: settings.value.subsetGate,
  pairCount: pairs.value.exact ? pairs.value.count : null,
}))
const descriptorEffect = computed(() => {
  if (matcher.value === 'bruteforce') {
    return `Each keypoint is paired with its nearest descriptor in the other image if it is clearly closer than the runner-up (ratio ${settings.value.ratioThreshold})${settings.value.crossCheck ? ', and only if the choice is mutual' : ''}.`
  }
  return density.value === 'full'
    ? 'LightGlue first matches a coarse sample to align the images, then matches every keypoint in aligned tiles.'
    : `LightGlue matches the strongest ${settings.value.lgMaxKeypoints > 0 ? fmt(settings.value.lgMaxKeypoints) : 'keypoints (all)'} per image in one pass.`
})
const verifyEffect = computed(() => (settings.value.geometricVerification
  ? `Matches that do not fit one epipolar geometry (within ${settings.value.ransacThreshPx} px at detection resolution) are discarded.`
  : 'Off — every putative match is kept, including the wrong ones.'))
const acceptFloor = computed(() => Math.min(MATCH_TUNING.rawSkipFloor, settings.value.minMatches))
const acceptEffect = computed(() => (settings.value.geometricVerification
  ? `A pair is kept with at least ${settings.value.minMatches} verified matches and at least ${Math.round(settings.value.minInlierRatio * 100)} % of its putatives surviving (${MATCH_TUNING.overrideInliers}+ verified matches pass regardless of the share).`
  : `Without verification a pair is kept with at least ${acceptFloor.value} putative matches.`))

// Run stays disabled while a field this run uses is blank or out of range (rules =
// the inputs' own min/max/step). Only the fields shown for the chosen strategy /
// matcher / density are checked. lgMaxKeypoints is the Fast budget (0 = no cap)
// or, on the Full path, the fallback (≥ 256) — the same bounds its inputs carry.
const numbers = computed(() => {
  const s = settings.value
  const lg = matcher.value === 'lightglue', bf = matcher.value === 'bruteforce'
  const full = density.value === 'full', verify = s.geometricVerification
  return checkNumberFields(s, {
    sequentialOverlap: { label: 'Following images', min: 1, max: 50, integer: true, when: strategy.value === 'sequential' },
    maxNeighbors: { label: 'Neighbours per image', min: 1, max: 50, integer: true,
      when: strategy.value === 'preselect' && s.preselectMethod === 'position' },
    minOverlap: { label: 'Minimum overlap %', min: 1, max: 100, integer: true,
      when: strategy.value === 'preselect' && s.preselectMethod !== 'position' },
    ratioThreshold: { label: 'Ratio threshold', min: 0.5, max: 0.95, when: bf },
    lgMaxKeypoints: { label: full ? 'Fallback keypoints per image' : 'Keypoints per image',
      min: full ? 256 : 0, max: 8192, integer: true, when: lg },
    lgTileBudget: { label: 'Keypoints per tile', min: 256, max: 8192, integer: true, when: lg && full },
    subsetGateSize: { label: 'Subset size', min: 50, max: 1000, integer: true, when: bf && gate.value.active },
    subsetGateThreshold: { label: 'Min subset matches', min: 1, max: 100, integer: true, when: bf && gate.value.active },
    ransacThreshPx: { label: 'RANSAC threshold', min: 0.5, max: 8, when: verify },
    maxIters: { label: 'RANSAC iterations', min: 100, max: 5000, integer: true, when: verify },
    minMatches: { label: 'Min matches per pair', min: 4, max: 100, integer: true },
    minInlierRatio: { label: 'Min inlier ratio', min: 0, max: 0.9, when: verify },
  })
})

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

    <SettingsStep step="1" title="Choose image pairs" :effect="pairsEffect">
      <SettingsField
        hint="Exhaustive matches all pairs. Sequential uses a capture-order neighbour window and needs no GPS. Preselect prunes pairs by camera position or footprint overlap (EXIF GPS, imported poses, or footprints).">
        <template #label><FieldHelp op="match-features" param="strategy">Pairing</FieldHelp></template>
        <SegmentedControl :model-value="strategy" :options="strategies" @update:model-value="selectStrategy" />
        <div v-if="strategyRec" class="rec-inline">
          <button
            v-if="!strategyRecApplied"
            type="button" class="link-btn"
            @click="applyStrategyRecommendation"
          >Use recommended: {{ strategyRecLabel }}</button>
          <span v-else class="rec-inline-ok">✓ Recommended for this dataset</span>
          <span class="rec-inline-reason">{{ strategyRec.reason }}</span>
        </div>
      </SettingsField>

      <template v-if="strategy === 'sequential'">
        <SettingsField label-for="sequentialOverlap"
          hint="Match each image to this many following images in capture order. Ten is a strong starting point for an orbit and is much denser than adjacent-only matching.">
          <template #label><FieldHelp op="match-features" param="sequentialOverlap" :value="settings.sequentialOverlap" :default-value="MATCH_DEFAULTS.sequentialOverlap">Following images</FieldHelp></template>
          <input id="sequentialOverlap" v-model.number="settings.sequentialOverlap" :aria-invalid="numbers.bad.sequentialOverlap" type="number" min="1" max="50" step="1" class="field-input" />
        </SettingsField>
        <SettingsField
          hint="For a complete orbit, also match the last images to the first images so the match graph closes around the object.">
          <template #label><FieldHelp op="match-features" param="sequentialLoopClosure" :value="settings.sequentialLoopClosure" :default-value="MATCH_DEFAULTS.sequentialLoopClosure">Close capture loop</FieldHelp></template>
          <label class="checkbox-row"><input v-model="settings.sequentialLoopClosure" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>
      </template>

      <template v-if="strategy === 'preselect'">
        <SettingsField
          hint="Camera position keeps each image's nearest cameras (EXIF GPS or imported poses). Footprint overlap keeps pairs whose footprints share ground (needs footprints) — better when views converge or point different ways.">
          <template #label><FieldHelp op="match-features" param="preselectMethod">Preselect by</FieldHelp></template>
          <SegmentedControl v-model="settings.preselectMethod" :options="preselectMethods" />
        </SettingsField>

        <SettingsField v-if="settings.preselectMethod === 'position'" label-for="maxNeighbors"
          hint="Match each image to its N nearest by camera position. Needs EXIF GPS or imported poses.">
          <template #label><FieldHelp op="match-features" param="maxNeighbors" :value="settings.maxNeighbors" :default-value="MATCH_DEFAULTS.maxNeighbors">Neighbours per image</FieldHelp></template>
          <input id="maxNeighbors" v-model.number="settings.maxNeighbors" :aria-invalid="numbers.bad.maxNeighbors" type="number" min="1" max="50" step="1" class="field-input" />
        </SettingsField>

        <SettingsField v-else label-for="minOverlap"
          hint="Keep a pair when the smaller footprint shares at least this much of its area with the other. Needs image footprints.">
          <template #label><FieldHelp op="match-features" param="minOverlap" :value="settings.minOverlap" :default-value="MATCH_DEFAULTS.minOverlap">Minimum overlap %</FieldHelp></template>
          <input id="minOverlap" v-model.number="settings.minOverlap" :aria-invalid="numbers.bad.minOverlap" type="number" min="1" max="100" step="1" class="field-input" />
        </SettingsField>
      </template>
    </SettingsStep>

    <SettingsStep step="2" title="Match descriptors" :effect="descriptorEffect">
      <SettingsField
        :hint="matcher === 'lightglue'
          ? 'Learned joint matcher — requires every image detected with the same learned detector (ALIKED, DISK or SuperPoint).'
          : 'Nearest-neighbour descriptor matching with Lowe\'s ratio test. Works with any detector.'">
        <template #label><FieldHelp op="match-features" param="matcher">Matcher</FieldHelp></template>
        <SegmentedControl v-model="matcher" :options="matchers" />
      </SettingsField>

      <SettingsField v-if="matcher === 'bruteforce'" label-for="ratio"
        hint="Lowe's ratio test. Lower = fewer but more reliable matches.">
        <template #label><FieldHelp op="match-features" param="ratioThreshold" :value="settings.ratioThreshold" :default-value="MATCH_DEFAULTS.ratioThreshold">Ratio threshold</FieldHelp></template>
        <input id="ratio" v-model.number="settings.ratioThreshold" :aria-invalid="numbers.bad.ratioThreshold" type="number" min="0.5" max="0.95" step="0.01" class="field-input" />
      </SettingsField>

      <template v-if="matcher === 'lightglue'">
        <SettingsField
          :hint="density === 'full'
            ? 'Matches every detected keypoint in homography-guided tiles. Slower — best with GPU + tiled detection.'
            : 'Matches only the strongest keypoints per image (LightGlue attention is O(N²)).'">
          <template #label><FieldHelp op="match-features" param="density">Matching density</FieldHelp></template>
          <SegmentedControl v-model="density" :options="densityOptions" />
        </SettingsField>
        <!-- The one budget that governs the chosen density — the other is not used. -->
        <SettingsField v-if="density === 'full'" label-for="lgTileBudget"
          hint="Attention budget per tile. Higher = denser matches per tile, slower.">
          <template #label><FieldHelp op="match-features" param="lgTileBudget" :value="settings.lgTileBudget" :default-value="MATCH_DEFAULTS.lgTileBudget">Keypoints per tile</FieldHelp></template>
          <input id="lgTileBudget" v-model.number="settings.lgTileBudget" :aria-invalid="numbers.bad.lgTileBudget" type="number"
            min="256" max="8192" step="256" class="field-input" />
        </SettingsField>
        <SettingsField v-else label-for="lgMaxKeypoints"
          hint="The strongest keypoints per image are matched. Runtime grows with the square of this; 0 = no cap.">
          <template #label><FieldHelp op="match-features" param="lgMaxKeypoints" :value="settings.lgMaxKeypoints" :default-value="MATCH_DEFAULTS.lgMaxKeypoints">Keypoints per image</FieldHelp></template>
          <input id="lgMaxKeypoints" v-model.number="settings.lgMaxKeypoints" :aria-invalid="numbers.bad.lgMaxKeypoints" type="number"
            min="0" max="8192" step="256" class="field-input" />
        </SettingsField>
        <WarnBox v-if="capBites">
          Detection stored up to {{ fmt(detectedMaxKeypoints) }} keypoints — only the strongest
          {{ fmt(settings.lgMaxKeypoints) }} will be matched. Switch to <b>Full</b> density to use all of them.
        </WarnBox>
      </template>
    </SettingsStep>

    <AdvancedDisclosure label="Advanced settings">
      <SettingsStep step="2" title="Match descriptors — advanced">
        <SettingsField v-if="matcher === 'bruteforce'"
          hint="Keeps only mutual nearest neighbours. Slower but more precise.">
          <template #label><FieldHelp op="match-features" param="crossCheck" :value="settings.crossCheck" :default-value="MATCH_DEFAULTS.crossCheck">Cross-check (mutual NN)</FieldHelp></template>
          <label class="checkbox-row"><input v-model="settings.crossCheck" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>

        <SettingsField
          hint="Drops matches that stay at the same pixel in both images — fiducials, frame edges, data strips, reseau crosses, scanner dust. For film and satellite scans; a real scene point moves with the baseline.">
          <template #label><FieldHelp op="match-features" param="filterStationary" :value="settings.filterStationary" :default-value="MATCH_DEFAULTS.filterStationary">Ignore stationary points</FieldHelp></template>
          <label class="checkbox-row"><input v-model="settings.filterStationary" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>

        <template v-if="matcher === 'bruteforce'">
          <SettingsField
            :hint="gate.reason ?? 'Match a small spatially-uniform subset first; skip the full match for pairs that clearly don\'t overlap.'">
            <template #label><FieldHelp op="match-features" param="subsetGate" :value="settings.subsetGate" :default-value="MATCH_DEFAULTS.subsetGate">Subset gate (fast pre-test)</FieldHelp></template>
            <label class="checkbox-row"><input v-model="settings.subsetGate" type="checkbox" class="checkbox"
              :disabled="!!gate.reason" /> {{ gate.reason ? 'Not used for this run' : 'Enabled' }}</label>
          </SettingsField>
          <div v-if="gate.active" class="input-row" style="gap: 12px;">
            <SettingsField label-for="gateSize">
              <template #label><FieldHelp op="match-features" param="subsetGateSize" :value="settings.subsetGateSize" :default-value="MATCH_DEFAULTS.subsetGateSize">Subset size</FieldHelp></template>
              <input id="gateSize" v-model.number="settings.subsetGateSize" :aria-invalid="numbers.bad.subsetGateSize" type="number" min="50" max="1000" step="10" class="field-input" />
            </SettingsField>
            <SettingsField label-for="gateThresh">
              <template #label><FieldHelp op="match-features" param="subsetGateThreshold" :value="settings.subsetGateThreshold" :default-value="MATCH_DEFAULTS.subsetGateThreshold">Min subset matches</FieldHelp></template>
              <input id="gateThresh" v-model.number="settings.subsetGateThreshold" :aria-invalid="numbers.bad.subsetGateThreshold" type="number" min="1" max="100" step="1" class="field-input" />
            </SettingsField>
          </div>
        </template>

        <SettingsField v-if="matcher === 'lightglue' && density === 'full'" label-for="lgMaxKpts"
          hint="Used only when the coarse alignment fails for a pair: it is then matched unguided with this many strongest keypoints.">
          <template #label><FieldHelp op="match-features" param="lgMaxKeypoints" :value="settings.lgMaxKeypoints" :default-value="MATCH_DEFAULTS.lgMaxKeypoints">Fallback keypoints per image</FieldHelp></template>
          <input id="lgMaxKpts" v-model.number="settings.lgMaxKeypoints" :aria-invalid="numbers.bad.lgMaxKeypoints" type="number" min="256" max="8192" step="256" class="field-input" />
        </SettingsField>
        <span v-if="matcher === 'lightglue' && density === 'fast'" class="field-hint">
          No further LightGlue settings for the Fast density.
        </span>
      </SettingsStep>

      <SettingsStep step="3" title="Verify geometry" :effect="verifyEffect" :inactive="!settings.geometricVerification">
        <SettingsField hint="Filter outliers using the fundamental matrix. Strongly recommended.">
          <template #label><FieldHelp op="match-features" param="geometricVerification" :value="settings.geometricVerification" :default-value="MATCH_DEFAULTS.geometricVerification">RANSAC verification</FieldHelp></template>
          <label class="checkbox-row"><input v-model="settings.geometricVerification" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>

        <template v-if="settings.geometricVerification">
          <SettingsField label-for="ransacThresh" unit="detection px"
            hint="Sampson distance threshold for inlier classification. Measured at the
                  detection resolution, so it scales automatically on downscaled images.">
            <template #label><FieldHelp op="match-features" param="ransacThreshPx" :value="settings.ransacThreshPx" :default-value="MATCH_DEFAULTS.ransacThreshPx">RANSAC threshold</FieldHelp></template>
            <input id="ransacThresh" v-model.number="settings.ransacThreshPx" :aria-invalid="numbers.bad.ransacThreshPx" type="number" min="0.5" max="8.0" step="0.5" class="field-input" />
          </SettingsField>

          <SettingsField label-for="maxIters">
            <template #label><FieldHelp op="match-features" param="maxIters" :value="settings.maxIters" :default-value="MATCH_DEFAULTS.maxIters">RANSAC iterations</FieldHelp></template>
            <input id="maxIters" v-model.number="settings.maxIters" :aria-invalid="numbers.bad.maxIters" type="number" min="100" max="5000" step="100" class="field-input" />
          </SettingsField>
        </template>
      </SettingsStep>

      <SettingsStep step="4" title="Accept the pair" :effect="acceptEffect">
        <SettingsField label-for="minMatches"
          :hint="settings.geometricVerification
            ? 'Accept floor: pairs whose verified matches fall below this aren\'t accepted.'
            : 'Only lowers the skip floor without verification; raising it above ' + MATCH_TUNING.rawSkipFloor + ' has no effect.'">
          <template #label><FieldHelp op="match-features" param="minMatches" :value="settings.minMatches" :default-value="MATCH_DEFAULTS.minMatches">Min matches per pair</FieldHelp></template>
          <input id="minMatches" v-model.number="settings.minMatches" :aria-invalid="numbers.bad.minMatches" type="number" min="4" max="100" step="1" class="field-input" />
        </SettingsField>
        <WarnBox v-if="settings.geometricVerification && settings.minMatches > 30">
          A high min-matches threshold can sever the match graph on low-overlap datasets.
          Pairs above the weak-pair floor are kept as <b>PnP registration bridges</b>, but
          15 is recommended unless you have a specific reason to raise it.
        </WarnBox>

        <SettingsField v-if="settings.geometricVerification" label-for="minInlierRatio"
          hint="Reject pairs whose verified/putative share is below this — kills false matches on repetitive structure.">
          <template #label><FieldHelp op="match-features" param="minInlierRatio" :value="settings.minInlierRatio" :default-value="MATCH_DEFAULTS.minInlierRatio">Min inlier ratio</FieldHelp></template>
          <input id="minInlierRatio" v-model.number="settings.minInlierRatio" :aria-invalid="numbers.bad.minInlierRatio" type="number" min="0" max="0.9" step="0.05" class="field-input" />
        </SettingsField>
      </SettingsStep>
    </AdvancedDisclosure>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!numbers.valid" :title="numbers.reason" @click="run">Run Matching</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
/* Dataset recommendation for the pairing strategy — a quiet line under the
   control it concerns, not a block above the modal. */
.rec-inline { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; }
.rec-inline .link-btn { font-size: 11px; }
.rec-inline-ok { font-size: 11px; font-weight: 600; color: var(--accent); }
.rec-inline-reason { font-size: 11px; line-height: 1.4; color: var(--text-dim); }
</style>
