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
import {
  DETECT_SIFT_DEFAULTS, DETECT_SUPERPOINT_DEFAULTS,
  DETECT_SIFT_PRESETS, DETECT_SUPERPOINT_PRESETS, DETECT_PRESET_META,
} from '../../core/defaults.user.js'
import { DETECT_TUNING } from '../../core/tuning.js'

const props = defineProps({
  // Current image list — used to warn when Append mode would leave a mix of
  // detectors (e.g. some SIFT, some SuperPoint), which breaks LightGlue.
  images: { type: Array, default: () => [] },
})

const emit = defineEmits(['close', 'run'])

const overwrite = ref(false)
const modeOptions = [
  { id: false, label: 'Append' },
  { id: true, label: 'Overwrite' },
]
const detector = ref('sift')

// Images already detected with a *different* detector than the one selected. In
// Append mode these are skipped (kpStatus === 'done'), so their old descriptors
// survive — a silent footgun for LightGlue, which needs all-SuperPoint. Overwrite
// re-detects everything, so the warning only applies to Append.
const staleDetectorImages = computed(() =>
  props.images.filter(
    (img) => img.kpStatus === 'done' && (img.detector ?? 'sift') !== detector.value,
  ),
)
const showMixWarning = computed(() => !overwrite.value && staleDetectorImages.value.length > 0)

// SuperPoint's GPU path (ONNX Runtime's WebGPU EP) is gated to Chromium in
// core/features/ort.js (resolveBackend) — on Safari/Firefox it always runs on
// CPU WASM (and Safari ignores COEP `credentialless`, so single-threaded too).
// Surface that here, before the user commits to a slow run.
const isChromium = /Chrome\//.test(globalThis.navigator?.userAgent || '')

// Tiling defaults (Advanced): 'off' | 'auto' | 'manual'. When on, detection runs
// per overlapping tile at native-ish resolution then merges — more, better-
// localised keypoints, and it sidesteps the SuperPoint WebGPU OOM. `tileSize` 0
// means auto-derive; `overlap` dedups seam duplicates.
// Prefill from the single source of truth (see core/defaults.user.js). Cloned so
// edits don't mutate the shared constants.
const siftSettings = ref({ ...DETECT_SIFT_DEFAULTS })
const superpointSettings = ref({ ...DETECT_SUPERPOINT_DEFAULTS })

const detectors = [
  { id: 'sift',       label: 'SIFT' },
  { id: 'superpoint', label: 'SuperPoint (learned)' },
  { id: 'orb',        label: 'ORB (coming soon)',   disabled: true },
  { id: 'akaze',      label: 'AKAZE (coming soon)',  disabled: true },
]

const settings = computed(() => {
  if (detector.value === 'sift') return { ...siftSettings.value }
  if (detector.value === 'superpoint') return { ...superpointSettings.value }
  return {}
})

// Quality presets apply to whichever detector is active (deltas over that detector's
// defaults). `activePreset` derives from the active settings so any edit flips to Custom.
const isSp = computed(() => detector.value === 'superpoint')
const activeRef = computed(() => (isSp.value ? superpointSettings : siftSettings))
const presetMap = computed(() => (isSp.value ? DETECT_SUPERPOINT_PRESETS : DETECT_SIFT_PRESETS))
const presetBase = computed(() => (isSp.value ? DETECT_SUPERPOINT_DEFAULTS : DETECT_SIFT_DEFAULTS))
const resolvePreset = (id) => ({ ...presetBase.value, ...presetMap.value[id] })
const baseId = ref('medium')
const activePreset = computed(() => {
  const s = activeRef.value.value
  for (const { id } of DETECT_PRESET_META) {
    const r = resolvePreset(id)
    if (Object.keys(r).every((k) => s[k] === r[k])) return id
  }
  return 'custom'
})
function selectPreset(id) {
  activeRef.value.value = { ...resolvePreset(id) }
  baseId.value = id
}

// SuperPoint is fully convolutional, so a single untiled pass on a very large network
// input overflows ONNX Runtime's int32 tensor-size math and OrtRun fails outright (see
// DETECT_TUNING.spMaxUntiledInputPx + the backstop in core/features/superpoint.js). Flag
// images that would exceed it at the chosen resolution with tiling OFF — the network
// input is the native size downscaled so its longest side ≤ maxDim — so we can offer to
// auto-tile before dispatching instead of letting the run fail per image.
const oversizedSpImages = computed(() => {
  if (detector.value !== 'superpoint' || superpointSettings.value.tiling !== 'off') return []
  const maxDim = superpointSettings.value.maxDim || Infinity
  return props.images.filter((img) => {
    if (!overwrite.value && img.kpStatus === 'done') return false // skipped in Append mode
    const w = img.meta?.width, h = img.meta?.height
    if (!w || !h) return false
    const scale = Math.min(1, maxDim / Math.max(w, h))
    return Math.round(w * scale) * Math.round(h * scale) > DETECT_TUNING.spMaxUntiledInputPx
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
      hint="SIFT works on any image; SuperPoint (learned) pairs with LightGlue matching.">
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
      SuperPoint — switch to <strong>Overwrite</strong> to make them consistent.
    </WarnBox>

    <WarnBox v-if="isSp && !isChromium">
      This browser can't run SuperPoint on the GPU — WebGPU inference is Chromium-only for
      now, so it will run on the <strong>CPU</strong> (much slower). Use
      <strong>Chrome or Edge</strong> for GPU speed.
    </WarnBox>

    <PresetCards
      :model-value="activePreset"
      :base-id="baseId"
      :presets="DETECT_PRESET_META"
      @select="selectPreset"
    />

    <AdvancedDisclosure label="Advanced settings">
      <SettingsGroup title="Detection">
        <SettingsField v-if="!isSp" label="Detection resolution" label-for="maxDim" unit="px"
          hint="Longest side the detector runs at (keypoints map back to native pixels).">
          <input id="maxDim" v-model.number="siftSettings.maxDim" type="number" min="100" max="10000" step="100" class="field-input" />
        </SettingsField>
        <SettingsField v-else label="Detection resolution" label-for="sp-maxDim" unit="px"
          hint="Longest side before detection. Raising it only helps with tiling on.">
          <input id="sp-maxDim" v-model.number="superpointSettings.maxDim" type="number" min="100" max="10000" step="100" class="field-input" />
        </SettingsField>

        <SettingsField v-if="!isSp" label-for="contrast"
          hint="Higher = fewer but more distinctive keypoints.">
          <template #label>
            <GlossaryTerm id="keypoint">Contrast threshold</GlossaryTerm>
          </template>
          <input id="contrast" v-model.number="siftSettings.contrastThreshold" type="number" min="0.001" max="0.5" step="0.001" class="field-input" />
        </SettingsField>

        <SettingsField v-if="!isSp" label="Max keypoints" label-for="maxKp">
          <input id="maxKp" v-model.number="siftSettings.maxKeypoints" type="number" min="100" max="50000" step="100" class="field-input" />
        </SettingsField>
        <SettingsField v-else label-for="sp-maxKp"
          hint="Top-K by score after tile merge. LightGlue matching cost grows with this.">
          <template #label>
            Max <GlossaryTerm id="descriptor">keypoints</GlossaryTerm>
          </template>
          <input id="sp-maxKp" v-model.number="superpointSettings.maxKeypoints" type="number" min="128" max="8192" step="128" class="field-input" />
        </SettingsField>
      </SettingsGroup>

      <WarnBox v-if="oversizedSpImages.length">
        {{ oversizedSpImages.length }} image{{ oversizedSpImages.length !== 1 ? 's' : '' }}
        will exceed SuperPoint's single-pass size limit at this resolution and
        <strong>fail</strong>. Turn <strong>Tiling</strong> on below, or lower the resolution.
      </WarnBox>

      <SettingsGroup title="Tiling">
        <SettingsField v-if="!isSp" label="Tiling" label-for="sift-tiling"
          hint="Detect on overlapping full-resolution tiles, then merge. Off = single downsampled pass.">
          <select id="sift-tiling" v-model="siftSettings.tiling" class="field-input field-select">
            <option value="off">Off</option>
            <option value="auto">Auto (fit tile size)</option>
            <option value="manual">Manual</option>
          </select>
        </SettingsField>
        <SettingsField v-else label="Tiling" label-for="sp-tiling"
          hint="Overlapping full-res tiles fit GPU memory (avoids the OOM); auto derives the tile size.">
          <select id="sp-tiling" v-model="superpointSettings.tiling" class="field-input field-select">
            <option value="off">Off</option>
            <option value="auto">Auto (fit GPU memory)</option>
            <option value="manual">Manual</option>
          </select>
        </SettingsField>

        <template v-if="!isSp">
          <SettingsField v-if="siftSettings.tiling === 'manual'" label="Tile size" label-for="sift-tileSize" unit="px">
            <input id="sift-tileSize" v-model.number="siftSettings.tileSize" type="number" min="256" max="4096" step="64" class="field-input" />
          </SettingsField>
          <SettingsField v-if="siftSettings.tiling !== 'off'" label="Tile overlap" label-for="sift-overlap" unit="px"
            hint="Seam margin so edge features aren't clipped; duplicates are merged.">
            <input id="sift-overlap" v-model.number="siftSettings.overlap" type="number" min="0" max="512" step="16" class="field-input" />
          </SettingsField>
        </template>
        <template v-else>
          <SettingsField v-if="superpointSettings.tiling === 'manual'" label="Tile size" label-for="sp-tileSize" unit="px">
            <input id="sp-tileSize" v-model.number="superpointSettings.tileSize" type="number" min="256" max="4096" step="64" class="field-input" />
          </SettingsField>
          <SettingsField v-if="superpointSettings.tiling !== 'off'" label="Tile overlap" label-for="sp-overlap" unit="px"
            hint="Seam margin so edge features aren't clipped; duplicates are merged.">
            <input id="sp-overlap" v-model.number="superpointSettings.overlap" type="number" min="0" max="512" step="16" class="field-input" />
          </SettingsField>
        </template>
      </SettingsGroup>
    </AdvancedDisclosure>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" @click="attemptRun">Run on All Images</button>
    </template>
  </ModalShell>

  <!-- Oversized-input confirmation: SuperPoint would overflow ORT on these images. -->
  <ModalShell
    v-if="awaitingOversizeChoice"
    title="Large images may fail"
    @close="awaitingOversizeChoice = false"
  >
    <p class="confirm-text">
      {{ oversizedSpImages.length }} image{{ oversizedSpImages.length !== 1 ? 's' : '' }}
      exceed SuperPoint's single-pass size limit at this resolution and will likely
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
