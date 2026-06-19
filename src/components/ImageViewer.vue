<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  image: { type: Object, required: true },
})

const container = ref(null)
const imgEl = ref(null)

const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const dragging = ref(false)

// Status bar: pixel under cursor, null when outside image
const hoverPx = ref(null)

let startX = 0
let startY = 0
let startTx = 0
let startTy = 0
let resizeObserver = null
let offscreenCtx = null

const MIN_SCALE = 0.05
const MAX_SCALE = 40

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

function fit() {
  const c = container.value
  const img = imgEl.value
  if (!c || !img || !img.naturalWidth) return
  const cw = c.clientWidth
  const ch = c.clientHeight
  const s = Math.min(cw / img.naturalWidth, ch / img.naturalHeight, 1)
  scale.value = s
  tx.value = (cw - img.naturalWidth * s) / 2
  ty.value = (ch - img.naturalHeight * s) / 2
}

function onWheel(e) {
  e.preventDefault()
  const rect = container.value.getBoundingClientRect()
  const cx = e.clientX - rect.left
  const cy = e.clientY - rect.top
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
  const newScale = clamp(scale.value * factor, MIN_SCALE, MAX_SCALE)
  const ratio = newScale / scale.value
  // Keep the point under the cursor fixed while zooming.
  tx.value = cx - (cx - tx.value) * ratio
  ty.value = cy - (cy - ty.value) * ratio
  scale.value = newScale
}

function onMouseDown(e) {
  dragging.value = true
  startX = e.clientX
  startY = e.clientY
  startTx = tx.value
  startTy = ty.value
}

function onMouseMove(e) {
  if (dragging.value) {
    tx.value = startTx + (e.clientX - startX)
    ty.value = startTy + (e.clientY - startY)
  }

  const rect = container.value.getBoundingClientRect()
  const cx = e.clientX - rect.left
  const cy = e.clientY - rect.top
  const px = Math.floor((cx - tx.value) / scale.value)
  const py = Math.floor((cy - ty.value) / scale.value)
  const img = imgEl.value

  if (img && px >= 0 && py >= 0 && px < img.naturalWidth && py < img.naturalHeight) {
    const info = { x: px, y: py, r: null, g: null, b: null }
    if (offscreenCtx) {
      const d = offscreenCtx.getImageData(px, py, 1, 1).data
      info.r = d[0]; info.g = d[1]; info.b = d[2]
    }
    hoverPx.value = info
  } else {
    hoverPx.value = null
  }
}

function stopDrag() {
  dragging.value = false
}

function onMouseLeave() {
  dragging.value = false
  hoverPx.value = null
}

function setupOffscreenCanvas() {
  const img = imgEl.value
  if (!img || !img.naturalWidth) return
  try {
    const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
    offscreenCtx = canvas.getContext('2d')
    offscreenCtx.drawImage(img, 0, 0)
  } catch {
    offscreenCtx = null
  }
}

function applyZoom(factor) {
  const c = container.value
  if (!c) return
  const cx = c.clientWidth / 2
  const cy = c.clientHeight / 2
  const newScale = clamp(scale.value * factor, MIN_SCALE, MAX_SCALE)
  const ratio = newScale / scale.value
  tx.value = cx - (cx - tx.value) * ratio
  ty.value = cy - (cy - ty.value) * ratio
  scale.value = newScale
}

function zoomIn() { applyZoom(1.5) }
function zoomOut() { applyZoom(1 / 1.5) }

function onImgLoad() {
  fit()
  setupOffscreenCanvas()
}

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    if (!dragging.value) fit()
  })
  if (container.value) resizeObserver.observe(container.value)
})

onBeforeUnmount(() => resizeObserver?.disconnect())

defineExpose({ fit, zoomIn, zoomOut })
</script>

<template>
  <div class="image-viewer">
    <div
      ref="container"
      class="viewport"
      :class="{ grabbing: dragging }"
      @wheel="onWheel"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="stopDrag"
      @mouseleave="onMouseLeave"
      @dblclick="fit"
    >
      <img
        ref="imgEl"
        :src="image.url"
        :alt="image.name"
        class="image"
        :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
        draggable="false"
        @load="onImgLoad"
      />

      <div class="hud">
        <span>{{ Math.round(scale * 100) }}%</span>
        <button title="Fit to view" @click.stop="fit">Fit</button>
      </div>
    </div>

    <div class="status-bar">
      <template v-if="hoverPx">
        <span class="coord">X&nbsp;{{ hoverPx.x }}</span>
        <span class="sep">|</span>
        <span class="coord">Y&nbsp;{{ hoverPx.y }}</span>
        <template v-if="hoverPx.r !== null">
          <span class="sep">|</span>
          <span
            class="swatch"
            :style="{ background: `rgb(${hoverPx.r},${hoverPx.g},${hoverPx.b})` }"
          ></span>
          <span class="channel r">R&nbsp;{{ hoverPx.r }}</span>
          <span class="channel g">G&nbsp;{{ hoverPx.g }}</span>
          <span class="channel b">B&nbsp;{{ hoverPx.b }}</span>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.image-viewer {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  user-select: none;
}

.viewport {
  position: relative;
  flex: 1;
  overflow: hidden;
  cursor: grab;
}

.viewport.grabbing {
  cursor: grabbing;
}

.image {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  image-rendering: auto;
  will-change: transform;
}

.hud {
  position: absolute;
  bottom: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
}

.hud button {
  background: none;
  border: 1px solid var(--panel-border);
  color: var(--text);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.hud button:hover {
  background: var(--hover-bg);
}

/* Status bar */
.status-bar {
  flex-shrink: 0;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  font-size: 11px;
  font-family: ui-monospace, 'Cascadia Code', 'Fira Mono', monospace;
  color: var(--text);
  background: var(--panel);
  border-top: 1px solid var(--panel-border);
}

.coord {
  color: var(--text, #ccc);
  letter-spacing: 0.02em;
}

.sep {
  color: var(--panel-border, #444);
}

.swatch {
  display: inline-block;
  width: 11px;
  height: 11px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  flex-shrink: 0;
}

.channel {
  letter-spacing: 0.02em;
}

.channel.r { color: #e07070; }
.channel.g { color: #70c070; }
.channel.b { color: #6090e0; }
</style>
