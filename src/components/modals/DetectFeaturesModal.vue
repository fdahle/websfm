<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import PresetCards from './ui/PresetCards.vue'
import WarnBox from './ui/WarnBox.vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import { useDatasetRecommendations } from '../../composables/useDatasetRecommendations.js'
import { useRecommendedPreset } from '../../composables/useRecommendedPreset.js'
import {
  DETECT_SIFT_DEFAULTS, DETECT_SIFT_PRESETS, DETECT_PRESET_META,
  DETECT_DEFAULTS_BY_DETECTOR, DETECT_PRESETS_BY_DETECTOR,
} from '../../core/defaults.user.js'
import { DETECT_TUNING } from '../../core/tuning.js'
import { LEARNED_DETECTORS, learnedDetector, detectorLabel } from '../../core/features/learnedDetectors.js'
import { MODELS, isRedistributable } from '../../core/models/registry.js'

const props = defineProps({
  // Current image list — used to warn when Append mode would leave a mix of
  // detectors (e.g. some SIFT, some DISK), which breaks LightGlue.
  images: { type: Array, default: () => [] },
})

const emit = defineEmits(['close', 'run'])
const { recommendations } = useDatasetRecommendations()

const overwrite = ref(false)
const modeOptions = [
  { id: false, label: 'Append' },
  { id: true, label: 'Overwrite' },
]
const detector = ref('sift')

// Images already detected with a *different* detector than the one selected. In
// Append mode these are skipped (kpStatus === 'done'), so their old descriptors
// survive — a silent footgun for LightGlue, which needs one learned detector. Overwrite
// re-detects everything, so the warning only applies to Append.
const staleDetectorImages = computed(() =>
  props.images.filter(
    (img) => img.kpStatus === 'done' && (img.detector ?? 'sift') !== detector.value,
  ),
)
const showMixWarning = computed(() => !overwrite.value && staleDetectorImages.value.length > 0)

// A learned detector's GPU path (ONNX Runtime's WebGPU EP) is gated to Chromium in
// core/features/ort.js (resolveBackend) — on Safari/Firefox it always runs on
// CPU WASM (and Safari ignores COEP `credentialless`, so single-threaded too).
// Surface that here, before the user commits to a slow run.
const isChromium = /Chrome\//.test(globalThis.navigator?.userAgent || '')

// Tiling defaults (Advanced): 'off' | 'auto' | 'manual'. When on, detection runs
// per overlapping tile at native-ish resolution then merges — more, better-
// localised keypoints, and it sidesteps the learned detectors' WebGPU OOM. `tileSize` 0
// means auto-derive; each tile keeps only keypoints ≥ `overlap`/2 from a cut.
// Prefill from the single source of truth (see core/defaults.user.js). Cloned so
// edits don't mutate the shared constants.
const siftSettings = ref({ ...DETECT_SIFT_DEFAULTS })
// One settings object per learned detector, so switching detectors keeps each
// one's edits (and never carries SIFT's keypoint budget into LightGlue's O(N²)).
const learnedSettings = ref(Object.fromEntries(Object.keys(LEARNED_DETECTORS)
  .map((id) => [id, { ...DETECT_DEFAULTS_BY_DETECTOR[id] }])))

const detectors = [
  { id: 'sift', label: 'SIFT' },
  ...Object.values(LEARNED_DETECTORS).map((d) => ({
    id: d.id,
    // A detector whose weights websfm cannot ship says so where it is chosen.
    label: `${d.label} (learned${isRedistributable(d.modelId) ? '' : ', non-commercial'})`,
  })),
]

const settings = computed(() => {
  // `preset` rides along so the store can pick the auto-resolution band (its floor
  // is that preset's absolute maxDim). `baseId`, not `activePreset`: an edited
  // preset still belongs to the band the user last chose, and 'custom' has none.
  // The dataset-derived card is not one of `detectResolution.js`'s bands (which
  // are compute ceilings per *quality* preset), so it reports the balanced band
  // rather than silently falling through to it inside core.
  const base = { preset: baseId.value === 'recommended' ? 'medium' : baseId.value }
  return { ...base, ...activeSettings.value }
})

// Quality presets apply to whichever detector is active (deltas over that detector's
// defaults). `activePreset` derives from the active settings so any edit flips to Custom.
const learnedSpec = computed(() => learnedDetector(detector.value))
const isLearned = computed(() => !!learnedSpec.value)
const learnedLabel = computed(() => detectorLabel(detector.value))
// The active detector's settings object, read and replaced as a whole.
const activeSettings = computed({
  get: () => (isLearned.value ? learnedSettings.value[detector.value] : siftSettings.value),
  set: (v) => {
    if (isLearned.value) learnedSettings.value = { ...learnedSettings.value, [detector.value]: v }
    else siftSettings.value = v
  },
})
// Reactive object of the active learned detector, for v-model in the template.
const lp = computed(() => learnedSettings.value[detector.value] ?? {})
const presetMap = computed(() => DETECT_PRESETS_BY_DETECTOR[detector.value] ?? DETECT_SIFT_PRESETS)
const presetBase = computed(() => DETECT_DEFAULTS_BY_DETECTOR[detector.value] ?? DETECT_SIFT_DEFAULTS)
// Licence note for a learned detector whose weights websfm does not distribute.
const restrictedModel = computed(() => (learnedSpec.value && !isRedistributable(learnedSpec.value.modelId)
  ? MODELS[learnedSpec.value.modelId] : null))
const baseId = ref('medium')
// `maxDimMode` is a mode, not a quality delta — it is orthogonal to the preset and
// identical across all three, so switching it must not flip the card to Custom.
const PRESET_MATCH_IGNORE = new Set(['maxDimMode'])
// Writable proxy onto the active detector's resolution rule, kept in script.
const maxDimMode = computed({
  get: () => activeSettings.value.maxDimMode ?? 'absolute',
  set: (v) => { activeSettings.value = { ...activeSettings.value, maxDimMode: v } },
})

const detectRecommendations = computed(() => {
  const out = { ...recommendations.value.detect }
  // U2's keypoint budget is explicitly in SIFT units; applying it to a learned
  // detector would violate LightGlue's much tighter attention budget.
  if (isLearned.value) delete out.maxKeypoints
  return out
})
const DETECT_RECOMMENDATION_LABELS = {
  maxDim: 'Detection resolution',
  maxKeypoints: 'Max keypoints',
  tiling: 'Tiling',
  tileSize: 'Tile size',
}
// The derived knobs are the same ones the quality presets tune, so the
// recommendation is offered as one more card rather than a banner above them.
const {
  RECOMMENDED_PRESET_ID, patch: recommendedPatch, withRecommended, logApplied,
} = useRecommendedPreset({
  stage: 'detection',
  recommendations: detectRecommendations,
  defaults: presetBase,
  labels: DETECT_RECOMMENDATION_LABELS,
})
const presetCards = computed(() => withRecommended(DETECT_PRESET_META))

const resolvePreset = (id) => (id === RECOMMENDED_PRESET_ID
  ? { ...presetBase.value, ...recommendedPatch.value }
  : { ...presetBase.value, ...presetMap.value[id] })
// Recommended is checked first (it is the more specific claim) — it only exists
// when it differs from the defaults, but it can coincide with another preset.
const activePreset = computed(() => {
  const s = activeSettings.value
  for (const { id } of presetCards.value) {
    const r = resolvePreset(id)
    if (Object.keys(r).every((k) => PRESET_MATCH_IGNORE.has(k) || s[k] === r[k])) return id
  }
  return 'custom'
})

function selectPreset(id) {
  // Preserve the orthogonal mode across a preset change — picking "Detailed"
  // should not silently switch the resolution rule back to absolute.
  const { maxDimMode } = activeSettings.value
  activeSettings.value = { ...resolvePreset(id), maxDimMode }
  baseId.value = id
  if (id === RECOMMENDED_PRESET_ID) logApplied()
}

// Learned detectors are fully convolutional, so a single untiled pass on a very large
// network input overflows ONNX Runtime's int32 tensor-size math and OrtRun fails
// outright (see DETECT_TUNING.spMaxUntiledInputPx / diskMaxUntiledInputPx + the
// backstop in core/features/learnedDetect.js). Flag
// images that would exceed it at the chosen resolution with tiling OFF — the network
// input is the native size downscaled so its longest side ≤ maxDim — so we can offer to
// auto-tile before dispatching instead of letting the run fail per image.
const untiledCeilingPx = computed(() => (detector.value === 'disk'
  ? DETECT_TUNING.diskMaxUntiledInputPx : DETECT_TUNING.spMaxUntiledInputPx))
const oversizedSpImages = computed(() => {
  if (!isLearned.value || lp.value.tiling !== 'off') return []
  const maxDim = lp.value.maxDim || Infinity
  return props.images.filter((img) => {
    if (!overwrite.value && img.kpStatus === 'done') return false // skipped in Append mode
    const w = img.meta?.width, h = img.meta?.height
    if (!w || !h) return false
    const scale = Math.min(1, maxDim / Math.max(w, h))
    return Math.round(w * scale) * Math.round(h * scale) > untiledCeilingPx.value
  })
})

// Clicking Run while images are oversized opens a confirmation dialog rather than
// dispatching straight into a failure — the user goes back to adjust Tiling/resolution
// themselves, or runs anyway.
const awaitingOversizeChoice = ref(false)

function doRun() {
  awaitingOversizeChoice.value = false
  emit('run', { detector: detector.value, overwrite: overwrite.value, ...settings.value })
}
function attemptRun() {
  if (oversizedSpImages.value.length > 0) { awaitingOversizeChoice.value = true; return }
  doRun()
}
</script>

<template>
  <ModalShell title="Detect Features" @close="emit('close')">
    <SettingsField label-for="detector-sel"
      hint="SIFT works on any image; SuperPoint and DISK (learned) pair with LightGlue matching.">
      <template #label>
        <GlossaryTerm id="sift">Detector</GlossaryTerm>
      </template>
      <select id="detector-sel" v-model="detector" class="field-input field-select">
        <option v-for="d in detectors" :key="d.id" :value="d.id" :disabled="d.disabled">{{ d.label }}</option>
      </select>
    </SettingsField>

    <SettingsField label="Mode"
      :hint="overwrite ? 'Re-detect all images, replacing existing keypoints.' : 'Skip images that already have keypoints.'">
      <SegmentedControl v-model="overwrite" :options="modeOptions" />
    </SettingsField>

    <WarnBox v-if="showMixWarning">
      {{ staleDetectorImages.length }} image{{ staleDetectorImages.length !== 1 ? 's' : '' }}
      already detected with a different detector will be <strong>skipped</strong> in Append
      mode, leaving a mix of descriptor types. LightGlue matching needs every image to use
      one learned detector — switch to <strong>Overwrite</strong> to make them consistent.
    </WarnBox>

    <WarnBox v-if="restrictedModel">
      {{ learnedLabel }}'s pretrained weights are licensed for
      <strong>non-commercial research only</strong>
      (<a :href="restrictedModel.licenseUrl" target="_blank" rel="noopener">license</a>), so websfm
      does not ship them — you supply the file once when you first run it. DISK is a
      freely licensed alternative.
    </WarnBox>

    <WarnBox v-if="isLearned && !isChromium">
      This browser can't run {{ learnedLabel }} on the GPU — WebGPU inference is Chromium-only for
      now, so it will run on the <strong>CPU</strong> (much slower). Use
      <strong>Chrome or Edge</strong> for GPU speed.
    </WarnBox>

    <PresetCards
      :model-value="activePreset"
      :base-id="baseId"
      :presets="presetCards"
      @select="selectPreset"
    />

    <AdvancedDisclosure label="Advanced settings">
      <SettingsGroup title="Detection">
        <SettingsField label="Resolution rule" label-for="maxDimMode"
          :hint="maxDimMode === 'auto'
            ? 'Each image is detected at a fraction of its own size, never below the fixed value. Best for mixed or very large images such as film scans.'
            : 'Every image is detected at the same fixed resolution, whatever its native size.'">
          <select id="maxDimMode" v-model="maxDimMode" class="field-input field-select">
            <option value="absolute">Fixed for all images</option>
            <option value="auto">Scale with image size</option>
          </select>
        </SettingsField>

        <SettingsField v-if="!isLearned" :label="siftSettings.maxDimMode === 'auto' ? 'Minimum resolution' : 'Detection resolution'"
          label-for="maxDim" unit="px"
          :hint="siftSettings.maxDimMode === 'auto'
            ? 'Floor for the scaled resolution — larger images get proportionally more, up to a per-preset ceiling.'
            : 'Longest side the detector runs at (keypoints map back to native pixels).'">
          <input id="maxDim" v-model.number="siftSettings.maxDim" type="number" min="100" max="10000" step="100" class="field-input" />
        </SettingsField>
        <SettingsField v-else :label="lp.maxDimMode === 'auto' ? 'Minimum resolution' : 'Detection resolution'"
          label-for="sp-maxDim" unit="px"
          :hint="lp.maxDimMode === 'auto'
            ? `Floor for the scaled resolution. ${learnedLabel} ceilings stay well below the untiled-input limit.`
            : 'Longest side before detection. Raising it only helps with tiling on.'">
          <input id="sp-maxDim" v-model.number="lp.maxDim" type="number" min="100" max="10000" step="100" class="field-input" />
        </SettingsField>

        <SettingsField v-if="!isLearned" label-for="contrast"
          hint="Higher = fewer but more distinctive keypoints.">
          <template #label>
            <GlossaryTerm id="keypoint">Contrast threshold</GlossaryTerm>
          </template>
          <input id="contrast" v-model.number="siftSettings.contrastThreshold" type="number" min="0.001" max="0.5" step="0.001" class="field-input" />
        </SettingsField>

        <SettingsField v-if="!isLearned" label="Max keypoints" label-for="maxKp">
          <input id="maxKp" v-model.number="siftSettings.maxKeypoints" type="number" min="100" max="50000" step="100" class="field-input" />
        </SettingsField>
        <SettingsField v-else label-for="sp-maxKp"
          hint="Top-K by score after tile merge. LightGlue matching cost grows with this.">
          <template #label>
            Max <GlossaryTerm id="descriptor">keypoints</GlossaryTerm>
          </template>
          <input id="sp-maxKp" v-model.number="lp.maxKeypoints" type="number" min="128" max="8192" step="128" class="field-input" />
        </SettingsField>
      </SettingsGroup>

      <WarnBox v-if="oversizedSpImages.length">
        {{ oversizedSpImages.length }} image{{ oversizedSpImages.length !== 1 ? 's' : '' }}
        will exceed {{ learnedLabel }}'s single-pass size limit at this resolution and
        <strong>fail</strong>. Turn <strong>Tiling</strong> on below, or lower the resolution.
      </WarnBox>

      <SettingsGroup title="Tiling">
        <SettingsField v-if="!isLearned" label="Tiling" label-for="sift-tiling"
          hint="Detect on overlapping full-resolution tiles, then merge. Off = single downsampled pass.">
          <select id="sift-tiling" v-model="siftSettings.tiling" class="field-input field-select">
            <option value="off">Off</option>
            <option value="auto">Auto (fit tile size)</option>
            <option value="manual">Manual</option>
          </select>
        </SettingsField>
        <SettingsField v-else label="Tiling" label-for="sp-tiling"
          hint="Overlapping full-res tiles fit GPU memory (avoids the OOM); auto derives the tile size.">
          <select id="sp-tiling" v-model="lp.tiling" class="field-input field-select">
            <option value="off">Off</option>
            <option value="auto">Auto (fit GPU memory)</option>
            <option value="manual">Manual</option>
          </select>
        </SettingsField>

        <template v-if="!isLearned">
          <SettingsField v-if="siftSettings.tiling === 'manual'" label="Max tile size" label-for="sift-tileSize" unit="px">
            <input id="sift-tileSize" v-model.number="siftSettings.tileSize" type="number" min="256" max="4096" step="64" class="field-input" />
          </SettingsField>
          <SettingsField v-if="siftSettings.tiling !== 'off'" label="Tile overlap" label-for="sift-overlap" unit="px"
            hint="Each tile keeps only features at least half this far from a cut.">
            <input id="sift-overlap" v-model.number="siftSettings.overlap" type="number" min="0" max="512" step="16" class="field-input" />
          </SettingsField>
        </template>
        <template v-else>
          <SettingsField v-if="lp.tiling === 'manual'" label="Max tile size" label-for="sp-tileSize" unit="px">
            <input id="sp-tileSize" v-model.number="lp.tileSize" type="number" min="256" max="4096" step="64" class="field-input" />
          </SettingsField>
          <SettingsField v-if="lp.tiling !== 'off'" label="Tile overlap" label-for="sp-overlap" unit="px"
            hint="Each tile keeps only features at least half this far from a cut.">
            <input id="sp-overlap" v-model.number="lp.overlap" type="number" min="0" max="512" step="16" class="field-input" />
          </SettingsField>
        </template>
      </SettingsGroup>
    </AdvancedDisclosure>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" @click="attemptRun">Run on All Images</button>
    </template>
  </ModalShell>

  <!-- Oversized-input confirmation: the learned detector would overflow ORT on these images. -->
  <ModalShell
    v-if="awaitingOversizeChoice"
    title="Large images may fail"
    @close="awaitingOversizeChoice = false"
  >
    <p class="confirm-text">
      {{ oversizedSpImages.length }} image{{ oversizedSpImages.length !== 1 ? 's' : '' }}
      exceed {{ learnedLabel }}'s single-pass size limit at this resolution and will likely
      <strong>fail</strong> (ONNX Runtime overflows its 32-bit tensor limit on very
      large inputs).
    </p>
    <p class="confirm-text">
      Go back to turn <strong>Tiling</strong> on (splits each image into small passes
      and sidesteps the limit) or lower the <strong>Detection resolution</strong> —
      or run anyway.
    </p>
    <template #footer>
      <button class="btn" @click="awaitingOversizeChoice = false">Go back</button>
      <button class="btn btn-primary" @click="doRun">Run anyway</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.confirm-text { font-size: 12px; line-height: 1.5; color: var(--text); margin: 0; }
</style>
