<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useImagesStore } from '../../stores/useImagesStore.js'
import { useGcpsStore } from '../../stores/useGcpsStore.js'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'
import { useGcpPlaces } from '../../composables/useGcpPlaces.js'
import { t } from '../../composables/useI18n.js'
import { matches } from '../../core/help/shortcuts.js'
import { keyLabel } from '../../utils/shortcutLabels.js'
import { viewerMayHandleKey } from '../../utils/keyRouting.js'

// Multi-image GCP view: one square per photo, cropped and zoomed around the GCP's mark,
// with a crosshair. Opened by double-clicking a GCP in the sidebar.
//
// - A mark is moved by dragging in its square (the crosshair follows; the mark lands
//   where it is let go), or dropped with ×; a mark Detect targets placed is accepted
//   with ✓ (it is then yours: a later run does not replace it), as is a dragged one.
// - Below them, dashed squares show the photos the point is LIKELY in but not marked
//   yet: where the model puts it, from its marks (two or more) or from its X, Y, Z
//   through the georeference (useGcpPlaces). A click where the point is, or the
//   crosshair dragged onto it, marks it there; ✓ marks it at the crosshair; × hides
//   the square. Only a mark is ever stored, never a prediction.
// - The keys (core/help/shortcuts.js gcpMarks.*) walk the detected marks, then the
//   likely places: A accepts or marks, X removes or hides, S moves on.
const props = defineProps({
  gcp: { type: Object, default: null }, // { id, name, x, y, z, observations }
  images: { type: Array, default: () => [] }, // full image list (resolve imageId → url)
  // Accuracy-report entry for this GCP: { observations: [{ imageId, reprojPx }], estimate }.
  report: { type: Object, default: null },
  // The tab is the one shown: only then do its keys act and its likely places update.
  active: { type: Boolean, default: true },
})
// set-mark { gcpId, imageId, imageName, px, py }: a mark placed or moved by hand here.
const emit = defineEmits(['jump-to-image', 'remove-observation', 'set-mark'])

// Shared zoom across all squares (native px → screen px), so the eye compares the
// same-size neighbourhood in every photo.
const zoom = ref(2)
const MIN_ZOOM = 0.25
const MAX_ZOOM = 16
function zoomIn() {
  zoom.value = Math.min(MAX_ZOOM, +(zoom.value * 1.5).toFixed(3))
}
function zoomOut() {
  zoom.value = Math.max(MIN_ZOOM, +(zoom.value / 1.5).toFixed(3))
}

const imageById = computed(() => {
  const m = new Map()
  for (const img of props.images) m.set(img.id, img)
  return m
})

// A dead blob: URL is healed from the OPFS copy (CLAUDE.md: every <img> on img.url).
const imagesStore = useImagesStore()

// The photo's pixel size, given to its <img> before it loads: an unloaded image is
// 0 × 0, and centring the mark moves that empty box thousands of px off the square, so
// a lazy image would count as out of view and never load (a photo seen before came from
// the cache, which skips the check).
const sizeOf = (img) => ({ w: img.meta?.width ?? null, h: img.meta?.height ?? null })

function reprojFor(imageId) {
  return props.report?.observations?.find((o) => o.imageId === imageId)?.reprojPx ?? null
}

// Marks that resolve to a photo in the project (the others are counted, not shown).
const panels = computed(() => {
  const out = []
  for (const obs of props.gcp?.observations || []) {
    const img = obs.imageId != null ? imageById.value.get(obs.imageId) : null
    if (!img || obs.px == null || obs.py == null) continue
    out.push({
      key: `m:${obs.imageId}`,
      imageId: obs.imageId,
      name: img.name,
      url: img.url,
      ...sizeOf(img),
      px: obs.px,
      py: obs.py,
      reprojPx: reprojFor(obs.imageId),
      detected: obs.source === 'detected' ? (obs.score ?? 0) : null,
    })
  }
  return out
})

// Accept a detected mark where it is: it loses its flag and counts as placed by hand.
const gcpsStore = useGcpsStore()
const detectedPanels = computed(() => panels.value.filter((p) => p.detected != null))
function accept(p) {
  gcpsStore.setObservation(props.gcp.id, p.imageId, p.name, p.px, p.py, null)
}
function acceptAll() {
  for (const p of detectedPanels.value) accept(p)
}
function setMark(p, px, py) {
  emit('set-mark', { gcpId: props.gcp.id, imageId: p.imageId, imageName: p.name, px, py })
}

// ── Likely places ─────────────────────────────────────────────────────────────
const recon = useReconstructionStore()
const { placesFor } = useGcpPlaces()
const likely = ref({ from: null, viewCount: 0, rejected: 0, places: [] })
// Hidden with × for this GCP, while the tab is open.
const dismissed = ref(new Set())
// Squares shown at first; a GCP in a large block can be in hundreds of photos.
const LIKELY_PAGE = 24
const likelyLimit = ref(LIKELY_PAGE)
let likelyToken = 0
// What a prediction is made from: the marks and the coordinates, the model, the fit.
const likelyKey = computed(() => {
  const g = props.gcp
  if (!g || !props.active) return null
  return JSON.stringify([
    g.id,
    g.role,
    g.enabled,
    g.x,
    g.y,
    g.z,
    (g.observations ?? []).map((o) => [o.imageId, o.px, o.py]),
    recon.mainSparseCloud?.id ?? null,
    recon.mainSparseCloud?.createdAt ?? null,
    recon.validGeoref?.evidenceKey ?? null,
  ])
})
watch(
  likelyKey,
  async (key) => {
    if (key == null) return
    const token = ++likelyToken
    const r = await placesFor(props.gcp)
    if (token === likelyToken) likely.value = r
  },
  { immediate: true },
)
watch(
  () => props.gcp?.id,
  () => {
    dismissed.value = new Set()
    skipped.value = new Set()
    likelyLimit.value = LIKELY_PAGE
  },
)
const likelyAll = computed(() =>
  likely.value.places
    .filter((p) => !dismissed.value.has(p.imageId))
    .flatMap((p) => {
      const img = imageById.value.get(p.imageId)
      return img
        ? [
            {
              key: `l:${p.imageId}`,
              imageId: p.imageId,
              name: img.name,
              url: img.url,
              ...sizeOf(img),
              px: p.px,
              py: p.py,
            },
          ]
        : []
    }),
)
const likelyPanels = computed(() => likelyAll.value.slice(0, likelyLimit.value))
const likelySource = computed(() => {
  const r = likely.value
  if (r.from === 'coordinates') return t('gcps.view.fromCoordinates')
  if (r.from !== 'marks') return ''
  return r.rejected
    ? t('gcps.view.fromMarksRejected', { used: r.viewCount - r.rejected, n: r.viewCount, rejected: r.rejected })
    : t('gcps.view.fromMarks', { n: r.viewCount })
})
// Why no likely place shows, when the next step would give some.
const likelyWhy = computed(() => {
  if (likely.value.from || !props.gcp || props.gcp.enabled === false) return null
  if (!recon.mainSparseCloud?.cameras?.size) return 'noModel'
  return panels.value.length === 1 ? 'oneMark' : null
})
function dismiss(p) {
  dismissed.value = new Set([...dismissed.value, p.imageId])
}
function place(p) {
  setMark(p, p.px, p.py)
}

// ── Keyboard review: the detected marks, then the likely places ───────────────
// One is highlighted, the first left after those skipped; A accepts or marks it, X
// removes or hides it, S moves on.
const queue = computed(() => [...detectedPanels.value, ...likelyPanels.value])
const skipped = ref(new Set())
const current = computed(() => queue.value.find((p) => !skipped.value.has(p.key)) ?? queue.value[0] ?? null)
const gridEl = ref(null)
// Scrolled to only after a key: opening the view shows the marks first.
let keyed = false
watch(current, async (p) => {
  if (!p || !props.active || !keyed) return
  keyed = false
  await nextTick()
  gridEl.value?.querySelector(`[data-key="${p.key}"]`)?.scrollIntoView?.({ block: 'nearest' })
})
function onKey(e) {
  if (!props.active || !props.gcp || !viewerMayHandleKey(e)) return
  const p = current.value
  if (matches(e, 'gcpMarks.acceptAll')) {
    if (!detectedPanels.value.length) return
    acceptAll()
  } else if (matches(e, 'gcpMarks.accept')) {
    if (!p) return
    if (p.detected != null) accept(p)
    else place(p)
  } else if (matches(e, 'gcpMarks.reject')) {
    if (!p) return
    if (p.detected != null) emit('remove-observation', { gcpId: props.gcp.id, imageId: p.imageId })
    else dismiss(p)
  } else if (matches(e, 'gcpMarks.skip')) {
    if (!p) return
    const next = new Set(skipped.value)
    next.add(p.key)
    // Past the last one, start again from the first.
    skipped.value = queue.value.every((q) => next.has(q.key)) ? new Set() : next
  } else return
  keyed = true
  e.preventDefault()
}

// ── Dragging a mark, clicking a likely place ──────────────────────────────────
// The crosshair follows the pointer by the drag; let go, and the mark lands there
// (its square then centres on it again). A click without a drag marks a likely place
// where it was clicked; on a mark it does nothing, so a stray click moves nothing.
const DRAG_MIN = 3 // px on screen before a press counts as a drag
const drag = ref(null) // { key, dx, dy }
let press = null
function onPanelDown(p, e) {
  if (e.button !== 0) return
  e.preventDefault()
  const rect = e.currentTarget.getBoundingClientRect()
  press = { p, x: e.clientX, y: e.clientY, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 }
  window.addEventListener('mousemove', onPanelMove)
  window.addEventListener('mouseup', onPanelUp)
}
function onPanelMove(e) {
  if (!press) return
  const dx = e.clientX - press.x,
    dy = e.clientY - press.y
  if (drag.value || Math.hypot(dx, dy) >= DRAG_MIN) drag.value = { key: press.p.key, dx, dy }
}
function onPanelUp(e) {
  window.removeEventListener('mousemove', onPanelMove)
  window.removeEventListener('mouseup', onPanelUp)
  const pr = press,
    d = drag.value
  press = null
  drag.value = null
  if (!pr || !props.gcp) return
  const s = zoom.value
  if (d) setMark(pr.p, pr.p.px + d.dx / s, pr.p.py + d.dy / s)
  else if (pr.p.key.startsWith('l:'))
    setMark(pr.p, pr.p.px + (e.clientX - pr.cx) / s, pr.p.py + (e.clientY - pr.cy) / s)
}
function crosshairStyle(p) {
  const d = drag.value
  return d && d.key === p.key ? { transform: `translate(${d.dx}px, ${d.dy}px)` } : null
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('mousemove', onPanelMove)
  window.removeEventListener('mouseup', onPanelUp)
})

const missingCount = computed(
  () => (props.gcp?.observations || []).filter((o) => o.imageId == null && o.px != null).length,
)

// Place the marked pixel at the square's centre. The image's top-left corner is
// pinned to the viewport centre (left/top: 50%, transform-origin: 0 0); the
// transform then maps image point (px,py) back onto that centre:
// scale first (→ px·s, py·s), then translate by −(px·s, py·s) → (0,0) = centre.
function imgStyle(p) {
  const s = zoom.value
  return {
    transform: `translate(${-p.px * s}px, ${-p.py * s}px) scale(${s})`,
    ...(p.w && p.h ? { width: `${p.w}px`, height: `${p.h}px` } : {}),
  }
}

function fmtCoord(v) {
  if (v == null || Number.isNaN(v)) return '—'
  return Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(6)
}
const hasXY = computed(() => Number.isFinite(props.gcp?.x) && Number.isFinite(props.gcp?.y))
const coordsText = computed(() => {
  const g = props.gcp
  if (!hasXY.value) return t('gcps.view.noCoords')
  const xy = { x: fmtCoord(g.x), y: fmtCoord(g.y) }
  return g.z != null ? t('gcps.view.coordsZ', { ...xy, z: fmtCoord(g.z) }) : t('gcps.view.coords', xy)
})
// For a point without coordinates: where the georeferenced model puts it (a hint).
const estimateText = computed(() => {
  const e = props.report?.estimate
  if (hasXY.value || !e) return ''
  return t('gcps.view.estimate', { x: fmtCoord(e[0]), y: fmtCoord(e[1]), z: fmtCoord(e[2]) })
})
</script>

<template>
  <div class="gcp-view">
    <div class="gcp-hd">
      <div class="gcp-hd-main">
        <span class="gcp-title">{{ gcp?.name ?? t('gcps.view.fallbackName') }}</span>
        <span class="gcp-coords">{{ coordsText }}</span>
        <span v-if="estimateText" class="gcp-coords gcp-estimate" :title="t('gcps.table.estimateTip')">{{
          estimateText
        }}</span>
        <span class="gcp-count">{{ t('gcps.view.photos', { n: panels.length }) }}</span>
        <span v-if="missingCount" class="gcp-missing" :title="t('gcps.view.notLoadedTip', { n: missingCount })">
          {{ t('gcps.view.notLoaded', { n: missingCount }) }}
        </span>
      </div>
      <button
        v-if="detectedPanels.length"
        class="btn btn-sm"
        :title="t('gcps.view.acceptAllTip', { key: keyLabel('gcpMarks.acceptAll') })"
        @click="acceptAll"
      >
        {{ t('gcps.view.acceptAll', { n: detectedPanels.length }) }}
      </button>
      <div class="gcp-zoom">
        <button class="zoom-btn" :title="t('gcps.view.zoomOut')" @click="zoomOut">−</button>
        <span class="zoom-val">{{ zoom.toFixed(2) }}×</span>
        <button class="zoom-btn" :title="t('gcps.view.zoomIn')" @click="zoomIn">+</button>
      </div>
    </div>

    <div ref="gridEl" class="gcp-body">
      <div v-if="panels.length" class="gcp-grid">
        <div
          v-for="p in panels"
          :key="p.key"
          class="gcp-panel"
          :class="{ current: current && p.key === current.key }"
          :data-key="p.key"
          :data-image-id="p.imageId"
        >
          <div class="panel-viewport" :title="t('gcps.view.dragTip')" @mousedown="onPanelDown(p, $event)">
            <img
              class="panel-img"
              :src="p.url"
              :alt="p.name"
              :style="imgStyle(p)"
              draggable="false"
              decoding="async"
              @error="imagesStore.reportImageLoadError(p.imageId)"
            />
            <div class="panel-crosshair" :style="crosshairStyle(p)">
              <span class="ch-h"></span>
              <span class="ch-v"></span>
              <span class="ch-dot"></span>
            </div>
          </div>
          <div class="panel-cap">
            <button
              class="panel-open"
              :title="t('gcps.view.open', { name: p.name })"
              @click="emit('jump-to-image', { imageId: p.imageId })"
            >
              {{ p.name }}
            </button>
            <span v-if="p.detected != null" class="panel-detected" :title="t('gcps.view.detectedTip')">{{
              t('gcps.view.detected', { score: p.detected })
            }}</span>
            <span v-if="p.reprojPx != null" class="panel-reproj" :title="t('gcps.view.reprojTip')">{{
              t('gcps.view.reproj', { px: p.reprojPx })
            }}</span>
            <button
              v-if="p.detected != null"
              class="panel-accept"
              :title="t('gcps.view.accept', { name: p.name, key: keyLabel('gcpMarks.accept') })"
              @click="accept(p)"
            >
              ✓
            </button>
            <button
              class="panel-remove"
              :title="
                p.detected != null
                  ? t('gcps.view.removeKey', { name: p.name, key: keyLabel('gcpMarks.reject') })
                  : t('gcps.view.remove', { name: p.name })
              "
              @click="emit('remove-observation', { gcpId: gcp.id, imageId: p.imageId })"
            >
              ×
            </button>
          </div>
        </div>
      </div>
      <div v-else class="gcp-empty">{{ t('gcps.view.empty') }}</div>

      <template v-if="likelyAll.length">
        <div class="likely-hd">
          <span class="likely-title">{{ t('gcps.view.likely', { n: likelyAll.length }) }}</span>
          <span class="likely-from">{{ likelySource }}</span>
          <span class="likely-hint">{{ t('gcps.view.likelyHint') }}</span>
        </div>
        <div class="gcp-grid">
          <div
            v-for="p in likelyPanels"
            :key="p.key"
            class="gcp-panel likely"
            :class="{ current: current && p.key === current.key }"
            :data-key="p.key"
            :data-image-id="p.imageId"
          >
            <div
              class="panel-viewport"
              :title="t('gcps.view.likelyTip', { name: p.name })"
              @mousedown="onPanelDown(p, $event)"
            >
              <img
                class="panel-img"
                :src="p.url"
                :alt="p.name"
                :style="imgStyle(p)"
                draggable="false"
                decoding="async"
                :loading="p.w && p.h ? 'lazy' : 'eager'"
                @error="imagesStore.reportImageLoadError(p.imageId)"
              />
              <div class="panel-crosshair" :style="crosshairStyle(p)">
                <span class="ch-h"></span>
                <span class="ch-v"></span>
                <span class="ch-dot"></span>
              </div>
            </div>
            <div class="panel-cap">
              <button
                class="panel-open"
                :title="t('gcps.view.open', { name: p.name })"
                @click="emit('jump-to-image', { imageId: p.imageId })"
              >
                {{ p.name }}
              </button>
              <button
                class="panel-accept"
                :title="t('gcps.view.place', { key: keyLabel('gcpMarks.accept') })"
                @click="place(p)"
              >
                ✓
              </button>
              <button
                class="panel-remove"
                :title="t('gcps.view.dismiss', { key: keyLabel('gcpMarks.reject') })"
                @click="dismiss(p)"
              >
                ×
              </button>
            </div>
          </div>
        </div>
        <button
          v-if="likelyAll.length > likelyPanels.length"
          class="btn btn-sm likely-more"
          @click="likelyLimit += LIKELY_PAGE"
        >
          {{ t('gcps.view.showMore', { n: Math.min(LIKELY_PAGE, likelyAll.length - likelyPanels.length) }) }}
        </button>
      </template>
      <div v-else-if="likelyWhy" class="likely-none">{{ t('gcps.view.likelyNone', { why: likelyWhy }) }}</div>
    </div>
  </div>
</template>

<style scoped>
.gcp-view {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg, #14141a);
  color: var(--text, #e8e8ec);
}
.gcp-hd {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border, #2a2a33);
  background: var(--panel, #1e1e24);
}
.gcp-hd-main {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
  flex-wrap: wrap;
}
.gcp-title {
  font-size: 14px;
  font-weight: 600;
}
.gcp-coords {
  font-size: 12px;
  color: var(--text-dim, #9a9aa5);
  font-variant-numeric: tabular-nums;
}
.gcp-count {
  font-size: 12px;
  color: var(--text-dim, #9a9aa5);
}
.gcp-missing {
  font-size: 11px;
  color: #e0a030;
}

.gcp-zoom {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
.zoom-btn {
  width: 24px;
  height: 24px;
  border: 1px solid var(--border, #2a2a33);
  border-radius: 4px;
  background: var(--bg, #14141a);
  color: var(--text, #e8e8ec);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.zoom-btn:hover {
  background: var(--panel-hover, #2a2a33);
}
.zoom-val {
  font-size: 11px;
  color: var(--text-dim, #9a9aa5);
  min-width: 38px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.gcp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
  padding: 14px;
  align-content: start;
}
.gcp-panel {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border, #2a2a33);
  border-radius: 6px;
  overflow: hidden;
  background: #0d0d12;
}
/* The detected mark the keys act on (A accept, X remove, S next). */
.gcp-panel.current {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.panel-viewport {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  background: repeating-conic-gradient(#1a1a20 0% 25%, #202028 0% 50%) 50% / 20px 20px;
}
.panel-img {
  position: absolute;
  top: 50%;
  left: 50%;
  max-width: none;
  transform-origin: 0 0;
  image-rendering: auto;
  user-select: none;
  -webkit-user-drag: none;
}
.panel-crosshair {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.ch-h,
.ch-v {
  position: absolute;
  background: rgba(255, 80, 80, 0.85);
}
.ch-h {
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  transform: translateY(-0.5px);
}
.ch-v {
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-0.5px);
}
.ch-dot {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  border: 1.5px solid rgba(255, 80, 80, 0.95);
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
}
.panel-cap {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-top: 1px solid var(--border, #2a2a33);
  background: var(--panel, #1e1e24);
}
.panel-open {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  background: none;
  border: none;
  color: var(--accent, #5cf);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  padding: 0;
}
.panel-open:hover {
  text-decoration: underline;
}
.panel-detected {
  flex: none;
  font-size: 10px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.panel-reproj {
  flex: none;
  font-size: 10px;
  color: var(--text-dim, #9a9aa5);
  font-variant-numeric: tabular-nums;
}
.panel-remove {
  flex: none;
  background: none;
  border: none;
  color: var(--text-dim, #9a9aa5);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
.panel-remove:hover {
  color: #e55;
}
.panel-accept {
  flex: none;
  background: none;
  border: none;
  color: var(--text-dim, #9a9aa5);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
.panel-accept:hover {
  color: var(--accent);
}

.gcp-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--text-dim, #9a9aa5);
  font-size: 13px;
  text-align: center;
}
.gcp-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.gcp-estimate {
  font-style: italic;
}
.panel-viewport {
  cursor: grab;
}
.panel-viewport:active {
  cursor: grabbing;
}
/* A likely place: not a mark yet. */
.gcp-panel.likely {
  border-style: dashed;
}
.gcp-panel.likely .panel-viewport {
  cursor: crosshair;
}
.gcp-panel.likely .ch-h,
.gcp-panel.likely .ch-v {
  background: transparent;
  border-color: rgba(90, 170, 255, 0.9);
  border-style: dashed;
  border-width: 0;
}
.gcp-panel.likely .ch-h {
  border-top-width: 1px;
}
.gcp-panel.likely .ch-v {
  border-left-width: 1px;
}
.gcp-panel.likely .ch-dot {
  border-color: rgba(90, 170, 255, 0.95);
  border-style: dashed;
}
.likely-hd {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  padding: 4px 14px 0;
}
.likely-title {
  font-size: 13px;
  font-weight: 600;
}
.likely-from,
.likely-hint {
  font-size: 12px;
  color: var(--text-dim, #9a9aa5);
}
.likely-more {
  margin: 0 14px 14px;
}
.likely-none {
  padding: 0 14px 14px;
  font-size: 12px;
  color: var(--text-dim, #9a9aa5);
}
</style>
