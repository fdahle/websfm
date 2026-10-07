<script>
// Positions survive unmounts for the session, per toolbox id (module scope, not
// <script setup>, which is per instance): leaving and re-entering a tool, or
// switching image tabs, keeps the toolbox where the user put it.
const positions = new Map()
</script>

<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'

// The shell every interactive tool's floating toolbox uses (mask editing, point
// editing, 3D selection, raster measuring, …). THE RULE: the ribbon *chooses* a
// tool; what you do inside the running tool lives here, over the view, and goes
// away with the tool. The shell owns the chrome only — title bar, drag, close (×).
// Keyboard shortcuts (Esc to exit, Delete, …) stay with the owning viewer, which
// already orders them by priority (e.g. Esc clears a selection before leaving).
//
// Drag by the title bar (left button) or with the middle button anywhere on the
// card. Events are stopped at the card so the view underneath never pans, zooms
// or opens a context menu through it.
const props = defineProps({
  // Session-remembered position key; also the default title's aria label source.
  id:    { type: String, required: true },
  title: { type: String, required: true },
  // Accessible toolbar name when the short visible title is not enough on its own.
  ariaLabel: { type: String, default: null },
  // Starting position when nothing is remembered: 'top-left' or 'top-center'.
  anchor: { type: String, default: 'top-left' },
  width: { type: Number, default: null },
  closeTitle: { type: String, default: 'Close (Esc)' },
  // False hides the × (a toolbox whose tool is left via the ribbon only).
  closable: { type: Boolean, default: true },
})
const emit = defineEmits(['close'])

const card = ref(null)
const pos = ref(positions.get(props.id) ?? null)

const style = computed(() => {
  // max-content when no width is given: with left:50% the shrink-to-fit width
  // would be capped at half the view, wrapping a bar that fits comfortably.
  const s = { width: props.width ? props.width + 'px' : 'max-content' }
  if (pos.value) {
    s.left = pos.value.x + 'px'
    s.top = pos.value.y + 'px'
  } else if (props.anchor === 'top-center') {
    s.left = '50%'
    s.top = '12px'
    s.transform = 'translateX(-50%)'
  } else {
    s.left = '12px'
    s.top = '12px'
  }
  return s
})

let dragStart = null
function startDrag(e) {
  const el = card.value
  const parent = el?.offsetParent
  if (!el) return
  // Resolve an anchored (transform-centred) start into absolute px first.
  const x = el.offsetLeft - (pos.value ? 0 : (props.anchor === 'top-center' ? el.offsetWidth / 2 : 0))
  const y = el.offsetTop
  dragStart = { dx: e.clientX - x, dy: e.clientY - y, maxX: (parent?.clientWidth ?? 1e9) - 40, maxY: (parent?.clientHeight ?? 1e9) - 24 }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragUp)
}
function onHeaderDown(e) { if (e.button === 0) startDrag(e) }
function onCardDown(e) {
  if (e.button !== 1) return
  e.preventDefault() // no middle-click autoscroll
  startDrag(e)
}
function onDragMove(e) {
  if (!dragStart) return
  const x = Math.min(dragStart.maxX, Math.max(0, e.clientX - dragStart.dx))
  const y = Math.min(dragStart.maxY, Math.max(0, e.clientY - dragStart.dy))
  pos.value = { x, y }
}
function onDragUp() {
  if (pos.value) positions.set(props.id, pos.value)
  dragStart = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragUp)
}
onBeforeUnmount(onDragUp)
</script>

<template>
  <div
    ref="card"
    class="floating-toolbox"
    role="toolbar"
    :aria-label="ariaLabel || title"
    :style="style"
    @mousedown.stop="onCardDown"
    @pointerdown.stop
    @wheel.stop
    @dblclick.stop
    @contextmenu.stop.prevent
  >
    <div class="ft-header" @mousedown.prevent="onHeaderDown">
      <span class="ft-title">{{ title }}</span>
      <slot name="header" />
      <button v-if="closable" class="ft-close" :title="closeTitle" :aria-label="closeTitle" @click="emit('close')">×</button>
    </div>
    <div class="ft-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.floating-toolbox {
  position: absolute;
  z-index: 15;
  min-width: 150px;
  max-width: calc(100% - 24px);
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  user-select: none;
  /* A normal cursor over the toolbox (the viewport underneath may be a crosshair). */
  cursor: default;
}
.ft-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 10px;
  border-bottom: 1px solid var(--panel-border);
  cursor: grab;
}
.ft-header:active { cursor: grabbing; }
.ft-title {
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}
.ft-close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 15px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
  border-radius: 4px;
}
.ft-close:hover { color: var(--text); background: var(--hover-bg); }
.ft-body { padding: 6px 8px 8px; }
</style>
