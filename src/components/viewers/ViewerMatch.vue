<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  imageA: { type: Object, required: true },
  imageB: { type: Object, required: true },
  matches: { type: Array, default: () => [] },  // [[ia, ib], ...]
  // Correspondences that became surviving tie-points in the sparse model, as a
  // Set of "ia:ib" keys (kpIdx in the same sorted-uuid order as `matches`). When
  // provided, matches are two-tone: green = aligned (used in the cloud), red =
  // verified inlier that never triangulated. Null ⇒ no sparse model yet, draw
  // every inlier one neutral colour (nothing to distinguish pre-alignment).
  usedKeys: { type: Object, default: null },
})

// aligned / unused split for the status-bar legend (only meaningful with usedKeys).
const usedStats = computed(() => {
  if (!props.usedKeys) return null
  let used = 0
  for (const [ia, ib] of props.matches) if (props.usedKeys.has(`${ia}:${ib}`)) used++
  return { used, unused: props.matches.length - used }
})

// Colour palette, mirroring Metashape's aligned/not-aligned convention.
const C_USED = '#00e676'     // green — became a tie-point
const C_UNUSED = '#ff5252'   // red — verified inlier, not in the model
const C_NEUTRAL = '#ffd700'  // gold — no sparse model to judge against

const panelsEl       = ref(null)
const leftContainer  = ref(null)
const rightContainer = ref(null)
const leftImg        = ref(null)
const rightImg       = ref(null)
const overlayCanvas  = ref(null)

// Per-panel pan/zoom state
const L = ref({ scale: 1, tx: 0, ty: 0 })
const R = ref({ scale: 1, tx: 0, ty: 0 })

const MIN_SCALE = 0.05
const MAX_SCALE = 40
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }

let dragging = null  // null | { panel: 'L'|'R', startX, startY, startTx, startTy }

// ── Fit ───────────────────────────────────────────────────────────────────────

function fit(side) {
  const c   = side === 'L' ? leftContainer.value  : rightContainer.value
  const img = side === 'L' ? leftImg.value        : rightImg.value
  const s   = side === 'L' ? L.value              : R.value
  if (!c || !img?.naturalWidth) return
  const sc = Math.min(c.clientWidth / img.naturalWidth, c.clientHeight / img.naturalHeight, 1)
  s.scale = sc
  s.tx = (c.clientWidth  - img.naturalWidth  * sc) / 2
  s.ty = (c.clientHeight - img.naturalHeight * sc) / 2
  drawOverlay()
}

function fitBoth() {
  fit('L')
  fit('R')
}

// ── Zoom ─────────────────────────────────────────────────────────────────────

function applyZoom(side, factor, cx, cy) {
  const s = side === 'L' ? L.value : R.value
  const newScale = clamp(s.scale * factor, MIN_SCALE, MAX_SCALE)
  const ratio = newScale / s.scale
  s.tx = cx - (cx - s.tx) * ratio
  s.ty = cy - (cy - s.ty) * ratio
  s.scale = newScale
  drawOverlay()
}

function onWheel(e, side) {
  const c    = side === 'L' ? leftContainer.value : rightContainer.value
  const rect = c.getBoundingClientRect()
  const cx   = e.clientX - rect.left
  const cy   = e.clientY - rect.top
  applyZoom(side, e.deltaY < 0 ? 1.15 : 1 / 1.15, cx, cy)
}

// ── Pan ──────────────────────────────────────────────────────────────────────

function onMouseDown(e, side) {
  if (e.button !== 0) return
  const s = side === 'L' ? L.value : R.value
  dragging = { side, startX: e.clientX, startY: e.clientY, startTx: s.tx, startTy: s.ty }
}

function onMouseMove(e) {
  if (!dragging) return
  const s = dragging.side === 'L' ? L.value : R.value
  s.tx = dragging.startTx + (e.clientX - dragging.startX)
  s.ty = dragging.startTy + (e.clientY - dragging.startY)
  drawOverlay()
}

function onMouseUp() { dragging = null }

// ── Overlay drawing ───────────────────────────────────────────────────────────

function drawOverlay() {
  const canvas  = overlayCanvas.value
  const panels  = panelsEl.value
  const lc      = leftContainer.value
  const rc      = rightContainer.value
  const li      = leftImg.value
  const ri      = rightImg.value
  if (!canvas || !panels || !lc || !rc) return

  const panelsRect = panels.getBoundingClientRect()
  const w = panelsRect.width
  const h = panelsRect.height
  if (!w || !h) return

  const dpr = window.devicePixelRatio || 1
  const pw  = Math.round(w * dpr)
  const ph  = Math.round(h * dpr)
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width  = pw
    canvas.height = ph
    canvas.style.width  = `${w}px`
    canvas.style.height = `${h}px`
  }

  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const lcRect = lc.getBoundingClientRect()
  const rcRect = rc.getBoundingClientRect()

  const lOx = lcRect.left - panelsRect.left
  const lOy = lcRect.top  - panelsRect.top
  const rOx = rcRect.left - panelsRect.left
  const rOy = rcRect.top  - panelsRect.top

  const kpsA   = props.imageA.keypoints || []
  const kpsB   = props.imageB.keypoints || []
  const pairs  = props.matches || []

  if (!li?.naturalWidth || !ri?.naturalWidth || !pairs.length) return

  const lNW = li.naturalWidth,  lNH = li.naturalHeight
  const rNW = ri.naturalWidth,  rNH = ri.naturalHeight
  const ls = L.value.scale, ltx = L.value.tx + lOx, lty = L.value.ty + lOy
  const rs = R.value.scale, rtx = R.value.tx + rOx, rty = R.value.ty + rOy

  function lPos(kp) { return { x: kp.nx * lNW * ls + ltx, y: kp.ny * lNH * ls + lty } }
  function rPos(kp) { return { x: kp.nx * rNW * rs + rtx, y: kp.ny * rNH * rs + rty } }

  const used = props.usedKeys
  const colorOf = (ia, ib) =>
    used ? (used.has(`${ia}:${ib}`) ? C_USED : C_UNUSED) : C_NEUTRAL

  // Lines (drawn under dots). Draw unused (red) first so aligned (green) lands on
  // top — the aligned tie-points are the signal, and shouldn't be occluded.
  ctx.save()
  ctx.lineWidth = 1
  const drawLines = (wantUsed) => {
    for (const [ia, ib] of pairs) {
      const a = kpsA[ia], b = kpsB[ib]
      if (!a || !b) continue
      const isUsed = used ? used.has(`${ia}:${ib}`) : true
      if (used && isUsed !== wantUsed) continue
      ctx.globalAlpha = used ? (isUsed ? 0.45 : 0.2) : 0.35
      ctx.strokeStyle = colorOf(ia, ib)
      ctx.beginPath()
      ctx.moveTo(lPos(a).x, lPos(a).y)
      ctx.lineTo(rPos(b).x, rPos(b).y)
      ctx.stroke()
    }
  }
  if (used) { drawLines(false); drawLines(true) } else drawLines(true)
  ctx.restore()

  // Dots — coloured by the same aligned/unused status on both panels.
  const DOT = 4
  for (const [ia, ib] of pairs) {
    const c = colorOf(ia, ib)
    const a = kpsA[ia]
    if (a) {
      const pa = lPos(a)
      ctx.fillStyle = c
      ctx.beginPath()
      ctx.arc(pa.x, pa.y, DOT, 0, Math.PI * 2)
      ctx.fill()
    }
    const b = kpsB[ib]
    if (b) {
      const pb = rPos(b)
      ctx.fillStyle = c
      ctx.beginPath()
      ctx.arc(pb.x, pb.y, DOT, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let resizeObserver = null

onMounted(() => {
  resizeObserver = new ResizeObserver(() => fitBoth())
  if (panelsEl.value) resizeObserver.observe(panelsEl.value)
})

onBeforeUnmount(() => resizeObserver?.disconnect())

watch(() => props.matches,          () => drawOverlay(), { deep: false })
watch(() => props.usedKeys,         () => drawOverlay())
watch(() => props.imageA.keypoints, () => drawOverlay())
watch(() => props.imageB.keypoints, () => drawOverlay())

function onImgLoad(side) {
  fit(side)
}
</script>

<template>
  <div class="match-viewer">
    <div
      ref="panelsEl"
      class="panels"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="onMouseUp"
    >
      <!-- Left panel -->
      <div
        ref="leftContainer"
        class="panel"
        @wheel.prevent="onWheel($event, 'L')"
        @mousedown="onMouseDown($event, 'L')"
        @dblclick="fit('L')"
      >
        <img
          ref="leftImg"
          :src="imageA.url"
          :alt="imageA.name"
          class="panel-img"
          :style="{ transform: `translate(${L.tx}px, ${L.ty}px) scale(${L.scale})` }"
          draggable="false"
          @load="onImgLoad('L')"
        />
      </div>

      <!-- Vertical divider -->
      <div class="splitter" />

      <!-- Right panel -->
      <div
        ref="rightContainer"
        class="panel"
        @wheel.prevent="onWheel($event, 'R')"
        @mousedown="onMouseDown($event, 'R')"
        @dblclick="fit('R')"
      >
        <img
          ref="rightImg"
          :src="imageB.url"
          :alt="imageB.name"
          class="panel-img"
          :style="{ transform: `translate(${R.tx}px, ${R.ty}px) scale(${R.scale})` }"
          draggable="false"
          @load="onImgLoad('R')"
        />
      </div>

      <!-- Canvas overlay (spans both panels) -->
      <canvas ref="overlayCanvas" class="overlay" />
    </div>

    <!-- Status bar -->
    <div class="status-bar">
      <span class="panel-label">{{ imageA.name }}</span>
      <span v-if="usedStats" class="match-legend">
        <span class="swatch used" /> {{ usedStats.used }} aligned
        <span class="swatch unused" /> {{ usedStats.unused }} unused
      </span>
      <span v-else class="match-count">{{ matches.length }} tie points</span>
      <span class="panel-label">{{ imageB.name }}</span>
    </div>
  </div>
</template>

<style scoped>
.match-viewer {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  user-select: none;
}

.panels {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}

.panel {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
  cursor: grab;
}

.panel:active { cursor: grabbing; }

.panel-img {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  image-rendering: auto;
  will-change: transform;
}

.splitter {
  flex-shrink: 0;
  width: 2px;
  background: var(--panel-border);
  z-index: 1;
}

.overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.status-bar {
  flex-shrink: 0;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  font-size: 11px;
  font-family: ui-monospace, 'Cascadia Code', 'Fira Mono', monospace;
  color: var(--text-dim);
  background: var(--panel);
  border-top: 1px solid var(--panel-border);
}

.match-count {
  color: #4c9;
  font-variant-numeric: tabular-nums;
}

.match-legend {
  display: flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}

.match-legend .swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 6px;
}

.match-legend .swatch:first-child { margin-left: 0; }
.match-legend .swatch.used   { background: #00e676; }
.match-legend .swatch.unused { background: #ff5252; }

.panel-label {
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
