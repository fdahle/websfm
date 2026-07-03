<script setup>
import { ref, reactive, computed } from 'vue'
import { useImagesStore } from '../../stores/useImagesStore.js'
import { buildBorderMask } from '../../core/mask.js'

// Auto-Mask: generate masks from a rule rather than a painted/imported file.
// v1 has a single strategy — exclude the outer N pixels on each side (the film
// border / fiducial frame on scanned imagery). Built to grow: more strategies
// (frame detection, colour key) can slot in beside the border controls. Red
// regions are EXCLUDED from feature detection and the dense cloud, applied on the
// next detect/dense run. See core/mask.js for the mask convention.
const emit = defineEmits(['close'])

const imagesStore = useImagesStore()
const { updateMask } = imagesStore

const sides = reactive({ top: 40, right: 40, bottom: 40, left: 40 })
const linked = ref(true)              // edit one side → fill all four
const existing = ref('merge')         // 'merge' | 'replace' for images that already have a mask
const busy = ref(false)

const SIDE_KEYS = ['top', 'right', 'bottom', 'left']

function onSideInput(key, e) {
  const v = Math.max(0, Math.round(Number(e.target.value) || 0))
  if (linked.value) for (const k of SIDE_KEYS) sides[k] = v
  else sides[key] = v
}

// Group images by "width×height"; images without known dims fall into 'unknown'
// (mirrors the Mask Manager — a border in px needs concrete dimensions).
const groups = computed(() => {
  const map = new Map()
  for (const img of imagesStore.images) {
    const w = img.meta?.width, h = img.meta?.height
    const key = w && h ? `${w}×${h}` : 'unknown'
    if (!map.has(key)) map.set(key, { key, w: w || null, h: h || null, label: w && h ? `${w} × ${h}` : 'Unknown size', images: [] })
    map.get(key).images.push(img)
  }
  return [...map.values()]
})
const sizedGroups = computed(() => groups.value.filter((g) => g.w && g.h))
const maskedCount = computed(() => imagesStore.images.filter((i) => i.mask).length)

// CSS inset (top/right/bottom/left %) for the preview overlay — the border as a
// fraction of each dimension, so the schematic tracks the real proportions.
function previewInset(g) {
  if (!g.w || !g.h) return '0 0 0 0'
  const pct = (px, dim) => `${Math.min(100, (px / dim) * 100)}%`
  return `${pct(sides.top, g.h)} ${pct(sides.right, g.w)} ${pct(sides.bottom, g.h)} ${pct(sides.left, g.w)}`
}

async function applyToGroup(g) {
  if (!g.w || !g.h || busy.value) return
  busy.value = true
  try {
    for (const img of g.images) {
      const base = existing.value === 'merge' && img.mask ? img.mask : null
      updateMask(img.id, await buildBorderMask(g.w, g.h, { ...sides }, base))
    }
  } finally { busy.value = false }
}

async function applyToAll() {
  if (busy.value) return
  busy.value = true
  try {
    for (const g of sizedGroups.value) {
      for (const img of g.images) {
        const base = existing.value === 'merge' && img.mask ? img.mask : null
        updateMask(img.id, await buildBorderMask(g.w, g.h, { ...sides }, base))
      }
    }
  } finally { busy.value = false }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Auto Mask">
      <div class="modal-header">
        <span class="modal-title">Auto Mask</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <!-- Strategy controls. v1 = border only; future strategies add sections here. -->
      <div class="controls">
        <div class="section-title">Mask border (exclude outer pixels)</div>
        <div class="sides">
          <label v-for="k in SIDE_KEYS" :key="k" class="side">
            <span class="side-label">{{ k }}</span>
            <input
              class="num"
              type="number"
              min="0"
              step="1"
              :value="sides[k]"
              @input="onSideInput(k, $event)"
            />
            <span class="unit">px</span>
          </label>
        </div>
        <div class="opts">
          <label class="opt"><input v-model="linked" type="checkbox" /> Link all sides</label>
          <span class="sep">·</span>
          <span class="opt-label">If a mask exists:</span>
          <label class="opt"><input v-model="existing" type="radio" value="merge" /> Merge</label>
          <label class="opt"><input v-model="existing" type="radio" value="replace" /> Replace</label>
        </div>
      </div>

      <div class="subbar">
        <button class="btn" :disabled="busy || !sizedGroups.length" @click="applyToAll">Apply to all groups</button>
        <span class="hint">
          {{ maskedCount }} of {{ imagesStore.images.length }} masked.
          Red regions are excluded from feature detection and the dense cloud — applied on the next detect/dense run.
        </span>
      </div>

      <div class="modal-body">
        <div v-if="!imagesStore.images.length" class="empty">No images.</div>

        <div v-for="g in groups" :key="g.key" class="group">
          <div class="preview" :title="g.label">
            <img v-if="g.images[0]" class="thumb" :src="g.images[0].url" :alt="g.label" />
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
          >Apply to group</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; z-index: 200;
}
.modal {
  background: var(--panel); border: 1px solid var(--panel-border); border-radius: 8px;
  width: min(92vw, 620px); max-height: 80vh;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4); display: flex; flex-direction: column;
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 16px; border-bottom: 1px solid var(--panel-border); flex-shrink: 0;
}
.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }
.modal-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 1px 6px; border-radius: 4px;
}
.modal-close:hover { background: var(--hover-bg); color: var(--text); }

.controls { padding: 12px 16px; border-bottom: 1px solid var(--panel-border); flex-shrink: 0; }
.section-title { font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
.sides { display: flex; gap: 14px; flex-wrap: wrap; }
.side { display: inline-flex; align-items: center; gap: 5px; }
.side-label { font-size: 12px; color: var(--text-dim); text-transform: capitalize; width: 42px; }
.num {
  width: 60px; background: var(--bg); border: 1px solid var(--panel-border); border-radius: 4px;
  color: var(--text); font: inherit; font-size: 12px; padding: 3px 5px; outline: none;
}
.num:focus { border-color: var(--accent); }
.num[type='number'] { -moz-appearance: textfield; appearance: textfield; }
.num[type='number']::-webkit-outer-spin-button,
.num[type='number']::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.unit { font-size: 11px; color: var(--text-dim); }

.opts { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 12px; color: var(--text); }
.opt { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.opt input { accent-color: var(--accent); }
.opt-label { color: var(--text-dim); }
.sep { color: var(--text-dim); }

.subbar {
  display: flex; align-items: center; gap: 14px;
  padding: 8px 16px; border-bottom: 1px solid var(--panel-border); flex-shrink: 0;
}
.hint { font-size: 11px; color: var(--text-dim); }

.modal-body { flex: 1; overflow: auto; min-height: 0; background: var(--bg); }
.empty { padding: 40px; text-align: center; color: var(--text-dim); }

.group {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 16px; border-bottom: 1px solid var(--panel-border);
}
.preview { position: relative; width: 72px; height: 54px; flex-shrink: 0; background: #000; border-radius: 3px; overflow: hidden; }
.thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
/* `inset` places this over the *interior* (kept) rectangle; the large spread
   box-shadow then washes everything outside it red, clipped to the preview's
   overflow:hidden — so the highlighted area is exactly the excluded border. */
.border-overlay {
  position: absolute; background: transparent;
  box-shadow: 0 0 0 9999px rgba(255, 60, 60, 0.45);
  outline: 1px solid rgba(255, 80, 80, 0.7);
  pointer-events: none;
}
.group-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.group-title { font-size: 13px; font-weight: 600; color: var(--text); }
.group-count { font-size: 11px; color: var(--text-dim); }

.btn {
  background: var(--accent); border: none; color: #fff; font: inherit; font-size: 12px;
  padding: 5px 11px; border-radius: 5px; cursor: pointer;
}
.btn.sm { font-size: 11px; padding: 4px 9px; }
.btn:hover:not(:disabled) { filter: brightness(1.1); }
.btn:disabled { opacity: 0.4; cursor: default; }
</style>
