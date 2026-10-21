<script setup>
import { ref, reactive, computed } from 'vue'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { buildBorderMask } from '../../../core/mask.js'
import ImageThumb from '../../controls/ImageThumb.vue'
import ModalShell from '../ui/ModalShell.vue'
import { maskGroups } from '../../../utils/maskGroups.js'
import FieldHelp from '../../guide/FieldHelp.vue'
import { AUTO_MASK_DEFAULTS } from '../../../core/defaults.user.js'
import { useLog } from '../../../composables/useLog.js'
import { showToast } from '../../../composables/useToasts.js'

// Auto-Mask: generate masks from a rule rather than a painted/imported file.
// v1 has a single strategy — exclude the outer N pixels on each side (the film
// border / fiducial frame on scanned imagery). Built to grow: more strategies
// (frame detection, colour key) can slot in beside the border controls. Red
// regions are EXCLUDED from feature detection and the dense cloud, applied on the
// next detect/dense run. See core/mask.js for the mask convention.
const emit = defineEmits(['close'])

const imagesStore = useImagesStore()
const { updateMask } = imagesStore
const { log } = useLog()

const sides = reactive({
  top: AUTO_MASK_DEFAULTS.border,
  right: AUTO_MASK_DEFAULTS.border,
  bottom: AUTO_MASK_DEFAULTS.border,
  left: AUTO_MASK_DEFAULTS.border,
})
const linked = ref(AUTO_MASK_DEFAULTS.linked) // edit one side → fill all four
const existing = ref(AUTO_MASK_DEFAULTS.existing) // 'merge' | 'replace' for images that already have a mask
const busy = ref(false)

const SIDE_KEYS = ['top', 'right', 'bottom', 'left']

// The four margins as the help popup's "Current" value: one number while all sides
// agree, else each side (top, right, bottom, left).
const borderText = computed(() => {
  const v = SIDE_KEYS.map((k) => sides[k])
  return v.every((x) => x === v[0]) ? `${v[0]} px` : `${v.join(' / ')} px`
})
// A zero border excludes nothing: Replace then clears the masks (as erasing the last
// pixel does in the mask editor) rather than storing an empty PNG; Merge leaves them.
const noBorder = computed(() => SIDE_KEYS.every((k) => !sides[k]))

function onSideInput(key, e) {
  const v = Math.max(0, Math.round(Number(e.target.value) || 0))
  if (linked.value) for (const k of SIDE_KEYS) sides[k] = v
  else sides[key] = v
}

// Images by resolution, shared with the Mask Manager (utils/maskGroups.js) — a
// border in px needs concrete dimensions, so the 'unknown' group can't be applied to.
const grouping = computed(() => maskGroups(imagesStore.images))

// CSS inset (top/right/bottom/left %) for the preview overlay — the border as a
// fraction of each dimension, so the schematic tracks the real proportions.
function previewInset(g) {
  if (!g.w || !g.h) return '0 0 0 0'
  const pct = (px, dim) => `${Math.min(100, (px / dim) * 100)}%`
  return `${pct(sides.top, g.h)} ${pct(sides.right, g.w)} ${pct(sides.bottom, g.h)} ${pct(sides.left, g.w)}`
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// Apply the border to every image of `groups` (sized groups only). A failure stops
// the run and says which image failed and how many were done before it; the masks
// already written stay.
async function applyToGroups(groups) {
  if (busy.value) return
  const jobs = groups.filter((g) => g.w && g.h).flatMap((g) => g.images.map((img) => ({ img, g })))
  if (!jobs.length) return
  busy.value = true
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
    const what = noBorder.value
      ? merge
        ? 'nothing to add (zero border)'
        : 'masks cleared (zero border)'
      : `border ${borderText.value}`
    log(`Auto Mask: ${plural(done, 'image')}, ${what}`, 'success', 'Images')
  } catch (err) {
    const why = err?.message ?? String(err)
    log(
      `Auto Mask failed on ${current?.name ?? 'an image'} after ${done} of ${plural(jobs.length, 'image')}: ${why}`,
      'error',
      'Images',
    )
    showToast('Auto Mask failed', {
      detail: `${done} of ${plural(jobs.length, 'image')} masked before ${current?.name ?? 'an image'} failed: ${why}`,
      kind: 'error',
      ms: 6000,
    })
  } finally {
    busy.value = false
  }
}

const applyToGroup = (g) => applyToGroups([g])
const applyToAll = () => applyToGroups(grouping.value.sizedGroups)
</script>

<template>
  <!-- Flush: the strategy controls and sub-bar stay put while the group list scrolls. -->
  <ModalShell class="auto-mask" title="Auto Mask" width="620px" flush :scroll="false" @close="emit('close')">
    <!-- Strategy controls. v1 = border only; future strategies add sections here. -->
    <div class="controls">
      <div class="section-title">
        <FieldHelp op="masks" param="border" :value="borderText" :default-value="`${AUTO_MASK_DEFAULTS.border} px`"
          >Mask border</FieldHelp
        >
        (exclude outer pixels)
      </div>
      <div class="sides">
        <label v-for="k in SIDE_KEYS" :key="k" class="side">
          <span class="side-label">{{ k }}</span>
          <input class="num" type="number" min="0" step="1" :value="sides[k]" @input="onSideInput(k, $event)" />
          <span class="unit">px</span>
        </label>
      </div>
      <div class="opts">
        <label class="opt"
          ><input v-model="linked" type="checkbox" />
          <FieldHelp op="masks" param="linked" :value="linked" :default-value="AUTO_MASK_DEFAULTS.linked"
            >Link all sides</FieldHelp
          ></label
        >
        <span class="sep">·</span>
        <span class="opt-label"><FieldHelp op="masks" param="existing">If a mask exists</FieldHelp>:</span>
        <label class="opt"><input v-model="existing" type="radio" value="merge" /> Merge</label>
        <label class="opt"><input v-model="existing" type="radio" value="replace" /> Replace</label>
      </div>
    </div>

    <div class="subbar">
      <button class="btn" :disabled="busy || !grouping.sizedGroups.length" @click="applyToAll">
        Apply to all groups
      </button>
      <span class="hint">{{ grouping.hint }}</span>
    </div>

    <div class="list">
      <div v-if="!imagesStore.images.length" class="empty">No images.</div>

      <div v-for="g in grouping.groups" :key="g.key" class="group">
        <div class="preview" :title="g.label">
          <ImageThumb v-if="g.images[0]" class="thumb" :image="g.images[0]" :alt="g.label" />
          <div v-if="g.w" class="border-overlay" :style="{ inset: previewInset(g) }"></div>
        </div>
        <div class="group-info">
          <span class="group-title">{{ g.label }}</span>
          <span class="group-count">{{ g.images.length }} image{{ g.images.length !== 1 ? 's' : '' }}</span>
        </div>
        <button
          class="btn sm"
          :disabled="busy || !g.w"
          :title="g.w ? '' : 'Unknown size — open an image to draw a mask manually'"
          @click="applyToGroup(g)"
        >
          Apply to group
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
  gap: 14px;
  flex-wrap: wrap;
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
  background: var(--accent);
  border: none;
  color: #fff;
  font: inherit;
  font-size: 12px;
  padding: 5px 11px;
  border-radius: 5px;
  cursor: pointer;
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
