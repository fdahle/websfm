<script setup>
import { defineAsyncComponent, ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { pixelToWorld, worldToPixel } from '../../core/io/rasterSample.js'
import { productDescriptor, createProductRasterSource, productTiledMeta } from '../../core/io/rasterSource.js'
import { rasterUnits } from '../../core/products/rasterUnits.js'
import { copyToClipboard } from '../../composables/useToasts.js'
import { readRasterWindow } from '../../workers/computeClient.js'
import RasterMeasurements from './RasterMeasurements.vue'
import { orthoAdjustFilter } from '../../utils/orthoFilter.js'
const GpuRasterCanvas = defineAsyncComponent(() => import('./raster/GpuRasterCanvas.vue'))
const gpuReady = ref(false)
// What the tiled canvas draws: an imported raster's own meta, or a computed ortho's
// stored COG (productTiledMeta — a local-frame one too, which has no CRS).
const computedProduct = computed(() => !!props.product && !props.product.geoTransform)
const gpuMeta = computed(() => (computedProduct.value ? productTiledMeta(props.kind, props.product) : props.product))
const gpuFile = computed(() => (computedProduct.value && props.product?.cog ? () => props.product.cog : null))
const gpuCapable = computed(() => {
  const m = gpuMeta.value
  return !!(m?.id && (m.crs || computedProduct.value) && !m.crsUnresolved
    && Math.abs(m.geoTransform?.scaleX + m.geoTransform?.scaleY) < 1e-9)
})

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
  // Frame staleness for a COMPUTED product (useReconstructionStore
  // `productFrameStatus`): { stale, reason }. A refit does not corrupt the raster —
  // its coordinates are still exactly what the recorded frame says — but its metres
  // are no longer this project's metres, so it must not be mistaken for a current
  // product. Absent/false ⇒ no banner.
  frameStatus: { type: Object, default: null },
})
// The canvas only reports readiness from its own load(); when it unmounts (the CRS
// became unresolved) nothing would un-hide the preview, leaving a blank viewer.
watch(() => !!gpuCapable.value, (capable) => { if (!capable) gpuReady.value = false })

// One descriptor for both shapes (core/io/rasterSource.js productDescriptor).
const desc = computed(() => productDescriptor(props.product))
// What the tools read values from: the imported raster's own source, or the
// computed product wrapped behind the same RasterSource boundary — an ortho's pixels
// read from its stored COG in the io worker, a window at a time.
const toolSource = computed(() => {
  if (props.source) return props.source
  const p = props.product
  if (!p || p.geoTransform) return null
  const readRawWindow = props.kind === 'ortho' && p.cog
    ? (rect, _level, opts = {}) => readRasterWindow(p.cog, { rect, ...opts }) : null
  return createProductRasterSource(props.kind, p, { readRawWindow })
})

// Cell size in world units (for the GSD readout), sign-independent.
const gsdOf = computed(() => {
  const gt = desc.value?.geoTransform
  return gt ? Math.abs(gt.scaleX) : null
})

const container = ref(null)
const measurements = ref(null)

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
  const rect = container.value.getBoundingClientRect()
  if (!e.shiftKey && measurements.value?.pick(e.clientX - rect.left, e.clientY - rect.top)) return
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

// The measuring tools' view adapter: raster world ↔ viewport pixels through this
// tab's pan/zoom. A new object per transform change re-renders their overlay.
const view = computed(() => {
  const d = desc.value
  if (!d) return null
  const s = scale.value, x0 = tx.value, y0 = ty.value
  return {
    toScreen(wx, wy) { const p = worldToPixel(d, wx, wy); return { x: x0 + p.col * s, y: y0 + p.row * s } },
    fromScreen(sx, sy) { return pixelToWorld(d, (sx - x0) / s, (sy - y0) / s) },
  }
})
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
    // The cell's own value, never a neighbour's: a hole reads "no data". A reference
    // DEM's declared vertical offset applies here exactly as on the map readout and
    // in the measurements (useExternalStore.sampleReferenceDem), so one cell reads
    // one height everywhere.
    const raw = world ? (toolSource.value?.cellValueAt(world.x, world.y) ?? null) : null
    const z = raw == null ? null : raw + (p.vOffset || 0)
    hover.value = { px, py, fx: world?.x ?? null, fy: world?.y ?? null, z }
  } else {
    // An imported ortho decoded into memory before tiled display reads its plane;
    // every other ortho reads the cell from its file.
    const rgba = props.source?.rgba() ?? null
    if (!rgba) { readColour(px, py); return }
    const o = idx * 4
    hover.value = { px, py, r: rgba[o + 3] > 0 ? rgba[o] : null, g: rgba[o + 1], b: rgba[o + 2] }
  }
}

// The colour under the cursor, read as a 1×1 window off the raster's file (an async
// worker read). Mouse moves outrun it, so at most one read is in flight and the
// newest cell is read next; a stale answer is dropped. A transparent cell (alpha 0)
// reads "no data".
let colourBusy = false, colourWanted = null
function readColour(px, py) {
  if (hover.value?.px === px && hover.value?.py === py && (hover.value.pending || hover.value.r !== undefined)) return
  hover.value = { px, py, r: null, pending: !!toolSource.value }
  if (!toolSource.value) return
  colourWanted = [px, py]
  if (!colourBusy) pumpColour()
}
async function pumpColour() {
  colourBusy = true
  while (colourWanted) {
    const [px, py] = colourWanted
    colourWanted = null
    const src = toolSource.value
    const nb = Math.min(4, src?.meta?.bands ?? 0)
    let read = null
    try {
      const bands = Array.from({ length: nb }, (_, i) => i)
      const w = nb ? await src.readWindow({ col: px, row: py, width: 1, height: 1 }, 0, { bands }) : null
      const ch = w?.channels ?? []
      const alpha = nb === 4 ? ch[3]?.[0] : 255
      read = ch.length ? { r: alpha > 0 ? ch[0][0] : null, g: (ch[1] ?? ch[0])[0], b: (ch[2] ?? ch[0])[0] } : { r: null }
    } catch { read = { r: null } }
    if (hover.value?.px === px && hover.value?.py === py) hover.value = { px, py, ...read }
  }
  colourBusy = false
}

// Z is in the vertical unit, the GSD in the horizontal one (rasterUnits.js — an
// imported raster records only its CRS, which still says metres).
const units = computed(() => rasterUnits(props.product))
// A computed product's preview is a blob: URL over its PNG Blob; an imported raster's
// small (≤1024 px) preview is a data URL in its index record.
const previewSrc = computed(() => props.product?.previewUrl ?? props.product?.previewDataUrl ?? null)
// A computed ortho's brightness/contrast/gamma, matching what the GPU tiles draw
// (an imported raster's `style` is band math, already baked into its preview).
const previewFilter = computed(() => (computedProduct.value && props.kind === 'ortho'
  ? orthoAdjustFilter(props.product?.style) : null))
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
// Measure group handles: the tool lives in RasterMeasurements; the Ribbon reads
// `measureState` (via App's activeRasterTab) to render which tool is on.
const measureState = computed(() => measurements.value?.state ?? null)
function setMeasureTool(tool, opts) { measurements.value?.setTool(tool, opts) }
function toggleSavedMeasurements() { measurements.value?.toggleSaved() }
defineExpose({ fit, zoomBy, measureState, setMeasureTool, toggleSavedMeasurements })
</script>

<template>
  <div class="product-viewer">
    <div v-if="frameStatus?.stale" class="frame-banner">
      Outdated frame — {{ frameStatus.reason }} since this {{ kind === 'ortho' ? 'orthophoto' : 'DEM' }}
      was built. It still shows the coordinates it was built in; rebuild it to use the current frame.
    </div>
    <div
      ref="container"
      class="viewport"
      :class="{ grabbing: dragging, checker: kind === 'ortho', measuring: measurements?.active }"
      @wheel="onWheel"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="onMouseLeave"
      @dblclick="!measurements?.active && fit()"
      @contextmenu="onContextMenu"
    >
      <!-- The preview PNG is downsampled (≤1024 px) for a large imported raster, so
           it MUST be stretched back to the full grid size: fit()/pan/zoom and the
           cursor readout all work in full-res pixels. Without the explicit size a
           big raster renders at preview scale — tiny, and off-centre, because the
           centring offset was computed for the full width/height. -->
      <img
        v-if="previewSrc"
        v-show="!gpuReady"
        :src="previewSrc"
        class="raster"
        :style="{
          width: product.width + 'px',
          height: product.height + 'px',
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          filter: previewFilter ?? undefined,
        }"
        draggable="false"
      />
      <div v-else class="empty">
        This {{ kind === 'ortho' ? 'orthophoto' : 'DEM' }} is no longer available —
        {{ source === null && product?.geoTransform ? 're-import it.' : 'rebuild it.' }}
      </div>

      <GpuRasterCanvas v-if="gpuCapable" :product="gpuMeta" :file="gpuFile" :scale="scale" :tx="tx" :ty="ty" @ready="gpuReady = $event" />
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

      <RasterMeasurements ref="measurements" :product="product" :source="toolSource" :descriptor="desc"
        :frame-status="frameStatus" :kind="kind" :view="view" />
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
            Z&nbsp;{{ hover.z == null ? 'no data' : `${fmt(hover.z, 5)} ${units.vertical}` }}
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
          <span v-else class="value dim">{{ hover.pending ? '…' : 'no data' }}</span>
        </template>
      </template>

      <span class="spacer"></span>

      <template v-if="product">
        <span class="meta">{{ product.width }}×{{ product.height }}</span>
        <template v-if="gsdOf != null">
          <span class="sep">|</span>
          <span class="meta">GSD {{ fmt(gsdOf) }} {{ units.horizontal }}/px</span>
        </template>
        <template v-if="product.crs">
          <span class="sep">|</span>
          <span class="meta">{{ product.crs }}</span>
        </template>
        <!-- Zoom is status; Fit / Zoom in / out are ribbon commands (raster ▸ View). -->
        <span class="sep">|</span>
        <span class="meta zoom-level" title="Zoom">{{ Math.round(scale * 100) }}%</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.frame-banner {
  flex-shrink: 0;
  padding: 6px 10px;
  font-size: 11px;
  color: #e0a030;
  background: rgba(224, 160, 48, 0.1);
  border-bottom: 1px solid rgba(224, 160, 48, 0.35);
}

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
.viewport.measuring:not(.grabbing) { cursor: crosshair; }
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
