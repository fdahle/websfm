<script setup>
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import AdvancedDisclosure from '../ui/AdvancedDisclosure.vue'
import WarnBox from '../ui/WarnBox.vue'
import { VIDEO_IMPORT_DEFAULTS } from '../../../core/defaults.user.js'
import { analysisTimes, intervalTimes, relativeSharpness, selectKeyframes } from '../../../core/io/videoFrames.js'
import { openVideoSource, analyzeVideo } from '../../../utils/videoSource.js'
import { checkNumberFields } from '../../../utils/numberFields.js'
import { useLog } from '../../../composables/useLog.js'
import { pluralize } from '../../../core/textFormat.js'

// Import ▸ Video: choose which frames of a video become images. The video is opened
// here to read its size, length and frame rate; the automatic mode also scans it
// (a few samples a second: sharpness + how far the view moved) so the dialog can say
// how many frames it will extract before anything is written. Changing the overlap,
// cap or blur gate re-plans from that scan instantly. Extract hands the planned
// times to the importer (useImportRouting ▸ onVideoImport), which re-reads only
// those frames at full size.
const props = defineProps({ file: { type: Object, required: true } })
const emit = defineEmits(['close', 'run'])
const { log } = useLog()

const settings = ref({ ...VIDEO_IMPORT_DEFAULTS })
const modes = [
  { id: 'auto', label: 'Automatic' },
  { id: 'interval', label: 'Fixed interval' },
]
const units = [
  { id: 'seconds', label: 'seconds' },
  { id: 'frames', label: 'frames' },
]
const formats = [
  { id: 'jpeg', label: 'JPEG' },
  { id: 'png', label: 'PNG (lossless)' },
]

const info = ref(null) // { duration, width, height, fps }
const openError = ref('')
let source = null

// ── Analysis (automatic mode) ─────────────────────────────────────────────────
const samples = shallowRef(null)
const analysing = ref(false)
const analysed = ref({ done: 0, total: 0 })
const analysisError = ref('')
let cancelAnalysis = false

async function analyse() {
  if (!source || analysing.value) return
  analysing.value = true
  analysisError.value = ''
  cancelAnalysis = false
  const { step, times } = analysisTimes(info.value.duration, info.value.fps)
  analysed.value = { done: 0, total: times.length }
  const t0 = performance.now()
  try {
    const result = await analyzeVideo(source, times, {
      onProgress: (done, total) => {
        analysed.value = { done, total }
      },
      shouldCancel: () => cancelAnalysis,
    })
    if (result) {
      samples.value = result
      const fast = result.filter((s) => s.fast).length,
        lost = result.filter((s) => s.lost).length
      log(
        `Video analysis: ${props.file.name} — ${result.length} samples every ${step.toFixed(3)} s in ` +
          `${((performance.now() - t0) / 1000).toFixed(1)} s; travel ${result.at(-1)?.travel.toFixed(2) ?? 0} frame widths` +
          `${fast ? `, ${pluralize(fast, 'sample')} moving faster than the tracker follows` : ''}` +
          `${lost ? `, ${pluralize(pluralize(lost, 'cut'), 'or lost view')}` : ''}`,
        'info',
        'Import',
      )
    }
  } catch (err) {
    analysisError.value = err?.message ?? String(err)
  } finally {
    analysing.value = false
  }
}

function stopAnalysis() {
  cancelAnalysis = true
}

onMounted(async () => {
  try {
    source = await openVideoSource(props.file)
    info.value = { duration: source.duration, width: source.width, height: source.height, fps: source.fps }
    log(
      `Video: ${props.file.name} — ${source.width}×${source.height}, ${source.duration.toFixed(2)} s, ` +
        `${source.fps ? `${source.fps} fps` : 'frame rate unknown (this browser does not report presented frames)'}`,
      'info',
      'Import',
    )
    if (settings.value.mode === 'auto') analyse()
  } catch (err) {
    openError.value = err?.message ?? String(err)
    log(`Video import: ${props.file.name} — ${openError.value}`, 'error', 'Import')
  }
})
onBeforeUnmount(() => {
  cancelAnalysis = true
  source?.close()
  source = null
})
watch(
  () => settings.value.mode,
  (m) => {
    if (m === 'auto' && !samples.value) analyse()
  },
)

// ── Plan ──────────────────────────────────────────────────────────────────────
const numbers = computed(() => {
  const s = settings.value,
    auto = s.mode === 'auto'
  return checkNumberFields(s, {
    every: {
      label: 'Every',
      min: s.unit === 'frames' ? 1 : 0.01,
      max: 3600,
      integer: s.unit === 'frames',
      when: !auto,
    },
    overlap: { label: 'Overlap', min: 0, max: 99, when: auto },
    maxFrames: { label: 'Max frames', min: 2, max: 5000, integer: true, when: auto },
    minSharpness: { label: 'Blurry below', min: 0, max: 1, when: auto },
    jpegQuality: { label: 'JPEG quality', min: 0.5, max: 1, when: s.format === 'jpeg' },
    maxDim: { label: 'Max size', min: 0, max: 16384, integer: true },
  })
})

const selection = computed(() => {
  const s = settings.value
  if (s.mode !== 'auto' || !samples.value || !numbers.value.valid) return null
  return selectKeyframes(samples.value, { overlap: s.overlap, maxFrames: s.maxFrames, minSharpness: s.minSharpness })
})
const times = computed(() => {
  if (!info.value || !numbers.value.valid) return []
  const s = settings.value
  if (s.mode === 'auto') return selection.value?.times ?? []
  return intervalTimes(info.value.duration, { every: s.every, unit: s.unit, fps: info.value.fps })
})

const fmtTime = (t) => {
  const m = Math.floor(t / 60),
    sec = t - 60 * m
  return m ? `${m}:${sec.toFixed(0).padStart(2, '0')} min` : `${sec.toFixed(1)} s`
}
const infoLine = computed(() => {
  const i = info.value
  if (!i) return ''
  return `${i.width} × ${i.height} · ${fmtTime(i.duration)} · ${i.fps ? `${i.fps} fps` : 'frame rate unknown'}`
})
const planLine = computed(() => {
  if (!info.value) return ''
  const n = times.value.length
  if (settings.value.mode === 'auto') {
    if (analysing.value) return `Scanning the video… ${analysed.value.done} / ${analysed.value.total}`
    const sel = selection.value
    if (!sel) return samples.value ? '' : 'Scan the video to plan the frames.'
    const parts = [`${n} frame${n === 1 ? '' : 's'}`]
    if (sel.overlap < settings.value.overlap)
      parts.push(`spaced for ~${sel.overlap} % overlap to stay within ${settings.value.maxFrames}`)
    else parts.push(`~${settings.value.overlap} % overlap`)
    return parts.join(', ')
  }
  return `${n} frame${n === 1 ? '' : 's'}, every ${(info.value.duration / Math.max(1, n)).toFixed(2)} s on average`
})
const notes = computed(() => {
  const sel = selection.value
  if (!sel || !samples.value) return []
  const out = []
  const share = sel.blurry / samples.value.length
  if (sel.blurry)
    out.push(
      `${Math.round(share * 100)} % of the scanned moments are blurry; the sharpest nearby frame is used instead.`,
    )
  if (sel.blurryKept)
    out.push(
      `${pluralize(sel.blurryKept, 'blurry frame')} kept where there was no sharp one, so the sequence stays connected.`,
    )
  if (sel.gaps)
    out.push(
      `${pluralize(sel.gaps, 'place')} where the view moved more than a frame's spacing between two scanned moments (fast motion or a cut).`,
    )
  if (sel.travel < 0.3 && times.value.length < 5)
    out.push('The camera hardly moves in this video. A reconstruction needs viewpoints that move around the subject.')
  return out
})
const tooMany = computed(() => times.value.length > 1000)

// A strip under the plan: travel over time (the line), blurry moments (red dots)
// and the planned frames (ticks).
const strip = computed(() => {
  const d = info.value?.duration
  if (!d) return null
  const W = 600,
    H = 44
  const x = (t) => (t / d) * W
  const ticks = times.value.map(x)
  if (settings.value.mode !== 'auto' || !samples.value) return { W, H, ticks, line: '', blur: [] }
  const total = samples.value.at(-1).travel || 1
  const line = samples.value
    .map((s) => `${x(s.t).toFixed(1)},${(H - 4 - (s.travel / total) * (H - 10)).toFixed(1)}`)
    .join(' ')
  const blur = []
  relativeSharpness(samples.value.map((s) => s.sharpness)).forEach((r, i) => {
    if (r < settings.value.minSharpness) blur.push(x(samples.value[i].t))
  })
  return { W, H, ticks, line, blur }
})

// A running scan only holds back the automatic plan; a fixed interval needs none.
const scanBlocks = computed(() => analysing.value && settings.value.mode === 'auto')
const canRun = computed(() => !!info.value && numbers.value.valid && times.value.length > 0 && !scanBlocks.value)
const runTitle = computed(() => {
  if (!info.value) return openError.value || 'Opening the video…'
  if (!numbers.value.valid) return numbers.value.reason
  if (scanBlocks.value) return 'Wait for the scan to finish'
  if (!times.value.length) return 'No frames planned'
  return ''
})

function run() {
  if (!canRun.value) return
  stopAnalysis()
  const s = settings.value
  emit('run', {
    file: props.file,
    times: [...times.value],
    duration: info.value.duration,
    fps: info.value.fps,
    settings: { ...s },
  })
}
</script>

<template>
  <ModalShell title="Import Video" width="560px" @close="emit('close')">
    <div class="filename">{{ file.name }}</div>
    <div v-if="info" class="field-hint">{{ infoLine }}</div>
    <WarnBox v-if="openError">
      This video cannot be read here: {{ openError }}. Chrome and Edge play MP4 (H.264, AV1) and WebM (VP8, VP9, AV1);
      Firefox the same (H.264 through the system); Safari MP4/MOV (H.264, HEVC) and WebM. Convert the video to an H.264
      MP4 and try again.
    </WarnBox>
    <div v-else-if="!info" class="field-hint">Opening the video…</div>

    <template v-if="info">
      <SettingsGroup title="Frames">
        <SettingsField
          :hint="
            settings.mode === 'auto'
              ? 'Spaces the frames by how far the view moves and keeps the sharpest frame in each step: a pause gives one frame, a fast pan many.'
              : 'Takes a frame at a fixed time step, whatever the camera does.'
          "
        >
          <template #label><FieldHelp op="video-import" param="mode">Frame selection</FieldHelp></template>
          <SegmentedControl v-model="settings.mode" :options="modes" />
        </SettingsField>

        <template v-if="settings.mode === 'interval'">
          <SettingsField label-for="vid-every" hint="Frames at 0, then every step after it.">
            <template #label
              ><FieldHelp
                op="video-import"
                param="every"
                :value="settings.every"
                :default-value="VIDEO_IMPORT_DEFAULTS.every"
                >Every</FieldHelp
              ></template
            >
            <div class="input-row">
              <input
                id="vid-every"
                v-model.number="settings.every"
                :aria-invalid="numbers.bad.every"
                type="number"
                :min="settings.unit === 'frames' ? 1 : 0.01"
                max="3600"
                :step="settings.unit === 'frames' ? 1 : 0.1"
                class="field-input short"
              />
              <SegmentedControl v-model="settings.unit" :options="units" />
            </div>
            <span v-if="settings.unit === 'frames' && !info.fps" class="field-hint"
              >Frame rate unknown — counted at 30 fps.</span
            >
          </SettingsField>
        </template>

        <template v-else>
          <SettingsField
            label-for="vid-overlap"
            unit="%"
            hint="How much of the view consecutive frames share. Higher = more, closer frames."
          >
            <template #label
              ><FieldHelp
                op="video-import"
                param="overlap"
                :value="settings.overlap"
                :default-value="VIDEO_IMPORT_DEFAULTS.overlap"
                >Overlap</FieldHelp
              ></template
            >
            <input
              id="vid-overlap"
              v-model.number="settings.overlap"
              :aria-invalid="numbers.bad.overlap"
              type="number"
              min="0"
              max="99"
              step="5"
              class="field-input short"
            />
          </SettingsField>
          <SettingsField label-for="vid-max" hint="The spacing widens until the frames fit.">
            <template #label
              ><FieldHelp
                op="video-import"
                param="maxFrames"
                :value="settings.maxFrames"
                :default-value="VIDEO_IMPORT_DEFAULTS.maxFrames"
                >Max frames</FieldHelp
              ></template
            >
            <input
              id="vid-max"
              v-model.number="settings.maxFrames"
              :aria-invalid="numbers.bad.maxFrames"
              type="number"
              min="2"
              max="5000"
              step="10"
              class="field-input short"
            />
          </SettingsField>
          <SettingsField
            label-for="vid-sharp"
            unit="× nearby median"
            hint="Frames less sharp than this are avoided; 0 keeps every frame eligible."
          >
            <template #label
              ><FieldHelp
                op="video-import"
                param="minSharpness"
                :value="settings.minSharpness"
                :default-value="VIDEO_IMPORT_DEFAULTS.minSharpness"
                >Blurry below</FieldHelp
              ></template
            >
            <input
              id="vid-sharp"
              v-model.number="settings.minSharpness"
              :aria-invalid="numbers.bad.minSharpness"
              type="number"
              min="0"
              max="1"
              step="0.05"
              class="field-input short"
            />
          </SettingsField>
        </template>
      </SettingsGroup>

      <div class="plan" data-testid="video-plan">
        <div class="plan-line">
          <span>{{ planLine }}</span>
          <button v-if="analysing" type="button" class="link-btn" @click="stopAnalysis">Stop scan</button>
          <button v-else-if="settings.mode === 'auto' && !samples" type="button" class="link-btn" @click="analyse">
            Scan video
          </button>
        </div>
        <div v-if="analysing" class="bar">
          <div class="bar-fill" :style="{ width: `${(100 * analysed.done) / Math.max(1, analysed.total)}%` }" />
        </div>
        <svg
          v-if="strip && !analysing"
          class="strip"
          :viewBox="`0 0 ${strip.W} ${strip.H}`"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <polyline v-if="strip.line" :points="strip.line" class="strip-line" />
          <circle v-for="(bx, i) in strip.blur" :key="`b${i}`" :cx="bx" :cy="strip.H - 3" r="1.6" class="strip-blur" />
          <line v-for="(tx, i) in strip.ticks" :key="`t${i}`" :x1="tx" :x2="tx" y1="0" y2="10" class="strip-tick" />
        </svg>
        <ul v-if="notes.length" class="notes">
          <li v-for="(n, i) in notes" :key="i">{{ n }}</li>
        </ul>
        <WarnBox v-if="analysisError">The scan stopped: {{ analysisError }}</WarnBox>
        <WarnBox v-if="tooMany">
          {{ times.length }} frames is a lot for one reconstruction in the browser. Consider a longer interval or the
          automatic mode.
        </WarnBox>
      </div>

      <AdvancedDisclosure label="Output">
        <SettingsField
          hint="JPEG at high quality is the usual choice; PNG keeps every pixel of the decoded frame but is several times larger."
        >
          <template #label><FieldHelp op="video-import" param="format">Format</FieldHelp></template>
          <SegmentedControl v-model="settings.format" :options="formats" />
        </SettingsField>
        <SettingsField v-if="settings.format === 'jpeg'" label-for="vid-q">
          <template #label
            ><FieldHelp
              op="video-import"
              param="jpegQuality"
              :value="settings.jpegQuality"
              :default-value="VIDEO_IMPORT_DEFAULTS.jpegQuality"
              >JPEG quality</FieldHelp
            ></template
          >
          <input
            id="vid-q"
            v-model.number="settings.jpegQuality"
            :aria-invalid="numbers.bad.jpegQuality"
            type="number"
            min="0.5"
            max="1"
            step="0.01"
            class="field-input short"
          />
        </SettingsField>
        <SettingsField label-for="vid-dim" unit="px" hint="Long side of the saved frames; 0 = the video's own size.">
          <template #label
            ><FieldHelp
              op="video-import"
              param="maxDim"
              :value="settings.maxDim"
              :default-value="VIDEO_IMPORT_DEFAULTS.maxDim"
              >Max size</FieldHelp
            ></template
          >
          <input
            id="vid-dim"
            v-model.number="settings.maxDim"
            :aria-invalid="numbers.bad.maxDim"
            type="number"
            min="0"
            max="16384"
            step="64"
            class="field-input short"
          />
        </SettingsField>
      </AdvancedDisclosure>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!canRun" :title="runTitle" @click="run">
        Extract {{ times.length || '' }} frame{{ times.length === 1 ? '' : 's' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.filename {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  word-break: break-all;
}
.input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.plan {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.plan-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
}
.link-btn {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.bar {
  height: 4px;
  border-radius: 2px;
  background: var(--panel-border);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.15s;
}
.strip {
  width: 100%;
  height: 44px;
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
}
.strip-line {
  fill: none;
  stroke: var(--text-dim);
  stroke-width: 1.2;
  vector-effect: non-scaling-stroke;
}
.strip-tick {
  stroke: var(--accent);
  stroke-width: 1.2;
  vector-effect: non-scaling-stroke;
}
.strip-blur {
  fill: var(--danger);
}
.notes {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--text-dim);
}
</style>
