<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import AdvancedDisclosure from '../ui/AdvancedDisclosure.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import PresetCards from '../ui/PresetCards.vue'
import WarnBox from '../ui/WarnBox.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { useDatasetRecommendations } from '../../../composables/useDatasetRecommendations.js'
import { useRecommendedPreset } from '../../../composables/useRecommendedPreset.js'
import { usePresetSettings, presetOwnedKeys } from '../../../composables/usePresetSettings.js'
import { useComputeSettings } from '../../../composables/useComputeSettings.js'
import {
  DETECT_SIFT_DEFAULTS,
  DETECT_SIFT_PRESETS,
  DETECT_PRESET_META,
  DETECT_DEFAULTS_BY_DETECTOR,
  DETECT_PRESETS_BY_DETECTOR,
} from '../../../core/defaults.user.js'
import { DETECT_TUNING } from '../../../core/tuning.js'
import { LEARNED_DETECTORS, learnedDetector, detectorLabel } from '../../../core/features/learnedDetectors.js'
import { MODELS, isRedistributable } from '../../../core/models/registry.js'
import { planDetection, planImageDetection } from '../../../core/features/detectPlan.js'
import { checkNumberFields } from '../../../utils/numberFields.js'

const props = defineProps({
  // Current image list — used to warn when Append mode would leave a mix of
  // detectors (e.g. some SIFT, some DISK), which breaks LightGlue.
  images: { type: Array, default: () => [] },
})

const emit = defineEmits(['close', 'run'])
const { recommendations } = useDatasetRecommendations()
// The machine compute budget bounds how many images SIFT runs at once (injected at run()).
const { memBudgetBytes } = useComputeSettings()

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
  props.images.filter((img) => img.kpStatus === 'done' && (img.detector ?? 'sift') !== detector.value),
)
const showMixWarning = computed(() => !overwrite.value && staleDetectorImages.value.length > 0)

// A learned detector's GPU path (ONNX Runtime's WebGPU EP) is gated to Chromium in
// core/features/ort.js (resolveBackend) — on Safari/Firefox it always runs on
// CPU WASM (and Safari ignores COEP `credentialless`, so single-threaded too).
// Surface that here, before the user commits to a slow run.
const isChromium = /Chrome\//.test(globalThis.navigator?.userAgent || '')

// Tiling (Advanced): 'off' | 'auto' | 'manual'. When on, the image is first resized to
// the detection resolution and THAT raster is cut into overlapping tiles, detected
// per tile and merged — it bounds memory (the learned detectors' WebGPU OOM) but adds
// no resolution. `tileSize` 0 means auto-derive; each tile keeps only keypoints
// ≥ `overlap`/2 from a cut.
// Prefill from the single source of truth (see core/defaults.user.js). Cloned so
// edits don't mutate the shared constants.
const siftSettings = ref({ ...DETECT_SIFT_DEFAULTS })
// One settings object per learned detector, so switching detectors keeps each
// one's edits (and never carries SIFT's keypoint budget into LightGlue's O(N²)).
const learnedSettings = ref(
  Object.fromEntries(Object.keys(LEARNED_DETECTORS).map((id) => [id, { ...DETECT_DEFAULTS_BY_DETECTOR[id] }])),
)

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
// defaults). `activePreset` derives from the active settings, so editing a key the
// presets set flips to Custom.
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
const restrictedModel = computed(() =>
  learnedSpec.value && !isRedistributable(learnedSpec.value.modelId) ? MODELS[learnedSpec.value.modelId] : null,
)
// Writable proxy onto the active detector's resolution rule, kept in script.
const maxDimMode = computed({
  get: () => activeSettings.value.maxDimMode ?? 'absolute',
  set: (v) => {
    activeSettings.value = { ...activeSettings.value, maxDimMode: v }
  },
})

// Run stays disabled while a field of the ACTIVE detector is blank or out of range
// (rules = the inputs' own min/max/step); tiling fields only while they are shown.
const numbers = computed(() => {
  const s = activeSettings.value
  return checkNumberFields(s, {
    maxDim: {
      label: s.maxDimMode === 'auto' ? 'Minimum resolution' : 'Detection resolution',
      min: 100,
      max: 10000,
      integer: true,
    },
    tileSize: { label: 'Max tile size', min: 256, max: 4096, integer: true, when: s.tiling === 'manual' },
    overlap: { label: 'Tile overlap', min: 0, max: 512, integer: true, when: s.tiling !== 'off' },
    contrastThreshold: { label: 'Contrast threshold', min: 0.001, max: 0.5, when: !isLearned.value },
    maxKeypoints: isLearned.value
      ? { label: 'Max keypoints', min: 128, max: 8192, integer: true }
      : { label: 'Max keypoints', min: 100, max: 50000, integer: true },
  })
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
  RECOMMENDED_PRESET_ID,
  patch: recommendedPatch,
  withRecommended,
  logApplied,
} = useRecommendedPreset({
  stage: 'detection',
  recommendations: detectRecommendations,
  defaults: presetBase,
  labels: DETECT_RECOMMENDATION_LABELS,
})
const presetCards = computed(() => withRecommended(DETECT_PRESET_META))

// A card (and Reset) restores every detector setting except `maxDimMode`: that is a
// mode, not a quality delta, so picking "Detailed" keeps the resolution rule and
// switching it does not flip the card to Custom.
// Recommended is checked first (it is the more specific claim) — it only exists
// when it differs from the defaults, but it can coincide with another preset.
const {
  baseId,
  activePreset,
  selectPreset: applyPreset,
} = usePresetSettings({
  settings: activeSettings,
  defaults: presetBase,
  presets: () => ({ ...presetMap.value, [RECOMMENDED_PRESET_ID]: recommendedPatch.value }),
  cards: presetCards,
  ownedKeys: () =>
    [
      ...new Set([
        ...Object.keys(presetBase.value),
        ...presetOwnedKeys({ ...presetMap.value, [RECOMMENDED_PRESET_ID]: recommendedPatch.value }),
      ]),
    ].filter((k) => k !== 'maxDimMode'),
})

function selectPreset(id) {
  applyPreset(id)
  if (id === RECOMMENDED_PRESET_ID) logApplied()
}

// Learned detectors are fully convolutional, so a single untiled pass on a very large
// network input overflows ONNX Runtime's int32 tensor-size math and OrtRun fails
// outright (see DETECT_TUNING.spMaxUntiledInputPx / diskMaxUntiledInputPx /
// alikedMaxUntiledInputPx + the
// backstop in core/features/learnedDetect.js). Flag
// images that would exceed it at the chosen resolution with tiling OFF — the network
// input is the native size downscaled so its longest side ≤ maxDim — so we can offer to
// auto-tile before dispatching instead of letting the run fail per image.
const UNTILED_CEILING_PX = {
  superpoint: DETECT_TUNING.spMaxUntiledInputPx,
  disk: DETECT_TUNING.diskMaxUntiledInputPx,
  aliked: DETECT_TUNING.alikedMaxUntiledInputPx,
}
const untiledCeilingPx = computed(() => UNTILED_CEILING_PX[detector.value] ?? DETECT_TUNING.spMaxUntiledInputPx)
// The images this run will actually touch (Append skips finished ones).
const runImages = computed(() => props.images.filter((img) => overwrite.value || img.kpStatus !== 'done'))
const oversizedSpImages = computed(() => {
  if (!isLearned.value || lp.value.tiling !== 'off') return []
  return runImages.value.filter((img) => {
    const w = img.meta?.width,
      h = img.meta?.height
    if (!w || !h) return false
    // Same resolution rule as the run (incl. the auto mode), tiling off.
    const p = planImageDetection(w, h, { ...settings.value, detector: detector.value })
    return p.width * p.height > untiledCeilingPx.value
  })
})

// ── Live readout: what each step does to this project's images ────────────────
// The steps run in a fixed order — resize, tile, detect, keep — and the confusion
// this answers is that tiling acts on the RESIZED image (core/features/detectPlan.js).
const plan = computed(() =>
  planDetection(
    runImages.value.map((img) => ({ width: img.meta?.width, height: img.meta?.height })),
    { ...settings.value, detector: detector.value },
  ),
)
const fmt = (n) => Number(n).toLocaleString('en-US')
const dims = (w, h) => `${fmt(w)}×${fmt(h)}`
const tilingOn = computed(() => activeSettings.value.tiling !== 'off')
const tileLimit = computed(() => {
  const t = plan.value?.tileSize
  if (!t?.size) return ''
  return t.exact ? `${fmt(t.size)} px` : `${fmt(t.size)} px or less (fits GPU memory)`
})

const resizeEffect = computed(() => {
  const p = plan.value
  if (!p) return ''
  const n = p.count
  const range = p.minDetect === p.maxDetect ? `${fmt(p.maxDetect)} px` : `${fmt(p.minDetect)}–${fmt(p.maxDetect)} px`
  if (p.downscaled === 0)
    return `All ${fmt(n)} images run at their native size (${range} long side) — nothing is reduced.`
  const L = p.largest
  return (
    `${fmt(p.downscaled)} of ${fmt(n)} images are reduced before detection, to ${range} on the long side. ` +
    `Largest: ${dims(L.natW, L.natH)} → ${dims(L.width, L.height)} (${Math.round(L.scale * 100)} %).`
  )
})
// Tiling only matters when a detection image is larger than one tile.
const tilingIdle = computed(() => tilingOn.value && plan.value && plan.value.tiled === 0)
const tileEffect = computed(() => {
  const p = plan.value
  if (!tilingOn.value) return 'Off — each detection image is processed in a single pass.'
  if (!p) return `Detection images larger than ${tileLimit.value} are split into overlapping tiles.`
  if (p.tiled === 0) {
    return (
      `No effect at this resolution: the largest detection image (${fmt(p.maxDetect)} px) already fits in one ` +
      `${tileLimit.value} tile. Tiles are cut from the resized image, so raise the detection resolution for tiling to matter.`
    )
  }
  const L = p.largest
  return (
    `${fmt(p.tiled)} of ${fmt(p.count)} images are split into tiles of ${tileLimit.value}` +
    (L.tiles > 1 ? ` — the largest into ${L.tilesX}×${L.tilesY}` : '') +
    '. Tiles are cut from the resized image: tiling saves memory, it does not add resolution.'
  )
})
const detectEffect = computed(() =>
  isLearned.value
    ? `${learnedLabel.value} uses its learned score threshold — nothing to tune here.`
    : 'SIFT keeps blobs whose contrast clears the threshold.',
)
const keepEffect = computed(() => {
  const k = fmt(activeSettings.value.maxKeypoints)
  const where = tilingOn.value && plan.value?.tiled ? ', ranked over the whole image across all tiles' : ''
  return isLearned.value
    ? `The ${k} highest-scoring keypoints per image are kept${where}.`
    : `At most ${k} keypoints per image are kept, largest features first${where}.`
})

// Clicking Run while images are oversized opens a confirmation dialog rather than
// dispatching straight into a failure — the user goes back to adjust Tiling/resolution
// themselves, or runs anyway.
const awaitingOversizeChoice = ref(false)

function doRun() {
  awaitingOversizeChoice.value = false
  emit('run', {
    detector: detector.value,
    overwrite: overwrite.value,
    ...settings.value,
    memBudgetBytes: memBudgetBytes.value,
  })
}
function attemptRun() {
  if (oversizedSpImages.value.length > 0) {
    awaitingOversizeChoice.value = true
    return
  }
  doRun()
}
// Escape / × / backdrop on the dialog underneath must only dismiss the confirmation
// stacked on it ("Go back"), never the whole dialog. The global modal-focus owner
// (utils/modalFocus.js) normally moves focus into the confirmation and makes this
// dialog inert, so this is the backstop for a key that still lands here.
function onShellClose() {
  if (awaitingOversizeChoice.value) awaitingOversizeChoice.value = false
  else emit('close')
}
</script>

<template>
  <ModalShell title="Detect Features" @close="onShellClose">
    <SettingsField
      label-for="detector-sel"
      hint="SIFT works on any image; the learned detectors (ALIKED, DISK, SuperPoint) pair with LightGlue matching."
    >
      <template #label><FieldHelp op="detect-features" param="detector">Detector</FieldHelp></template>
      <select id="detector-sel" v-model="detector" class="field-input field-select">
        <option v-for="d in detectors" :key="d.id" :value="d.id" :disabled="d.disabled">{{ d.label }}</option>
      </select>
    </SettingsField>

    <SettingsField
      :hint="
        overwrite ? 'Re-detect all images, replacing existing keypoints.' : 'Skip images that already have keypoints.'
      "
    >
      <template #label><FieldHelp op="detect-features" param="overwrite">Mode</FieldHelp></template>
      <SegmentedControl v-model="overwrite" :options="modeOptions" />
    </SettingsField>

    <WarnBox v-if="showMixWarning">
      {{ staleDetectorImages.length }} image{{ staleDetectorImages.length !== 1 ? 's' : '' }} already detected with a
      different detector will be <strong>skipped</strong> in Append mode, leaving a mix of descriptor types. LightGlue
      matching needs every image to use one learned detector — switch to <strong>Overwrite</strong> to make them
      consistent.
    </WarnBox>

    <WarnBox v-if="restrictedModel">
      {{ learnedLabel }}'s pretrained weights are licensed for
      <strong>non-commercial research only</strong>
      (<a :href="restrictedModel.licenseUrl" target="_blank" rel="noopener">license</a>), so WebSfM does not ship them —
      you supply the file once when you first run it. ALIKED and DISK are freely licensed alternatives.
    </WarnBox>

    <WarnBox v-if="isLearned && !isChromium">
      This browser can't run {{ learnedLabel }} on the GPU — WebGPU inference is Chromium-only for now, so it will run
      on the <strong>CPU</strong> (much slower). Use <strong>Chrome or Edge</strong> for GPU speed.
    </WarnBox>

    <!-- Cards, not a select: no value/default on the FieldHelp (the Guide marker's default shows). -->
    <div class="field-label"><FieldHelp op="detect-features" param="preset">Quality preset</FieldHelp></div>
    <PresetCards :model-value="activePreset" :base-id="baseId" :presets="presetCards" @select="selectPreset" />

    <!-- The run at a glance, in execution order, on the largest image it will touch. -->
    <div class="plan-strip">
      <template v-if="plan">
        <div class="plan-caption">
          What happens to the largest of {{ fmt(plan.count) }} image{{ plan.count !== 1 ? 's' : ''
          }}<span v-if="plan.unknown"> ({{ fmt(plan.unknown) }} without a known size yet)</span>:
        </div>
        <div class="plan-chain">
          <span class="plan-chip"
            ><b>{{ dims(plan.largest.natW, plan.largest.natH) }}</b> native</span
          >
          <span class="plan-arrow">→</span>
          <span class="plan-chip" :class="{ dim: plan.largest.scale >= 1 }">
            <span class="plan-n">1</span>
            <template v-if="plan.largest.scale < 1"
              ><b>{{ dims(plan.largest.width, plan.largest.height) }}</b> resized</template
            >
            <template v-else>not resized</template>
          </span>
          <span class="plan-arrow">→</span>
          <span class="plan-chip" :class="{ dim: plan.largest.tiles <= 1 }">
            <span class="plan-n">2</span>
            <template v-if="plan.largest.tiles > 1"
              ><b>{{ plan.largest.tilesX }}×{{ plan.largest.tilesY }}</b> tiles</template
            >
            <template v-else>one pass</template>
          </span>
          <span class="plan-arrow">→</span>
          <span class="plan-chip"><span class="plan-n">3</span>{{ isLearned ? learnedLabel : 'SIFT' }}</span>
          <span class="plan-arrow">→</span>
          <span class="plan-chip"
            ><span class="plan-n">4</span>≤ <b>{{ fmt(activeSettings.maxKeypoints) }}</b> keypoints</span
          >
        </div>
      </template>
      <div v-else-if="!runImages.length" class="plan-caption">
        Every image already has keypoints — Append mode has nothing to do. Switch to Overwrite to re-detect.
      </div>
      <div v-else class="plan-caption">Image sizes are still being read…</div>
    </div>

    <AdvancedDisclosure label="Advanced settings">
      <SettingsStep step="1" title="Resize to detection resolution" :effect="resizeEffect">
        <SettingsField
          label-for="maxDimMode"
          :hint="
            maxDimMode === 'auto'
              ? 'Each image is detected at a fraction of its own size, never below the value below. Best for mixed or very large images such as film scans.'
              : 'Every image is reduced to the same long side, whatever its native size. Smaller images are never enlarged.'
          "
        >
          <template #label><FieldHelp op="detect-features" param="maxDimMode">Resolution rule</FieldHelp></template>
          <select id="maxDimMode" v-model="maxDimMode" class="field-input field-select">
            <option value="absolute">Fixed for all images</option>
            <option value="auto">Scale with image size</option>
          </select>
        </SettingsField>

        <SettingsField
          label-for="maxDim"
          unit="px"
          :hint="
            maxDimMode === 'auto'
              ? 'Floor for the scaled resolution — larger images get proportionally more, up to a per-preset ceiling.'
              : 'Long side the detector works at. Keypoints are mapped back to native pixels afterwards.'
          "
        >
          <template #label
            ><FieldHelp
              op="detect-features"
              param="maxDim"
              :value="activeSettings.maxDim"
              :default-value="presetBase.maxDim"
              >{{ maxDimMode === 'auto' ? 'Minimum resolution' : 'Detection resolution' }}</FieldHelp
            ></template
          >
          <input
            id="maxDim"
            v-model.number="activeSettings.maxDim"
            :aria-invalid="numbers.bad.maxDim"
            type="number"
            min="100"
            max="10000"
            step="100"
            class="field-input"
          />
        </SettingsField>
      </SettingsStep>

      <SettingsStep step="2" title="Split into tiles" :effect="tileEffect" :inactive="!tilingOn || tilingIdle">
        <SettingsField
          label-for="tiling"
          :hint="
            isLearned
              ? 'Processes the resized image in overlapping pieces that fit GPU memory, then merges them.'
              : 'Processes the resized image in overlapping pieces, then merges them. Same keypoints, less memory.'
          "
        >
          <template #label><FieldHelp op="detect-features" param="tiling">Tiling</FieldHelp></template>
          <select id="tiling" v-model="activeSettings.tiling" class="field-input field-select">
            <option value="off">Off</option>
            <option value="auto">{{ isLearned ? 'Auto (fit GPU memory)' : 'Auto (fit tile size)' }}</option>
            <option value="manual">Manual</option>
          </select>
        </SettingsField>
        <SettingsField
          v-if="activeSettings.tiling === 'manual'"
          label-for="tileSize"
          unit="px"
          hint="Upper limit; WebSfM uses the fewest tiles that fit."
        >
          <template #label
            ><FieldHelp
              op="detect-features"
              param="tileSize"
              :value="activeSettings.tileSize"
              :default-value="presetBase.tileSize"
              >Max tile size</FieldHelp
            ></template
          >
          <input
            id="tileSize"
            v-model.number="activeSettings.tileSize"
            :aria-invalid="numbers.bad.tileSize"
            type="number"
            min="256"
            max="4096"
            step="64"
            class="field-input"
          />
        </SettingsField>
        <SettingsField
          v-if="tilingOn"
          label-for="overlap"
          unit="px"
          hint="Each tile keeps only features at least half this far from a cut."
        >
          <template #label
            ><FieldHelp
              op="detect-features"
              param="overlap"
              :value="activeSettings.overlap"
              :default-value="presetBase.overlap"
              >Tile overlap</FieldHelp
            ></template
          >
          <input
            id="overlap"
            v-model.number="activeSettings.overlap"
            :aria-invalid="numbers.bad.overlap"
            type="number"
            min="0"
            max="512"
            step="16"
            class="field-input"
          />
        </SettingsField>
        <WarnBox v-if="oversizedSpImages.length">
          {{ oversizedSpImages.length }} image{{ oversizedSpImages.length !== 1 ? 's' : '' }} will exceed
          {{ learnedLabel }}'s single-pass size limit at this resolution and <strong>fail</strong>. Turn
          <strong>Tiling</strong> on, or lower the detection resolution.
        </WarnBox>
      </SettingsStep>

      <SettingsStep step="3" :title="`Detect (${isLearned ? learnedLabel : 'SIFT'})`" :effect="detectEffect">
        <SettingsField v-if="!isLearned" label-for="contrast" hint="Higher = fewer but more distinctive keypoints.">
          <template #label>
            <FieldHelp
              op="detect-features"
              param="contrastThreshold"
              :value="siftSettings.contrastThreshold"
              :default-value="DETECT_SIFT_DEFAULTS.contrastThreshold"
              >Contrast threshold</FieldHelp
            >
          </template>
          <input
            id="contrast"
            v-model.number="siftSettings.contrastThreshold"
            :aria-invalid="numbers.bad.contrastThreshold"
            type="number"
            min="0.001"
            max="0.5"
            step="0.0001"
            class="field-input"
          />
        </SettingsField>
      </SettingsStep>

      <SettingsStep step="4" title="Keep the strongest" :effect="keepEffect">
        <SettingsField v-if="!isLearned" label-for="maxKp">
          <template #label
            ><FieldHelp
              op="detect-features"
              param="maxKeypoints"
              :value="siftSettings.maxKeypoints"
              :default-value="DETECT_SIFT_DEFAULTS.maxKeypoints"
              >Max keypoints</FieldHelp
            ></template
          >
          <input
            id="maxKp"
            v-model.number="siftSettings.maxKeypoints"
            :aria-invalid="numbers.bad.maxKeypoints"
            type="number"
            min="100"
            max="50000"
            step="100"
            class="field-input"
          />
        </SettingsField>
        <SettingsField v-else label-for="sp-maxKp" hint="LightGlue matching cost grows with the square of this.">
          <template #label>
            <FieldHelp
              op="detect-features"
              param="maxKeypoints"
              :value="lp.maxKeypoints"
              :default-value="presetBase.maxKeypoints"
              >Max keypoints</FieldHelp
            >
          </template>
          <input
            id="sp-maxKp"
            v-model.number="lp.maxKeypoints"
            :aria-invalid="numbers.bad.maxKeypoints"
            type="number"
            min="128"
            max="8192"
            step="128"
            class="field-input"
          />
        </SettingsField>
      </SettingsStep>
    </AdvancedDisclosure>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!numbers.valid" :title="numbers.reason" @click="attemptRun">
        Run on All Images
      </button>
    </template>
  </ModalShell>

  <!-- Oversized-input confirmation: the learned detector would overflow ORT on these images. -->
  <ModalShell v-if="awaitingOversizeChoice" title="Large images may fail" @close="awaitingOversizeChoice = false">
    <p class="confirm-text">
      {{ oversizedSpImages.length }} image{{ oversizedSpImages.length !== 1 ? 's' : '' }} exceed {{ learnedLabel }}'s
      single-pass size limit at this resolution and will likely <strong>fail</strong> (ONNX Runtime overflows its 32-bit
      tensor limit on very large inputs).
    </p>
    <p class="confirm-text">
      Go back to turn <strong>Tiling</strong> on (splits each image into small passes and sidesteps the limit) or lower
      the <strong>Detection resolution</strong> — or run anyway.
    </p>
    <template #footer>
      <button class="btn" @click="awaitingOversizeChoice = false">Go back</button>
      <button class="btn btn-primary" @click="doRun">Run anyway</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.confirm-text {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
  margin: 0;
}
/* The run in execution order: native → resize → tiles → detect → keep. */
.plan-strip {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.plan-caption {
  font-size: 11px;
  color: var(--text-dim);
}
.plan-chain {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.plan-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border: 1px solid var(--panel-border);
  border-radius: 12px;
  font-size: 11px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.plan-chip.dim {
  color: var(--text-dim);
  border-style: dashed;
}
.plan-n {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
}
.plan-chip.dim .plan-n {
  background: var(--text-dim);
}
.plan-arrow {
  font-size: 11px;
  color: var(--text-dim);
}
</style>
