<script setup>
import { ref, reactive, computed } from 'vue'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { buildBorderMask } from '../../../utils/maskCanvas.js'
import ImageThumb from '../../controls/ImageThumb.vue'
import ModalShell from '../ui/ModalShell.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import { maskGroups } from '../../../utils/maskGroups.js'
import FieldHelp from '../../guide/FieldHelp.vue'
import ExperimentalBadge from '../../layout/ExperimentalBadge.vue'
import { AUTO_MASK_DEFAULTS } from '../../../core/defaults.user.js'
import { isSureText } from '../../../core/ocr/textMask.js'
import { storedToLines } from '../../../core/ocr/textRun.js'
import { useLog } from '../../../composables/useLog.js'
import { useI18n } from '../../../composables/useI18n.js'
import { useTextMask } from '../../../composables/useTextMask.js'
import { useFrameMask } from '../../../composables/useFrameMask.js'
import { showToast } from '../../../composables/useToasts.js'

// Auto Mask: masks from a rule rather than a painted or imported file. Border excludes
// the outer N pixels on each side; Frame finds the film frame on each scan
// (composables/useFrameMask.js, core/maskFrame.js); Text finds and reads the
// text on the photos and masks it (composables/useTextMask.js, core/ocr/). Red regions
// are EXCLUDED from feature detection and the dense cloud, applied on the next detect
// or dense run. See core/mask.js for the mask convention.
const emit = defineEmits(['close'])

const imagesStore = useImagesStore()
const { updateMask } = imagesStore
const { log } = useLog()
const { t } = useI18n()
const textMask = useTextMask()
const frameMask = useFrameMask()

const rule = ref(AUTO_MASK_DEFAULTS.rule)
const rules = computed(() => [
  { id: 'border', label: t('autoMask.rule.border') },
  { id: 'frame', label: t('autoMask.rule.frame') },
  { id: 'text', label: t('autoMask.rule.text') },
])

const sides = reactive({
  top: AUTO_MASK_DEFAULTS.border,
  right: AUTO_MASK_DEFAULTS.border,
  bottom: AUTO_MASK_DEFAULTS.border,
  left: AUTO_MASK_DEFAULTS.border,
})
const linked = ref(AUTO_MASK_DEFAULTS.linked) // edit one side → fill all four
const existing = ref(AUTO_MASK_DEFAULTS.existing) // 'merge' | 'replace' for images that already have a mask
const textPad = ref(AUTO_MASK_DEFAULTS.textPad)
const textRecurring = ref(AUTO_MASK_DEFAULTS.textRecurring)
const frameInset = ref(AUTO_MASK_DEFAULTS.frameInset)
const borderBusy = ref(false)
const busy = computed(() => borderBusy.value || textMask.busy.value || frameMask.busy.value)
// The last text or frame run's summary line, until the next run.
const textResult = ref(null)
const frameResult = ref(null)

const SIDE_KEYS = ['top', 'right', 'bottom', 'left']

// The four margins as the help popup's "Current" value: one number while all sides
// agree, else each side (top, right, bottom, left).
const borderText = computed(() => {
  const v = SIDE_KEYS.map((k) => sides[k])
  return v.every((x) => x === v[0]) ? `${v[0]} ${t('autoMask.px')}` : `${v.join(' / ')} ${t('autoMask.px')}`
})
// A zero border excludes nothing: Replace then clears the masks (as erasing the last
// pixel does in the mask editor) rather than storing an empty PNG; Merge leaves them.
const noBorder = computed(() => SIDE_KEYS.every((k) => !sides[k]))

function onSideInput(key, e) {
  const v = Math.max(0, Math.round(Number(e.target.value) || 0))
  if (linked.value) for (const k of SIDE_KEYS) sides[k] = v
  else sides[key] = v
}

function onPadInput(e) {
  textPad.value = Math.max(0, Math.round(Number(e.target.value) || 0))
}

function onInsetInput(e) {
  const v = Number(e.target.value)
  frameInset.value = Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : 0
}

// Images by resolution, shared with the Mask Manager (utils/maskGroups.js) — a
// border in px needs concrete dimensions, so the 'unknown' group can't be applied to.
const grouping = computed(() => maskGroups(imagesStore.images))
const groupLabel = (g) => (g.w ? t('autoMask.group.size', { w: g.w, h: g.h }) : t('autoMask.group.unknown'))

// CSS inset (top/right/bottom/left %) for the preview overlay — the border as a
// fraction of each dimension, so the schematic tracks the real proportions.
function previewInset(g, m = sides) {
  if (!g.w || !g.h) return '0 0 0 0'
  const pct = (px, dim) => `${Math.min(100, (px / dim) * 100)}%`
  return `${pct(m.top, g.h)} ${pct(m.right, g.w)} ${pct(m.bottom, g.h)} ${pct(m.left, g.w)}`
}

// Frame rule: the frame found on a group's first photo (after a run), for the preview,
// and how many of its photos have one.
const frameOf = (g) => (g.images[0] ? frameMask.found.value.get(g.images[0].id) : null)
const framesFound = (g) =>
  g.images.filter((img) => {
    const m = frameMask.found.value.get(img.id)
    return m && SIDE_KEYS.some((k) => m[k] > 0)
  }).length

// Text rule: what was read in a group, and the sure text on its first photo for the
// preview (an SVG over the thumbnail in the photo's own pixels).
function groupText(g) {
  const read = g.images.filter((img) => imagesStore.hasPhotoText(img))
  const lines = read.reduce((n, img) => n + img.textLines.lines.length, 0)
  return { read: read.length, lines }
}
function previewPolys(g) {
  const img = g.images[0]
  if (!img || !imagesStore.hasPhotoText(img)) return []
  return storedToLines(img.textLines.lines)
    .filter(isSureText)
    .map((l) => l.quad.map(([x, y]) => `${x},${y}`).join(' '))
}

// Apply the border to every image of `groups` (sized groups only). A failure stops
// the run and says which image failed and how many were done before it; the masks
// already written stay.
async function applyBorder(groups) {
  const jobs = groups.filter((g) => g.w && g.h).flatMap((g) => g.images.map((img) => ({ img, g })))
  if (!jobs.length) return
  borderBusy.value = true
  const merge = existing.value === 'merge'
  let done = 0,
    current = null
  try {
    for (const { img, g } of jobs) {
      current = img
      if (noBorder.value) {
        if (!merge && img.mask) updateMask(img.id, null)
      } else {
        const base = merge && img.mask ? img.mask.blob : null
        updateMask(img.id, await buildBorderMask(g.w, g.h, { ...sides }, base))
      }
      done++
    }
    const sizes = SIDE_KEYS.map((k) => sides[k]).join('/')
    if (!noBorder.value) log(`Auto Mask: ${done} image(s), border ${sizes} px`, 'success', 'Images')
    else if (merge) log(`Auto Mask: ${done} image(s), nothing to add (zero border)`, 'success', 'Images')
    else log(`Auto Mask: ${done} image(s), masks cleared (zero border)`, 'success', 'Images')
  } catch (err) {
    const why = err?.message ?? String(err)
    log(
      `Auto Mask failed on ${current?.name ?? 'an image'} after ${done} of ${jobs.length} image(s): ${why}`,
      'error',
      'Images',
    )
    showToast(t('autoMask.failed.title'), {
      detail: t('autoMask.failed.detail', { done, total: jobs.length, name: current?.name ?? '?', why }),
      kind: 'error',
      ms: 6000,
    })
  } finally {
    borderBusy.value = false
  }
}

async function applyText(groups) {
  const images = groups.filter((g) => g.w && g.h).flatMap((g) => g.images)
  textResult.value = null
  try {
    const r = await textMask.maskText(images, {
      padPx: textPad.value,
      recurring: textRecurring.value,
      existing: existing.value,
    })
    if (r && !r.declined && !r.cancelled) textResult.value = t('autoMask.text.done', r)
  } catch (err) {
    const why = err?.message ?? String(err)
    log(`Auto Mask ▸ Text failed: ${why}`, 'error', 'Images')
    showToast(t('autoMask.failed.title'), { detail: why, kind: 'error', ms: 6000 })
  }
}

async function applyFrame(groups) {
  frameResult.value = null
  try {
    const r = await frameMask.maskFrame(groups, { insetPct: frameInset.value, existing: existing.value })
    if (r && !r.cancelled) frameResult.value = t('autoMask.frame.done', r)
  } catch (err) {
    const why = err?.message ?? String(err)
    log(`Auto Mask ▸ Frame failed: ${why}`, 'error', 'Images')
    showToast(t('autoMask.failed.title'), { detail: why, kind: 'error', ms: 6000 })
  }
}

function applyToGroups(groups) {
  if (busy.value) return
  if (rule.value === 'text') return applyText(groups)
  if (rule.value === 'frame') return applyFrame(groups)
  return applyBorder(groups)
}
const applyToGroup = (g) => applyToGroups([g])
const applyToAll = () => applyToGroups(grouping.value.sizedGroups)

const progressText = computed(() => {
  if (frameMask.progress.value) return t('autoMask.frame.progress', frameMask.progress.value)
  const p = textMask.progress.value
  if (!p) return ''
  return t(p.phase === 'read' ? 'autoMask.text.reading' : 'autoMask.text.masking', p)
})
const allReason = computed(() =>
  busy.value ? t('autoMask.disabled.busy') : !grouping.value.sizedGroups.length ? t('autoMask.disabled.noSizes') : null,
)
const groupReason = (g) => (busy.value ? t('autoMask.disabled.busy') : g.w ? null : t('autoMask.disabled.unknownSize'))
</script>

<template>
  <!-- Flush: the rule controls and sub-bar stay put while the group list scrolls. -->
  <ModalShell class="auto-mask" :title="t('autoMask.title')" width="620px" flush :scroll="false" @close="emit('close')">
    <div class="controls">
      <div class="rule-row">
        <span class="opt-label">{{ t('autoMask.rule.label') }}</span>
        <SegmentedControl v-model="rule" :options="rules" />
      </div>

      <template v-if="rule === 'border'">
        <div class="section-title">
          <FieldHelp op="masks" param="border" :value="borderText" :default-value="`${AUTO_MASK_DEFAULTS.border} px`">{{
            t('autoMask.border.title')
          }}</FieldHelp>
          {{ t('autoMask.border.hint') }}
        </div>
        <div class="sides">
          <label v-for="k in SIDE_KEYS" :key="k" class="side">
            <span class="side-label">{{ t(`autoMask.border.side.${k}`) }}</span>
            <input class="num" type="number" min="0" step="1" :value="sides[k]" @input="onSideInput(k, $event)" />
            <span class="unit">{{ t('autoMask.px') }}</span>
          </label>
        </div>
      </template>

      <template v-else-if="rule === 'frame'">
        <div class="section-title">
          {{ t('autoMask.frame.title') }}
          {{ t('autoMask.frame.hint') }}
        </div>
        <div class="sides">
          <label class="side">
            <FieldHelp
              op="masks"
              param="frameInset"
              :value="frameInset"
              :default-value="AUTO_MASK_DEFAULTS.frameInset"
              >{{ t('autoMask.frame.inset') }}</FieldHelp
            >
            <input class="num" type="number" min="0" max="10" step="0.1" :value="frameInset" @input="onInsetInput" />
            <span class="unit">{{ t('autoMask.frame.insetUnit') }}</span>
          </label>
        </div>
        <div class="about">{{ t('autoMask.frame.about') }}</div>
      </template>

      <template v-else>
        <div class="section-title">
          {{ t('autoMask.text.title') }}
          {{ t('autoMask.text.hint') }}
          <ExperimentalBadge id="textMask" />
        </div>
        <div class="sides">
          <label class="side">
            <FieldHelp op="masks" param="textPad" :value="textPad" :default-value="AUTO_MASK_DEFAULTS.textPad">{{
              t('autoMask.text.pad')
            }}</FieldHelp>
            <input class="num" type="number" min="0" step="1" :value="textPad" @input="onPadInput" />
            <span class="unit">{{ t('autoMask.px') }}</span>
          </label>
          <label class="opt">
            <input v-model="textRecurring" type="checkbox" />
            <FieldHelp
              op="masks"
              param="textRecurring"
              :value="textRecurring"
              :default-value="AUTO_MASK_DEFAULTS.textRecurring"
              >{{ t('autoMask.text.recurring') }}</FieldHelp
            >
          </label>
        </div>
        <div class="about">{{ t('autoMask.text.about') }}</div>
      </template>

      <div class="opts">
        <label v-if="rule === 'border'" class="opt"
          ><input v-model="linked" type="checkbox" />
          <FieldHelp op="masks" param="linked" :value="linked" :default-value="AUTO_MASK_DEFAULTS.linked">{{
            t('autoMask.border.linked')
          }}</FieldHelp></label
        >
        <span v-if="rule === 'border'" class="sep">·</span>
        <span class="opt-label"
          ><FieldHelp op="masks" param="existing">{{ t('autoMask.existing.label') }}</FieldHelp
          >:</span
        >
        <label class="opt"
          ><input v-model="existing" type="radio" value="merge" /> {{ t('autoMask.existing.merge') }}</label
        >
        <label class="opt"
          ><input v-model="existing" type="radio" value="replace" /> {{ t('autoMask.existing.replace') }}</label
        >
      </div>
    </div>

    <div class="subbar">
      <button class="btn" :disabled="!!allReason" :title="allReason" @click="applyToAll">
        {{ t('autoMask.applyAll') }}
      </button>
      <template v-if="textMask.busy.value || frameMask.busy.value">
        <span class="hint progress">{{ progressText }}</span>
        <button class="btn ghost sm" @click="() => (frameMask.busy.value ? frameMask.cancel() : textMask.cancel())">
          {{ t('autoMask.cancel') }}
        </button>
      </template>
      <span v-else-if="rule === 'text' && textResult" class="hint">{{ textResult }}</span>
      <span v-else-if="rule === 'frame' && frameResult" class="hint">{{ frameResult }}</span>
      <span v-else class="hint">{{
        t('autoMask.hint', { masked: grouping.maskedCount, n: imagesStore.images.length })
      }}</span>
    </div>

    <div class="list">
      <div v-if="!imagesStore.images.length" class="empty">{{ t('autoMask.empty') }}</div>

      <div v-for="g in grouping.groups" :key="g.key" class="group">
        <div class="preview" :title="groupLabel(g)">
          <ImageThumb v-if="g.images[0]" class="thumb" :image="g.images[0]" :alt="groupLabel(g)" />
          <div v-if="g.w && rule === 'border'" class="border-overlay" :style="{ inset: previewInset(g) }"></div>
          <div
            v-if="g.w && rule === 'frame' && frameOf(g)"
            class="border-overlay"
            :style="{ inset: previewInset(g, frameOf(g)) }"
          ></div>
          <svg
            v-if="g.w && rule === 'text'"
            class="text-overlay"
            :viewBox="`0 0 ${g.w} ${g.h}`"
            preserveAspectRatio="xMidYMid slice"
          >
            <polygon v-for="(pts, i) in previewPolys(g)" :key="i" :points="pts" />
          </svg>
        </div>
        <div class="group-info">
          <span class="group-title">{{ groupLabel(g) }}</span>
          <span class="group-count">{{ t('autoMask.group.count', { n: g.images.length }) }}</span>
          <span
            v-if="rule === 'frame' && g.images.some((img) => frameMask.found.value.has(img.id))"
            class="group-count"
            >{{ t('autoMask.frame.groupFound', { found: framesFound(g), n: g.images.length }) }}</span
          >
          <span v-if="rule === 'text'" class="group-count">{{
            groupText(g).read
              ? t('autoMask.text.groupRead', { ...groupText(g), n: g.images.length })
              : t('autoMask.text.groupUnread')
          }}</span>
        </div>
        <button class="btn sm" :disabled="!!groupReason(g)" :title="groupReason(g)" @click="applyToGroup(g)">
          {{ t('autoMask.applyGroup') }}
        </button>
      </div>
    </div>
  </ModalShell>
</template>

<style scoped>
.controls {
  padding: 12px 16px;
  border-bottom: 1px solid var(--panel-border);
  flex-shrink: 0;
}
.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}
.sides {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text);
}
.side {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.side-label {
  font-size: 12px;
  color: var(--text-dim);
  text-transform: capitalize;
  width: 42px;
}
.num {
  width: 60px;
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 3px 5px;
  outline: none;
}
.num:focus {
  border-color: var(--accent);
}
.num[type='number'] {
  -moz-appearance: textfield;
  appearance: textfield;
}
.num[type='number']::-webkit-outer-spin-button,
.num[type='number']::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.unit {
  font-size: 11px;
  color: var(--text-dim);
}

.opts {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--text);
}
.opt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.opt input {
  accent-color: var(--accent);
}
.opt-label {
  color: var(--text-dim);
}
.sep {
  color: var(--text-dim);
}

.rule-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 12px;
}
.about {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-dim);
}
.progress {
  font-variant-numeric: tabular-nums;
}
.subbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--panel-border);
  flex-shrink: 0;
}
.hint {
  font-size: 11px;
  color: var(--text-dim);
}

.list {
  flex: 1;
  overflow: auto;
  min-height: 0;
  background: var(--bg);
}
.empty {
  padding: 40px;
  text-align: center;
  color: var(--text-dim);
}

.group {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--panel-border);
}
.preview {
  position: relative;
  width: 72px;
  height: 54px;
  flex-shrink: 0;
  background: #000;
  border-radius: 3px;
  overflow: hidden;
}
.thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/* `inset` places this over the *interior* (kept) rectangle; the large spread
   box-shadow then washes everything outside it red, clipped to the preview's
   overflow:hidden — so the highlighted area is exactly the excluded border. */
.text-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.text-overlay polygon {
  fill: rgba(255, 60, 60, 0.45);
  stroke: rgba(255, 80, 80, 0.9);
  stroke-width: 1px;
  vector-effect: non-scaling-stroke;
}
.border-overlay {
  position: absolute;
  background: transparent;
  box-shadow: 0 0 0 9999px rgba(255, 60, 60, 0.45);
  outline: 1px solid rgba(255, 80, 80, 0.7);
  pointer-events: none;
}
.group-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.group-count {
  font-size: 11px;
  color: var(--text-dim);
}

.btn {
  white-space: nowrap;
  flex-shrink: 0;
  background: var(--accent);
  border: none;
  color: #fff;
  font: inherit;
  font-size: 12px;
  padding: 5px 11px;
  border-radius: 5px;
  cursor: pointer;
}
.btn.ghost {
  background: transparent;
  border: 1px solid var(--panel-border);
  color: var(--text);
}
.btn.sm {
  font-size: 11px;
  padding: 4px 9px;
}
.btn:hover:not(:disabled) {
  filter: brightness(1.1);
}
.btn:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
