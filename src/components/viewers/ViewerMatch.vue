<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { asPairList } from '../../core/sfm/matchCodec.js'
import { MAX_SCALE, MIN_SCALE } from '../../composables/useImageViewport.js'
import { clamp } from '../../core/stats.js'

const props = defineProps({
  imageA: { type: Object, required: true },
  imageB: { type: Object, required: true },
  // The two images' keypoints (core/features/keypoints.js). Not on the image records —
  // the host loads them on demand (useImagesStore.ensureKeypoints); null while loading.
  keypointsA: { type: Object, default: null },
  keypointsB: { type: Object, default: null },
  // Flat Uint32Array [ia0, ib0, ia1, ib1, …] (the match store's shape) or [[ia, ib], …].
  matches: { type: [Uint32Array, Array], default: () => new Uint32Array(0) },
  // Correspondences that became surviving tie-points in the sparse model, as a
  // Set of "ia:ib" keys (kpIdx in the same sorted-uuid order as `matches`). When
  // provided, matches are two-tone: green = aligned (used in the cloud), red =
  // verified inlier that never triangulated. Null ⇒ no sparse model yet, draw
  // every inlier one neutral colour (nothing to distinguish pre-alignment).
  usedKeys: { type: Object, default: null },
})
// Read as [ia, ib] pairs whatever the shape (core/sfm/matchCodec.js).
const pairList = computed(() => asPairList(props.matches))

// The tie points of the model that both images see but this pair never matched
// directly, as [ia, ib]: other photos' matches joined them into one track (track
// completion, guided extension, a camera placed by PnP). This is why "Used" can
// exceed "Matches" in the list. Drawn blue.
const indirectPairs = computed(() => {
  if (!props.usedKeys) return []
  const direct = new Set(pairList.value.map(([ia, ib]) => `${ia}:${ib}`))
  const out = []
  for (const key of props.usedKeys) {
    if (direct.has(key)) continue
    const sep = key.indexOf(':')
    out.push([Number(key.slice(0, sep)), Number(key.slice(sep + 1))])
  }
  return out
})

// aligned / unused / indirect split for the status-bar legend (only meaningful with
// usedKeys). `used` = direct matches that triangulated; `unused` = verified inliers
// that never made the model; `indirect` = indirectPairs.
const usedStats = computed(() => {
  if (!props.usedKeys) return null
  let used = 0
  const list = pairList.value
  for (const [ia, ib] of list) if (props.usedKeys.has(`${ia}:${ib}`)) used++
  return { used, unused: list.length - used, indirect: indirectPairs.value.length }
})

// Hide the unused (red) matches — dots + lines — in the preview. Preview-local.
const hideUnused = ref(false)

// The overlay canvas spans BOTH panels, so panning one image far enough pushes
// its dots across the splitter and they render on top of the other photo. Off
// (the default) each panel's dots are clipped to its own panel; on restores the
// old spill-over behaviour. Lines are never clipped — crossing the splitter is
// what they're for. Preview-local, like `hideUnused`.
const spillPoints = ref(false)

// Colour palette, mirroring Metashape's aligned/not-aligned convention.
const C_USED = '#00e676' // green — became a tie-point
const C_UNUSED = '#ff5252' // red — verified inlier, not in the model
const C_NEUTRAL = '#ffd700' // gold — no sparse model to judge against
const C_INDIRECT = '#40a0ff' // blue — a tie point of both, joined through other photos

const panelsEl = ref(null)
const leftContainer = ref(null)
const rightContainer = ref(null)
const leftImg = ref(null)
const rightImg = ref(null)
const overlayCanvas = ref(null)

// Per-panel pan/zoom state
const L = ref({ scale: 1, tx: 0, ty: 0 })
const R = ref({ scale: 1, tx: 0, ty: 0 })

let dragging = null // null | { panel: 'L'|'R', startX, startY, startTx, startTy }

// ── Fit ───────────────────────────────────────────────────────────────────────

function fit(side) {
  const c = side === 'L' ? leftContainer.value : rightContainer.value
  const img = side === 'L' ? leftImg.value : rightImg.value
  const s = side === 'L' ? L.value : R.value
  if (!c || !img?.naturalWidth) return
  const sc = Math.min(c.clientWidth / img.naturalWidth, c.clientHeight / img.naturalHeight, 1)
  s.scale = sc
  s.tx = (c.clientWidth - img.naturalWidth * sc) / 2
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
  const c = side === 'L' ? leftContainer.value : rightContainer.value
  const rect = c.getBoundingClientRect()
  const cx = e.clientX - rect.left
  const cy = e.clientY - rect.top
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

function onMouseUp() {
  dragging = null
}

// ── Overlay drawing ───────────────────────────────────────────────────────────

function drawOverlay() {
  const canvas = overlayCanvas.value
  const panels = panelsEl.value
  const lc = leftContainer.value
  const rc = rightContainer.value
  const li = leftImg.value
  const ri = rightImg.value
  if (!canvas || !panels || !lc || !rc) return

  const panelsRect = panels.getBoundingClientRect()
  const w = panelsRect.width
  const h = panelsRect.height
  if (!w || !h) return

  const dpr = window.devicePixelRatio || 1
  const pw = Math.round(w * dpr)
  const ph = Math.round(h * dpr)
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw
    canvas.height = ph
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
  }

  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const lcRect = lc.getBoundingClientRect()
  const rcRect = rc.getBoundingClientRect()

  const lOx = lcRect.left - panelsRect.left
  const lOy = lcRect.top - panelsRect.top
  const rOx = rcRect.left - panelsRect.left
  const rOy = rcRect.top - panelsRect.top

  // Typed keypoints (core/features/keypoints.js), read by index.
  const kpsA = props.keypointsA
  const kpsB = props.keypointsB
  const pairs = pairList.value

  if (!li?.naturalWidth || !ri?.naturalWidth || !pairs.length || !kpsA?.length || !kpsB?.length) return

  const lNW = li.naturalWidth,
    lNH = li.naturalHeight
  const rNW = ri.naturalWidth,
    rNH = ri.naturalHeight
  const ls = L.value.scale,
    ltx = L.value.tx + lOx,
    lty = L.value.ty + lOy
  const rs = R.value.scale,
    rtx = R.value.tx + rOx,
    rty = R.value.ty + rOy

  function lPos(i) {
    return { x: kpsA.nx(i) * lNW * ls + ltx, y: kpsA.ny(i) * lNH * ls + lty }
  }
  function rPos(i) {
    return { x: kpsB.nx(i) * rNW * rs + rtx, y: kpsB.ny(i) * rNH * rs + rty }
  }

  const used = props.usedKeys
  const colorOf = (ia, ib) => (used ? (used.has(`${ia}:${ib}`) ? C_USED : C_UNUSED) : C_NEUTRAL)

  // Lines (drawn under dots). Draw unused (red) first so aligned (green) lands on
  // top — the aligned tie-points are the signal, and shouldn't be occluded.
  ctx.save()
  ctx.lineWidth = 1
  const drawLines = (wantUsed) => {
    for (const [ia, ib] of pairs) {
      if (ia >= kpsA.length || ib >= kpsB.length) continue
      const isUsed = used ? used.has(`${ia}:${ib}`) : true
      if (used && isUsed !== wantUsed) continue
      ctx.globalAlpha = used ? (isUsed ? 0.45 : 0.2) : 0.35
      ctx.strokeStyle = colorOf(ia, ib)
      ctx.beginPath()
      const a = lPos(ia),
        b = rPos(ib)
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
  }
  // Tie points joined through other photos (blue): over the unused, under the aligned.
  const drawIndirectLines = () => {
    ctx.globalAlpha = 0.35
    ctx.strokeStyle = C_INDIRECT
    for (const [ia, ib] of indirectPairs.value) {
      if (ia >= kpsA.length || ib >= kpsB.length) continue
      ctx.beginPath()
      const a = lPos(ia),
        b = rPos(ib)
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
  }
  if (used) {
    if (!hideUnused.value) drawLines(false) // unused (red) — suppressed when hiding
    drawIndirectLines()
    drawLines(true)
  } else drawLines(true)
  ctx.restore()

  // Dots — coloured by the same aligned/unused status on both panels. Drawn one
  // panel at a time so each pass can clip to its own panel rect (see spillPoints).
  const DOT = 4
  const drawDots = (side) => {
    const rect = side === 'L' ? lcRect : rcRect
    const kps = side === 'L' ? kpsA : kpsB
    const pos = side === 'L' ? lPos : rPos
    ctx.save()
    if (!spillPoints.value) {
      ctx.beginPath()
      ctx.rect(rect.left - panelsRect.left, rect.top - panelsRect.top, rect.width, rect.height)
      ctx.clip()
    }
    const dot = (k, colour) => {
      if (k >= kps.length) return
      const p = pos(k)
      ctx.fillStyle = colour
      ctx.beginPath()
      ctx.arc(p.x, p.y, DOT, 0, Math.PI * 2)
      ctx.fill()
    }
    for (const [ia, ib] of pairs) {
      if (used && hideUnused.value && !used.has(`${ia}:${ib}`)) continue
      dot(side === 'L' ? ia : ib, colorOf(ia, ib))
    }
    for (const [ia, ib] of indirectPairs.value) dot(side === 'L' ? ia : ib, C_INDIRECT)
    ctx.restore()
  }
  drawDots('L')
  drawDots('R')
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let resizeObserver = null
let lastSize = null // { w, h } last non-zero panel size the observer fitted to

onMounted(() => {
  // Only refit on a *real* viewport change — a v-show-hidden tab collapses to 0×0
  // and springs back on reactivation, which must not reset the user's zoom/pan.
  resizeObserver = new ResizeObserver(() => {
    const el = panelsEl.value
    if (!el) return
    const w = el.clientWidth,
      h = el.clientHeight
    if (!w || !h) return
    if (lastSize && lastSize.w === w && lastSize.h === h) return
    lastSize = { w, h }
    fitBoth()
  })
  if (panelsEl.value) resizeObserver.observe(panelsEl.value)
})

onBeforeUnmount(() => resizeObserver?.disconnect())

watch(
  () => props.matches,
  () => drawOverlay(),
  { deep: false },
)
watch(
  () => props.usedKeys,
  () => drawOverlay(),
)
watch(hideUnused, () => drawOverlay())
watch(spillPoints, () => drawOverlay())
watch(
  () => props.keypointsA,
  () => drawOverlay(),
)
watch(
  () => props.keypointsB,
  () => drawOverlay(),
)

function onImgLoad(side) {
  fit(side)
}
</script>

<template>
  <div class="match-viewer">
    <div ref="panelsEl" class="panels" @mousemove="onMouseMove" @mouseup="onMouseUp" @mouseleave="onMouseUp">
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
        <span class="swatch used" /> {{ usedStats.used }} aligned <span class="swatch unused" />
        {{ usedStats.unused }} unused
        <span
          v-if="usedStats.indirect"
          class="legend-indirect"
          title="Tie points both photos see in the model, though this pair never matched them directly: other photos' matches joined them"
          ><span class="swatch indirect" /> {{ usedStats.indirect }} via other photos</span
        >
        <button
          v-if="usedStats.unused"
          class="legend-toggle"
          :class="{ on: hideUnused }"
          :title="hideUnused ? 'Show unused matches' : 'Hide unused (red) matches'"
          @click="hideUnused = !hideUnused"
        >
          {{ hideUnused ? 'Show unused' : 'Hide unused' }}
        </button>
      </span>
      <span v-else class="match-count">{{ matches.length }} tie points</span>
      <label class="spill-toggle" title="Draw a panned image's points even where they overlap the other photo">
        <input v-model="spillPoints" type="checkbox" />
        Points beyond panel
      </label>
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

.panel:active {
  cursor: grabbing;
}

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

.match-legend .swatch:first-child {
  margin-left: 0;
}
.match-legend .legend-indirect {
  margin-left: 6px;
}
.match-legend .swatch.used {
  background: #00e676;
}
.match-legend .swatch.unused {
  background: #ff5252;
}
.match-legend .swatch.indirect {
  background: #40a0ff;
}

.legend-toggle {
  margin-left: 10px;
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  color: var(--text-dim);
  font: inherit;
  font-size: 10px;
  padding: 1px 7px;
  cursor: pointer;
}
.legend-toggle:hover {
  background: var(--hover-bg);
  color: var(--text);
}
.legend-toggle.on {
  border-color: var(--accent);
  color: var(--accent);
}

.spill-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.spill-toggle input {
  margin: 0;
  cursor: pointer;
}
.spill-toggle:hover {
  color: var(--text);
}

.panel-label {
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
