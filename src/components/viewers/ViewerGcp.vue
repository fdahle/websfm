<script setup>
import { ref, computed } from 'vue'

// Multi-image GCP inspector: one panel per registered observation, each cropped
// and zoomed to centre the GCP's marked pixel, with a crosshair marker. Opened
// by double-clicking a GCP in the sidebar. Read-only — marking still happens in
// the full image view (a panel's "Open" jumps there).
const props = defineProps({
  gcp:    { type: Object, default: null },   // { id, name, x, y, z, observations }
  images: { type: Array,  default: () => [] }, // full image list (resolve imageId → url)
  // Accuracy-report entry for this GCP: { observations: [{ imageId, reprojPx }] }.
  report: { type: Object, default: null },
})
const emit = defineEmits(['jump-to-image'])

// Shared zoom across all panels (native px → screen px). Kept consistent so the
// eye can compare the same-size neighbourhood in every image.
const zoom = ref(2)
const MIN_ZOOM = 0.25
const MAX_ZOOM = 16
function zoomIn()  { zoom.value = Math.min(MAX_ZOOM, +(zoom.value * 1.5).toFixed(3)) }
function zoomOut() { zoom.value = Math.max(MIN_ZOOM, +(zoom.value / 1.5).toFixed(3)) }

const imageById = computed(() => {
  const m = new Map()
  for (const img of props.images) m.set(img.id, img)
  return m
})

function reprojFor(imageId) {
  return props.report?.observations?.find((o) => o.imageId === imageId)?.reprojPx ?? null
}

// Observations that resolve to a loaded image (unmatched ones — image not yet
// added — are surfaced as a count, not a panel).
const panels = computed(() => {
  const out = []
  for (const obs of props.gcp?.observations || []) {
    const img = obs.imageId != null ? imageById.value.get(obs.imageId) : null
    if (!img || obs.px == null || obs.py == null) continue
    out.push({
      imageId: obs.imageId,
      name: img.name,
      url: img.url,
      px: obs.px,
      py: obs.py,
      reprojPx: reprojFor(obs.imageId),
    })
  }
  return out
})

const missingCount = computed(() =>
  (props.gcp?.observations || []).filter((o) => o.imageId == null && o.px != null).length,
)

// Place the marked pixel at the panel's centre. The image's top-left corner is
// pinned to the viewport centre (left/top: 50%, transform-origin: 0 0); the
// transform then maps image point (px,py) back onto that centre:
// scale first (→ px·s, py·s), then translate by −(px·s, py·s) → (0,0) = centre.
function imgStyle(p) {
  const s = zoom.value
  return {
    transform: `translate(${-p.px * s}px, ${-p.py * s}px) scale(${s})`,
  }
}

function fmtCoord(v) {
  if (v == null || Number.isNaN(v)) return '—'
  return Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(6)
}
</script>

<template>
  <div class="gcp-view">
    <div class="gcp-hd">
      <div class="gcp-hd-main">
        <span class="gcp-title">{{ gcp?.name ?? 'GCP' }}</span>
        <span class="gcp-coords">
          X {{ fmtCoord(gcp?.x) }} · Y {{ fmtCoord(gcp?.y) }}<template v-if="gcp?.z != null"> · Z {{ fmtCoord(gcp?.z) }}</template>
        </span>
        <span class="gcp-count">{{ panels.length }} image{{ panels.length === 1 ? '' : 's' }}</span>
        <span v-if="missingCount" class="gcp-missing" :title="`${missingCount} observation(s) reference images that aren't loaded yet`">
          +{{ missingCount }} not loaded
        </span>
      </div>
      <div class="gcp-zoom">
        <button class="zoom-btn" title="Zoom out" @click="zoomOut">−</button>
        <span class="zoom-val">{{ zoom.toFixed(2) }}×</span>
        <button class="zoom-btn" title="Zoom in" @click="zoomIn">+</button>
      </div>
    </div>

    <div v-if="panels.length" class="gcp-grid">
      <div v-for="p in panels" :key="p.imageId" class="gcp-panel">
        <div class="panel-viewport">
          <img class="panel-img" :src="p.url" :alt="p.name" :style="imgStyle(p)" draggable="false" />
          <div class="panel-crosshair">
            <span class="ch-h"></span>
            <span class="ch-v"></span>
            <span class="ch-dot"></span>
          </div>
        </div>
        <div class="panel-cap">
          <button class="panel-open" :title="`Open ${p.name}`" @click="emit('jump-to-image', { imageId: p.imageId })">{{ p.name }}</button>
          <span v-if="p.reprojPx != null" class="panel-reproj" title="Reprojection error (px)">{{ p.reprojPx.toFixed(1) }}px</span>
        </div>
      </div>
    </div>
    <div v-else class="gcp-empty">
      This GCP has no observations on loaded images. Right-click a position in an image tab to mark it.
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
.gcp-hd-main { display: flex; align-items: baseline; gap: 12px; min-width: 0; flex-wrap: wrap; }
.gcp-title { font-size: 14px; font-weight: 600; }
.gcp-coords { font-size: 12px; color: var(--text-dim, #9a9aa5); font-variant-numeric: tabular-nums; }
.gcp-count { font-size: 12px; color: var(--text-dim, #9a9aa5); }
.gcp-missing { font-size: 11px; color: #e0a030; }

.gcp-zoom { flex: none; display: flex; align-items: center; gap: 6px; }
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
.zoom-btn:hover { background: var(--panel-hover, #2a2a33); }
.zoom-val { font-size: 11px; color: var(--text-dim, #9a9aa5); min-width: 38px; text-align: center; font-variant-numeric: tabular-nums; }

.gcp-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
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
.panel-viewport {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  background:
    repeating-conic-gradient(#1a1a20 0% 25%, #202028 0% 50%) 50% / 20px 20px;
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
.ch-h, .ch-v { position: absolute; background: rgba(255, 80, 80, 0.85); }
.ch-h { left: 0; right: 0; top: 50%; height: 1px; transform: translateY(-0.5px); }
.ch-v { top: 0; bottom: 0; left: 50%; width: 1px; transform: translateX(-0.5px); }
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
.panel-open:hover { text-decoration: underline; }
.panel-reproj { flex: none; font-size: 10px; color: var(--text-dim, #9a9aa5); font-variant-numeric: tabular-nums; }

.gcp-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--text-dim, #9a9aa5);
  font-size: 13px;
  text-align: center;
}
</style>
