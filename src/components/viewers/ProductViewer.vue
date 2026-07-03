<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'

// Tab viewer for a raster product (DEM or orthophoto). Shows the baked preview
// PNG (hillshaded colormap for the DEM, RGB for the ortho) with image-style
// pan/zoom, and a status bar reading out the value under the cursor — elevation
// (+ frame X/Y) for the DEM, RGB for the ortho. Opened from the sidebar / on
// build, like an image tab. Purely a viewer — export is deferred.
const props = defineProps({
  kind: { type: String, required: true },   // 'dem' | 'ortho'
  product: { type: Object, default: null },  // dem/ortho object, or null if gone
})

const container = ref(null)

// Pan/zoom (mirrors ViewerImage): the preview PNG is width×height (= grid), so
// natural pixel dims come straight from the product.
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const dragging = ref(false)
const hover = ref(null)

let startX = 0, startY = 0, startTx = 0, startTy = 0
let resizeObserver = null

const MIN_SCALE = 0.02
const MAX_SCALE = 60
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function dims() {
  return props.product ? [props.product.width, props.product.height] : [0, 0]
}

function fit() {
  const c = container.value
  const [w, h] = dims()
  if (!c || !w || !h || !c.clientWidth || !c.clientHeight) return // hidden tab → skip
  const s = Math.min(c.clientWidth / w, c.clientHeight / h, 1)
  scale.value = s
  tx.value = (c.clientWidth - w * s) / 2
  ty.value = (c.clientHeight - h * s) / 2
}

function applyZoom(factor, cx, cy) {
  const newScale = clamp(scale.value * factor, MIN_SCALE, MAX_SCALE)
  const ratio = newScale / scale.value
  tx.value = cx - (cx - tx.value) * ratio
  ty.value = cy - (cy - ty.value) * ratio
  scale.value = newScale
}

function onWheel(e) {
  e.preventDefault()
  const rect = container.value.getBoundingClientRect()
  applyZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top)
}

function onMouseDown(e) {
  if (e.button !== 0) return
  dragging.value = true
  startX = e.clientX; startY = e.clientY
  startTx = tx.value; startTy = ty.value
}

function onMouseMove(e) {
  const rect = container.value.getBoundingClientRect()
  const x = e.clientX - rect.left, y = e.clientY - rect.top
  if (dragging.value) {
    tx.value = startTx + (e.clientX - startX)
    ty.value = startTy + (e.clientY - startY)
  }
  updateHover(x, y)
}

function onMouseUp() { dragging.value = false }
function onMouseLeave() { dragging.value = false; hover.value = null }

// Read out the product value under viewport coords (x,y).
function updateHover(x, y) {
  const p = props.product
  if (!p) { hover.value = null; return }
  const px = Math.floor((x - tx.value) / scale.value)
  const py = Math.floor((y - ty.value) / scale.value)
  if (px < 0 || py < 0 || px >= p.width || py >= p.height) { hover.value = null; return }
  const idx = py * p.width + px
  if (props.kind === 'dem') {
    const has = p.mask ? p.mask[idx] : !Number.isNaN(p.data?.[idx])
    hover.value = {
      px, py,
      // Frame (map) coordinates of the cell centre, from the geotransform.
      fx: p.originX + (px + 0.5) * p.gsd,
      fy: p.originY - (py + 0.5) * p.gsd,
      z: has ? p.data[idx] : null,
    }
  } else {
    const o = idx * 4
    const a = p.rgba ? p.rgba[o + 3] : 0
    hover.value = { px, py, r: a > 0 ? p.rgba[o] : null, g: p.rgba[o + 1], b: p.rgba[o + 2] }
  }
}

const unitLabel = () => (props.product?.unit === 'm' ? 'm' : 'units')
const fmt = (v, d = 3) => (v == null ? '—' : (Math.abs(v) >= 1000 ? v.toFixed(2) : Number(v.toPrecision(d))))

watch(() => props.product, () => { hover.value = null; requestAnimationFrame(fit) })

onMounted(() => {
  resizeObserver = new ResizeObserver(() => fit())
  if (container.value) resizeObserver.observe(container.value)
  requestAnimationFrame(fit)
})
onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<template>
  <div class="product-viewer">
    <div
      ref="container"
      class="viewport"
      :class="{ grabbing: dragging, checker: kind === 'ortho' }"
      @wheel="onWheel"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="onMouseLeave"
      @dblclick="fit"
    >
      <img
        v-if="product?.previewDataUrl"
        :src="product.previewDataUrl"
        class="raster"
        :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
        draggable="false"
      />
      <div v-else class="empty">
        This {{ kind === 'ortho' ? 'orthophoto' : 'DEM' }} is no longer available — rebuild it.
      </div>

      <div v-if="product" class="hud">
        <span>{{ Math.round(scale * 100) }}%</span>
        <button title="Fit to view" @click.stop="fit">Fit</button>
      </div>
    </div>

    <div class="status-bar">
      <span class="title">{{ kind === 'ortho' ? 'Orthophoto' : 'DEM' }}</span>
      <template v-if="product">
        <span class="sep">|</span>
        <span>{{ product.width }}×{{ product.height }}</span>
        <template v-if="kind === 'dem'">
          <span class="sep">|</span>
          <span>GSD {{ fmt(product.gsd) }} {{ unitLabel() }}/px</span>
        </template>
      </template>

      <span class="spacer"></span>

      <template v-if="hover">
        <span class="coord">col&nbsp;{{ hover.px }}</span>
        <span class="coord">row&nbsp;{{ hover.py }}</span>
        <template v-if="kind === 'dem'">
          <span class="sep">|</span>
          <span class="coord">X&nbsp;{{ fmt(hover.fx, 6) }}</span>
          <span class="coord">Y&nbsp;{{ fmt(hover.fy, 6) }}</span>
          <span class="sep">|</span>
          <span class="value" :class="{ dim: hover.z == null }">
            Z&nbsp;{{ hover.z == null ? 'no data' : `${fmt(hover.z, 5)} ${unitLabel()}` }}
          </span>
        </template>
        <template v-else>
          <span class="sep">|</span>
          <template v-if="hover.r != null">
            <span class="swatch" :style="{ background: `rgb(${hover.r},${hover.g},${hover.b})` }"></span>
            <span class="channel r">R&nbsp;{{ hover.r }}</span>
            <span class="channel g">G&nbsp;{{ hover.g }}</span>
            <span class="channel b">B&nbsp;{{ hover.b }}</span>
          </template>
          <span v-else class="value dim">no data</span>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.product-viewer {
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
.viewport.checker {
  background-image:
    linear-gradient(45deg, rgba(128,128,128,0.10) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128,128,128,0.10) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.10) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.10) 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
}
.raster {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  image-rendering: pixelated;
  will-change: transform;
}
.empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 13px;
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
.title { font-weight: 600; }
.spacer { flex: 1; }
.coord { color: var(--text); letter-spacing: 0.02em; }
.value { color: var(--text); }
.value.dim { color: var(--text-dim); }
.sep { color: var(--panel-border); }
.swatch {
  display: inline-block;
  width: 11px;
  height: 11px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  flex-shrink: 0;
}
.channel { letter-spacing: 0.02em; }
.channel.r { color: #e07070; }
.channel.g { color: #70c070; }
.channel.b { color: #6090e0; }
</style>
