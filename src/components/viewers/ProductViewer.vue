<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { pixelToWorld } from '../../core/io/rasterSample.js'
import { copyToClipboard } from '../../composables/useToasts.js'

// Tab viewer for ANY georeferenced raster — a computed DEM/orthophoto product,
// or an imported reference raster. Shows the baked preview PNG (hillshaded
// colormap for elevation, RGB for imagery) with image-style pan/zoom, and a
// status bar reading out the value under the cursor. Purely a viewer.
//
// It is deliberately shape-agnostic: the computed products carry
// { originX, originY, gsd } while an imported raster carries a full
// `geoTransform`, so both are normalised to one descriptor below and the two
// tab kinds become one call site of this component.
const props = defineProps({
  kind: { type: String, required: true },   // 'dem' | 'ortho'
  product: { type: Object, default: null },  // dem/ortho product, RasterMeta, or null
  // For an imported raster: the hydrated RasterSource, so the cursor can read
  // real values. Absent ⇒ the preview still renders, values read as "—".
  source: { type: Object, default: null },
})

// One descriptor for both shapes. A computed product's grid is north-up with a
// square cell, i.e. scaleX = gsd, scaleY = -gsd.
const desc = computed(() => {
  const p = props.product
  if (!p) return null
  if (p.geoTransform) return { width: p.width, height: p.height, geoTransform: p.geoTransform }
  if (p.gsd == null) return null
  return {
    width: p.width,
    height: p.height,
    geoTransform: { originX: p.originX, originY: p.originY, scaleX: p.gsd, scaleY: -p.gsd },
  }
})

// Cell size in world units (for the GSD readout), sign-independent.
const gsdOf = computed(() => {
  const gt = desc.value?.geoTransform
  return gt ? Math.abs(gt.scaleX) : null
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

// ── Right-click context menu ──────────────────────────────────────────────────
// Same affordances as the image view's general menu, in raster terms: the value
// under the cursor is a world coordinate + elevation/colour rather than a pixel.
// { x, y (viewport, for positioning), read (the same shape updateHover builds) }.
const menu = ref(null)

function onContextMenu(e) {
  e.preventDefault()
  const rect = container.value?.getBoundingClientRect()
  if (!rect || !desc.value) return
  const x = e.clientX - rect.left, y = e.clientY - rect.top
  updateHover(x, y)
  if (!hover.value) return // outside the grid
  const cw = container.value.clientWidth, ch = container.value.clientHeight
  menu.value = {
    x: Math.min(x, Math.max(0, cw - 200)),
    y: Math.min(y, Math.max(0, ch - 180)),
    read: hover.value,
  }
}

function closeMenu() { menu.value = null }

function menuCopyPixel() {
  const r = menu.value?.read
  if (r) copyToClipboard(`${r.px}, ${r.py}`, 'pixel')
  closeMenu()
}
function menuCopyWorld() {
  const r = menu.value?.read
  // The ortho readout doesn't carry world coords, so recompute from the cell centre.
  const w = r ? pixelToWorld(desc.value, r.px + 0.5, r.py + 0.5) : null
  if (w) copyToClipboard(`${w.x}, ${w.y}`, 'coordinate')
  closeMenu()
}
function menuCopyValue() {
  const r = menu.value?.read
  if (!r) return closeMenu()
  if (props.kind === 'dem') copyToClipboard(r.z == null ? 'no data' : String(r.z), 'elevation')
  else copyToClipboard(r.r == null ? 'no data' : `rgb(${r.r}, ${r.g}, ${r.b})`, 'color')
  closeMenu()
}
function menuZoomIn() {
  if (menu.value) applyZoom(1.8, menu.value.x, menu.value.y)
  closeMenu()
}
function menuFit() { fit(); closeMenu() }

function onMouseDown(e) {
  if (menu.value && e.button === 0) { closeMenu(); return }
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

// Read out the raster value under viewport coords (x,y).
//
// The preview PNG is downsampled for a large imported raster, so viewport pixels
// are converted through the *descriptor* (full-res grid), not through the
// preview's own dimensions — the <img> is stretched to width×height either way.
function updateHover(x, y) {
  const p = props.product
  const d = desc.value
  if (!p || !d) { hover.value = null; return }
  const px = Math.floor((x - tx.value) / scale.value)
  const py = Math.floor((y - ty.value) / scale.value)
  if (px < 0 || py < 0 || px >= p.width || py >= p.height) { hover.value = null; return }

  // Cell-centre world coordinates, one code path for both shapes.
  const world = pixelToWorld(d, px + 0.5, py + 0.5)
  const idx = py * p.width + px

  if (props.kind === 'dem') {
    hover.value = { px, py, fx: world?.x ?? null, fy: world?.y ?? null, z: demValueAt(idx, world) }
  } else {
    const rgba = props.source ? props.source.rgba() : p.rgba
    if (!rgba) { hover.value = { px, py, r: null }; return }
    const o = idx * 4
    hover.value = { px, py, r: rgba[o + 3] > 0 ? rgba[o] : null, g: rgba[o + 1], b: rgba[o + 2] }
  }
}

// Elevation under a cell, from whichever backing the tab has: an imported
// raster reads through its RasterSource (nodata already folded to NaN), a
// computed DEM reads its mask+data directly.
function demValueAt(idx, world) {
  if (props.source) {
    // sampleAt takes the raster's own CRS, which is exactly the frame `world` is in.
    return world ? props.source.sampleAt(world.x, world.y) : null
  }
  const p = props.product
  if (!p?.data) return null
  const has = p.mask ? p.mask[idx] : !Number.isNaN(p.data[idx])
  return has ? p.data[idx] : null
}

const unitLabel = () => (props.product?.unit === 'm' ? 'm' : 'units')
const fmt = (v, d = 3) => (v == null ? '—' : (Math.abs(v) >= 1000 ? v.toFixed(2) : Number(v.toPrecision(d))))

watch(() => props.product, () => { hover.value = null; requestAnimationFrame(fit) })

let lastSize = null // { w, h } last non-zero container size the observer fitted to

onMounted(() => {
  // Only refit on a *real* viewport change — a v-show-hidden tab collapses to 0×0
  // and springs back on reactivation, which must not reset the user's zoom/pan.
  resizeObserver = new ResizeObserver(() => {
    const c = container.value
    if (!c) return
    const w = c.clientWidth, h = c.clientHeight
    if (!w || !h) return
    if (lastSize && lastSize.w === w && lastSize.h === h) return
    lastSize = { w, h }
    fit()
  })
  if (container.value) resizeObserver.observe(container.value)
  requestAnimationFrame(fit)
})
onBeforeUnmount(() => resizeObserver?.disconnect())

// Imperative handles for the Ribbon's contextual Raster tab (zoom about the
// viewport centre, since a ribbon click has no cursor position).
function zoomBy(factor) {
  const c = container.value
  if (c) applyZoom(factor, c.clientWidth / 2, c.clientHeight / 2)
}
defineExpose({ fit, zoomBy })
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
      @contextmenu="onContextMenu"
    >
      <!-- The preview PNG is downsampled (≤1024 px) for a large imported raster, so
           it MUST be stretched back to the full grid size: fit()/pan/zoom and the
           cursor readout all work in full-res pixels. Without the explicit size a
           big raster renders at preview scale — tiny, and off-centre, because the
           centring offset was computed for the full width/height. -->
      <img
        v-if="product?.previewDataUrl"
        :src="product.previewDataUrl"
        class="raster"
        :style="{
          width: product.width + 'px',
          height: product.height + 'px',
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
        }"
        draggable="false"
      />
      <div v-else class="empty">
        This {{ kind === 'ortho' ? 'orthophoto' : 'DEM' }} is no longer available —
        {{ source === null && product?.geoTransform ? 're-import it.' : 'rebuild it.' }}
      </div>

      <div
        v-if="menu"
        class="ctx-menu"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @mousedown.stop
        @contextmenu.prevent
      >
        <button class="ctx-item" @click="menuCopyPixel">Copy pixel (col,&nbsp;row)</button>
        <button class="ctx-item" @click="menuCopyWorld">Copy coordinate (X,&nbsp;Y)</button>
        <button class="ctx-item" @click="menuCopyValue">
          {{ kind === 'dem' ? 'Copy elevation (Z)' : 'Copy color (RGB)' }}
        </button>
        <div class="ctx-sep"></div>
        <button class="ctx-item" @click="menuZoomIn">Zoom in here</button>
        <button class="ctx-item" @click="menuFit">Fit to view</button>
      </div>

      <div v-if="product" class="hud">
        <span>{{ Math.round(scale * 100) }}%</span>
        <button title="Fit to view" @click.stop="fit">Fit</button>
      </div>
    </div>

    <!-- Layout mirrors the image view: live cursor readout on the left, static
         raster properties on the right. -->
    <div class="status-bar">
      <template v-if="hover">
        <span class="coord">col&nbsp;{{ hover.px }}</span>
        <span class="sep">|</span>
        <span class="coord">row&nbsp;{{ hover.py }}</span>
        <template v-if="kind === 'dem'">
          <span class="sep">|</span>
          <span class="coord">X&nbsp;{{ fmt(hover.fx, 6) }}</span>
          <span class="sep">|</span>
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

      <span class="spacer"></span>

      <template v-if="product">
        <span class="meta">{{ product.width }}×{{ product.height }}</span>
        <template v-if="gsdOf != null">
          <span class="sep">|</span>
          <span class="meta">GSD {{ fmt(gsdOf) }} {{ unitLabel() }}/px</span>
        </template>
        <template v-if="product.crs">
          <span class="sep">|</span>
          <span class="meta">{{ product.crs }}</span>
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
.ctx-menu {
  position: absolute;
  z-index: 20;
  min-width: 180px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  padding: 4px;
}
.ctx-sep {
  height: 1px;
  background: var(--panel-border);
  margin: 4px 2px;
}
.ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 5px 8px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.ctx-item:hover { background: var(--hover-bg); }
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
.spacer { flex: 1; }
.meta { color: var(--text-dim); }
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
