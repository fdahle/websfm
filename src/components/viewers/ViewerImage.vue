<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { maskFromSource } from '../../core/mask.js'

const props = defineProps({
  image:         { type: Object,  required: true },
  showKeypoints: { type: Boolean, default: false },
  showMask:      { type: Boolean, default: false },
  showDepth:     { type: Boolean, default: false },
  showGcps:      { type: Boolean, default: false },
  gcps:          { type: Array,   default: () => [] }, // [{ name, px, py }] observations on this image
  maskMode:      { type: String,  default: 'none' }, // 'none' | 'draw' | 'erase'
  brushRadius:   { type: Number,  default: 20 },     // screen pixels
})

const emit = defineEmits(['update-mask', 'update-depth'])

const container      = ref(null)
const imgEl          = ref(null)
const overlayCanvas  = ref(null)
const maskFileInput  = ref(null)
const depthFileInput = ref(null)

// Pan/zoom
const scale    = ref(1)
const tx       = ref(0)
const ty       = ref(0)
const dragging = ref(false)
const hoverPx  = ref(null)

// Mask canvas state
const hasMask = ref(!!props.image.mask)

let maskOffscreen  = null  // OffscreenCanvas at native image resolution
let depthOffscreen = null  // OffscreenCanvas holding colorized depth at native resolution
const hasDepth = ref(!!props.image.depth)
let mousePos      = null  // { x, y } screen coords for brush cursor
let isDrawing     = false
let startX = 0, startY = 0, startTx = 0, startTy = 0
let resizeObserver = null
let offscreenCtx   = null

const MIN_SCALE = 0.05
const MAX_SCALE = 40

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }

// ── Fit & zoom ───────────────────────────────────────────────────────────────

function fit() {
  const c   = container.value
  const img = imgEl.value
  if (!c || !img || !img.naturalWidth) return
  const s = Math.min(c.clientWidth / img.naturalWidth, c.clientHeight / img.naturalHeight, 1)
  scale.value = s
  tx.value = (c.clientWidth  - img.naturalWidth  * s) / 2
  ty.value = (c.clientHeight - img.naturalHeight * s) / 2
  drawOverlay()
}

function applyZoom(factor) {
  const c = container.value
  if (!c) return
  const cx = c.clientWidth  / 2
  const cy = c.clientHeight / 2
  const newScale = clamp(scale.value * factor, MIN_SCALE, MAX_SCALE)
  const ratio = newScale / scale.value
  tx.value = cx - (cx - tx.value) * ratio
  ty.value = cy - (cy - ty.value) * ratio
  scale.value = newScale
  drawOverlay()
}

function zoomIn()  { applyZoom(1.5) }
function zoomOut() { applyZoom(1 / 1.5) }

// ── Overlay canvas (mask + keypoints + brush cursor) ─────────────────────────

function drawOverlay() {
  const c   = overlayCanvas.value
  const img = imgEl.value
  if (!c || !img || !img.naturalWidth || !container.value) return

  const w = container.value.clientWidth
  const h = container.value.clientHeight
  if (!w || !h) return

  const dpr = window.devicePixelRatio || 1
  const pw  = Math.round(w * dpr)
  const ph  = Math.round(h * dpr)
  if (c.width !== pw || c.height !== ph) {
    c.width  = pw
    c.height = ph
    c.style.width  = `${w}px`
    c.style.height = `${h}px`
  }

  const ctx = c.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const dispW = img.naturalWidth  * scale.value
  const dispH = img.naturalHeight * scale.value

  // Depth — colorized semi-transparent overlay at image position
  if (depthOffscreen && hasDepth.value && props.showDepth) {
    ctx.save()
    ctx.globalAlpha = 0.6
    ctx.drawImage(depthOffscreen, tx.value, ty.value, dispW, dispH)
    ctx.restore()
  }

  // Mask — red semi-transparent overlay at image position
  if (maskOffscreen && hasMask.value && props.showMask) {
    ctx.save()
    ctx.globalAlpha = 0.45
    ctx.drawImage(maskOffscreen, tx.value, ty.value, dispW, dispH)
    ctx.restore()
  }

  // Keypoints — colour-coded dots (cold=blue → hot=red by SIFT response)
  if (props.showKeypoints && props.image.keypoints?.length) {
    const kps = props.image.keypoints
    let minR = Infinity, maxR = -Infinity
    for (const kp of kps) {
      if (kp.response < minR) minR = kp.response
      if (kp.response > maxR) maxR = kp.response
    }
    const range = maxR - minR || 1
    for (const kp of kps) {
      const x = kp.nx * dispW + tx.value
      const y = kp.ny * dispH + ty.value
      const t = (kp.response - minR) / range      // 0 = coldest, 1 = hottest
      const hue = Math.round((1 - t) * 240)       // 240° blue → 0° red
      ctx.fillStyle = `hsl(${hue},100%,55%)`
      ctx.beginPath()
      ctx.arc(x, y, 2, 0, Math.PI * 2)
      ctx.fill()
    }

    // Colour legend — bottom-left corner of the viewport
    const LX = 12, LY = h - 36, LW = 72, LH = 8
    ctx.save()
    const grad = ctx.createLinearGradient(LX, 0, LX + LW, 0)
    grad.addColorStop(0,   'hsl(240,100%,55%)')
    grad.addColorStop(0.5, 'hsl(120,100%,55%)')
    grad.addColorStop(1,   'hsl(0,100%,55%)')
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.fillRect(LX - 4, LY - 14, LW + 8, LH + 22)
    ctx.fillStyle = grad
    ctx.fillRect(LX, LY, LW, LH)
    ctx.font = '9px sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.textAlign = 'left'
    ctx.fillText('low', LX, LY + LH + 10)
    ctx.textAlign = 'right'
    ctx.fillText('high', LX + LW, LY + LH + 10)
    ctx.textAlign = 'center'
    ctx.fillText('response', LX + LW / 2, LY - 3)
    ctx.restore()
  }

  // GCP markers — observation pixel positions on this image
  if (props.showGcps && props.gcps?.length && img.naturalWidth) {
    for (const g of props.gcps) {
      if (g.px == null || g.py == null) continue
      const x = (g.px / img.naturalWidth)  * dispW + tx.value
      const y = (g.py / img.naturalHeight) * dispH + ty.value
      ctx.save()
      // Ring
      ctx.strokeStyle = 'rgba(255,210,0,0.95)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(x, y, 7, 0, Math.PI * 2)
      ctx.stroke()
      // Cross-hair
      ctx.beginPath()
      ctx.moveTo(x - 11, y); ctx.lineTo(x - 3, y)
      ctx.moveTo(x + 3, y);  ctx.lineTo(x + 11, y)
      ctx.moveTo(x, y - 11);  ctx.lineTo(x, y - 3)
      ctx.moveTo(x, y + 3);   ctx.lineTo(x, y + 11)
      ctx.stroke()
      // Label
      if (g.name) {
        ctx.font = '11px sans-serif'
        const tw = ctx.measureText(g.name).width
        ctx.fillStyle = 'rgba(0,0,0,0.55)'
        ctx.fillRect(x + 9, y - 16, tw + 6, 14)
        ctx.fillStyle = 'rgba(255,210,0,0.95)'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(g.name, x + 12, y - 9)
      }
      ctx.restore()
    }
  }

  // Brush cursor circle
  if (props.maskMode !== 'none' && mousePos) {
    ctx.beginPath()
    ctx.arc(mousePos.x, mousePos.y, props.brushRadius, 0, Math.PI * 2)
    ctx.strokeStyle = props.maskMode === 'draw' ? 'rgba(255,80,80,0.9)' : 'rgba(100,180,255,0.9)'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
}

// ── Mask operations ───────────────────────────────────────────────────────────

function initMaskCanvas() {
  const img = imgEl.value
  if (!img || !img.naturalWidth) return
  maskOffscreen = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
  if (props.image.mask?.dataUrl) loadMaskFromDataUrl(props.image.mask.dataUrl)
}

async function loadMaskFromDataUrl(dataUrl) {
  if (!maskOffscreen) return
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const bmp  = await createImageBitmap(blob)
    const ctx  = maskOffscreen.getContext('2d')
    ctx.clearRect(0, 0, maskOffscreen.width, maskOffscreen.height)
    ctx.drawImage(bmp, 0, 0, maskOffscreen.width, maskOffscreen.height)
    hasMask.value = true
    drawOverlay()
  } catch {}
}

// Paint or erase a circle at screen position onto the mask canvas.
// Brush radius stays constant in screen space (divided by scale → image coords).
function paintAt(sx, sy) {
  if (!maskOffscreen) return
  const imgX = (sx - tx.value) / scale.value
  const imgY = (sy - ty.value) / scale.value
  const r    = props.brushRadius / scale.value
  const ctx  = maskOffscreen.getContext('2d')

  if (props.maskMode === 'draw') {
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = 'red'
    ctx.beginPath()
    ctx.arc(imgX, imgY, r, 0, Math.PI * 2)
    ctx.fill()
    hasMask.value = true
  } else if (props.maskMode === 'erase') {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.beginPath()
    ctx.arc(imgX, imgY, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
  }
}

async function exportMask() {
  if (!maskOffscreen) return
  const blob   = await maskOffscreen.convertToBlob({ type: 'image/png' })
  const dataUrl = await new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.readAsDataURL(blob)
  })
  emit('update-mask', dataUrl)
}

function clearMask() {
  if (!maskOffscreen) return
  maskOffscreen.getContext('2d').clearRect(0, 0, maskOffscreen.width, maskOffscreen.height)
  hasMask.value = false
  emit('update-mask', null)
  drawOverlay()
}

function triggerMaskImport() {
  maskFileInput.value?.click()
}

// Import an image as mask: bright/opaque pixels → red (masked region). Shared
// normalize/rescale logic lives in core/mask.js (also used by the Mask Manager).
async function onMaskFileChange(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file || !maskOffscreen) return
  try {
    const dataUrl = await maskFromSource(file, maskOffscreen.width, maskOffscreen.height)
    await loadMaskFromDataUrl(dataUrl)
    await exportMask()
  } catch (err) {
    console.error('Failed to import mask:', err)
  }
}

// ── Depth map operations ──────────────────────────────────────────────────────

function initDepthCanvas() {
  const img = imgEl.value
  if (!img || !img.naturalWidth) return
  depthOffscreen = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
  if (props.image.depth?.dataUrl) loadDepthFromDataUrl(props.image.depth.dataUrl)
}

// Already-colorized depth maps are stored as PNG data URLs; just blit them in.
async function loadDepthFromDataUrl(dataUrl) {
  if (!depthOffscreen) return
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const bmp  = await createImageBitmap(blob)
    const ctx  = depthOffscreen.getContext('2d')
    ctx.clearRect(0, 0, depthOffscreen.width, depthOffscreen.height)
    ctx.drawImage(bmp, 0, 0, depthOffscreen.width, depthOffscreen.height)
    hasDepth.value = true
    drawOverlay()
  } catch {}
}

// Turbo-ish color ramp: maps a normalized depth (0..1) to [r,g,b].
function depthColor(t) {
  // Smooth blue → cyan → green → yellow → red ramp.
  const r = Math.round(255 * clamp(1.5 - Math.abs(4 * t - 3), 0, 1))
  const g = Math.round(255 * clamp(1.5 - Math.abs(4 * t - 2), 0, 1))
  const b = Math.round(255 * clamp(1.5 - Math.abs(4 * t - 1), 0, 1))
  return [r, g, b]
}

function triggerDepthImport() {
  depthFileInput.value?.click()
}

// Import a (typically grayscale) depth image, normalize by luminance, and
// store a colorized version. Fully transparent / zero pixels are treated as "no data".
async function onDepthFileChange(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file || !depthOffscreen) return
  try {
    const bmp    = await createImageBitmap(file)
    const tmp    = new OffscreenCanvas(depthOffscreen.width, depthOffscreen.height)
    const tmpCtx = tmp.getContext('2d')
    tmpCtx.drawImage(bmp, 0, 0, tmp.width, tmp.height)
    const id = tmpCtx.getImageData(0, 0, tmp.width, tmp.height)
    const d  = id.data

    // Find min/max luminance over valid pixels for contrast normalization.
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue
      const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
      if (lum < lo) lo = lum
      if (lum > hi) hi = lum
    }
    const range = hi - lo || 1

    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) { d[i + 3] = 0; continue }
      const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
      const t = (lum - lo) / range
      const [r, g, b] = depthColor(t)
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255
    }
    const ctx = depthOffscreen.getContext('2d')
    ctx.clearRect(0, 0, depthOffscreen.width, depthOffscreen.height)
    ctx.putImageData(id, 0, 0)
    hasDepth.value = true
    await exportDepth()
    drawOverlay()
  } catch (err) {
    console.error('Failed to import depth map:', err)
  }
}

async function exportDepth() {
  if (!depthOffscreen) return
  const blob = await depthOffscreen.convertToBlob({ type: 'image/png' })
  const dataUrl = await new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.readAsDataURL(blob)
  })
  emit('update-depth', dataUrl)
}

function clearDepth() {
  if (!depthOffscreen) return
  depthOffscreen.getContext('2d').clearRect(0, 0, depthOffscreen.width, depthOffscreen.height)
  hasDepth.value = false
  emit('update-depth', null)
  drawOverlay()
}

// ── Mouse handlers ────────────────────────────────────────────────────────────

function getViewportCoords(e) {
  const rect = container.value.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function onMouseDown(e) {
  if (props.maskMode !== 'none' && e.button === 0) {
    isDrawing = true
    const { x, y } = getViewportCoords(e)
    paintAt(x, y)
    drawOverlay()
  } else if (e.button === 0) {
    dragging.value = true
    startX  = e.clientX
    startY  = e.clientY
    startTx = tx.value
    startTy = ty.value
  }
}

function onMouseMove(e) {
  const { x, y } = getViewportCoords(e)
  mousePos = { x, y }

  if (isDrawing && props.maskMode !== 'none') {
    paintAt(x, y)
  } else if (dragging.value) {
    tx.value = startTx + (e.clientX - startX)
    ty.value = startTy + (e.clientY - startY)
  }

  // Pixel color for status bar
  const px  = Math.floor((x - tx.value) / scale.value)
  const py  = Math.floor((y - ty.value) / scale.value)
  const img = imgEl.value
  if (img && px >= 0 && py >= 0 && px < img.naturalWidth && py < img.naturalHeight) {
    const info = { x: px, y: py, r: null, g: null, b: null, masked: null }
    if (offscreenCtx) {
      const pixel = offscreenCtx.getImageData(px, py, 1, 1).data
      info.r = pixel[0]; info.g = pixel[1]; info.b = pixel[2]
    }
    // Whether this pixel is excluded by the mask (opaque on the mask canvas).
    if (maskOffscreen && hasMask.value) {
      info.masked = maskOffscreen.getContext('2d').getImageData(px, py, 1, 1).data[3] > 127
    }
    hoverPx.value = info
  } else {
    hoverPx.value = null
  }

  drawOverlay()
}

async function onMouseUp() {
  if (isDrawing) {
    isDrawing = false
    await exportMask()
  }
  dragging.value = false
}

function onMouseLeave() {
  dragging.value = false
  if (isDrawing) { isDrawing = false; exportMask() }
  mousePos      = null
  hoverPx.value = null
  drawOverlay()
}

function onWheel(e) {
  e.preventDefault()
  const rect     = container.value.getBoundingClientRect()
  const cx       = e.clientX - rect.left
  const cy       = e.clientY - rect.top
  const factor   = e.deltaY < 0 ? 1.15 : 1 / 1.15
  const newScale = clamp(scale.value * factor, MIN_SCALE, MAX_SCALE)
  const ratio    = newScale / scale.value
  tx.value    = cx - (cx - tx.value) * ratio
  ty.value    = cy - (cy - ty.value) * ratio
  scale.value = newScale
  drawOverlay()
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function setupOffscreenCanvas() {
  const img = imgEl.value
  if (!img || !img.naturalWidth) return
  try {
    const c    = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
    offscreenCtx = c.getContext('2d')
    offscreenCtx.drawImage(img, 0, 0)
  } catch {
    offscreenCtx = null
  }
}

function onImgLoad() {
  fit()
  setupOffscreenCanvas()
  initMaskCanvas()
  initDepthCanvas()
}

// Redraw when keypoints arrive or showKeypoints changes
watch(() => props.image.kpStatus,    () => drawOverlay())
watch(() => props.image.keypoints,   () => drawOverlay(), { deep: false })
watch(() => props.showKeypoints,     () => drawOverlay())
watch(() => props.showMask,          () => drawOverlay())
watch(() => props.showDepth,         () => drawOverlay())
watch(() => props.showGcps,          () => drawOverlay())
watch(() => props.gcps,              () => drawOverlay(), { deep: true })
watch(() => props.maskMode,          () => drawOverlay())

// Sync mask canvas when parent clears or replaces the mask externally
watch(() => props.image.mask, (mask, prev) => {
  if (mask === prev) return
  if (mask?.dataUrl && maskOffscreen) {
    loadMaskFromDataUrl(mask.dataUrl)
  } else if (!mask && maskOffscreen) {
    maskOffscreen.getContext('2d').clearRect(0, 0, maskOffscreen.width, maskOffscreen.height)
    hasMask.value = false
    drawOverlay()
  }
})

// Sync depth canvas when parent clears or replaces the depth map externally
watch(() => props.image.depth, (depth, prev) => {
  if (depth === prev) return
  if (depth?.dataUrl && depthOffscreen) {
    loadDepthFromDataUrl(depth.dataUrl)
  } else if (!depth && depthOffscreen) {
    depthOffscreen.getContext('2d').clearRect(0, 0, depthOffscreen.width, depthOffscreen.height)
    hasDepth.value = false
    drawOverlay()
  }
})

onMounted(() => {
  resizeObserver = new ResizeObserver(() => fit())
  if (container.value) resizeObserver.observe(container.value)
})

onBeforeUnmount(() => resizeObserver?.disconnect())

defineExpose({ fit, zoomIn, zoomOut, triggerMaskImport, clearMask, triggerDepthImport, clearDepth })
</script>

<template>
  <div class="image-viewer">
    <input ref="maskFileInput" type="file" accept="image/*" hidden @change="onMaskFileChange" />
    <input ref="depthFileInput" type="file" accept="image/*" hidden @change="onDepthFileChange" />

    <div
      ref="container"
      class="viewport"
      :class="{ grabbing: dragging && maskMode === 'none', drawing: maskMode !== 'none' }"
      @wheel="onWheel"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="onMouseLeave"
      @dblclick="maskMode === 'none' && fit()"
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

      <canvas ref="overlayCanvas" class="overlay-canvas" />

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
        <template v-if="hoverPx.masked !== null">
          <span class="sep">|</span>
          <span class="masked" :class="{ on: hoverPx.masked }">Masked&nbsp;{{ hoverPx.masked ? '✓' : '—' }}</span>
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

.viewport.grabbing { cursor: grabbing; }
.viewport.drawing  { cursor: none; }

.image {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  image-rendering: auto;
  will-change: transform;
}

.overlay-canvas {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
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

.hud button:hover { background: var(--hover-bg); }

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

.coord { color: var(--text); letter-spacing: 0.02em; }
.sep   { color: var(--panel-border); }

.swatch {
  display: inline-block;
  width: 11px;
  height: 11px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  flex-shrink: 0;
}

.channel     { letter-spacing: 0.02em; }
.channel.r   { color: #e07070; }
.channel.g   { color: #70c070; }
.channel.b   { color: #6090e0; }
.masked      { color: var(--text-dim); letter-spacing: 0.02em; }
.masked.on   { color: #ff8a8a; }
</style>
