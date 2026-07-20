<script setup>
import { ref } from 'vue'

// Floating GCP-editing toolbar shown over the image viewport while the tab is in
// GCP-edit mode — the click-to-mark counterpart of MaskToolbar. It also owns the
// *target selector*: the list lets you switch which GCP a click marks, or drop back
// to "＋ New GCP" so you can keep adding — the owning ViewerImage implements the
// click-to-place action. Draggable by its header; position is module-scoped so it
// sticks across images/tabs for the session.
defineProps({
  // Every GCP in the project [{ id, name }], for the target list.
  allGcps:    { type: Array,  default: () => [] },
  // Id of the currently-selected GCP (a click marks it), or null for "new GCP".
  selectedId: { type: String, default: null },
  // Ids of GCPs already marked on this image (shown with a dot).
  markedIds:  { type: Array,  default: () => [] },
  // What a click acts on — 'image' (mark a pixel observation) or 'map' (set the
  // GCP's ground position). Only changes the instruction wording.
  noun:       { type: String, default: 'image' },
})

const emit = defineEmits(['close', 'select', 'delete'])

// ── Drag (module-scoped position, mirrors MaskToolbar) ───────────────────────────
// Grab either by the header (left button) or by middle-clicking anywhere on the card.
const pos = ref({ x: 12, y: 12 })
let dragStart = null
function startDrag(e) {
  dragStart = { x: e.clientX - pos.value.x, y: e.clientY - pos.value.y }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragUp)
}
// Left button on the header; middle-button (button 1) falls through to onCardDown.
function onHeaderDown(e) { if (e.button === 0) startDrag(e) }
// Middle mouse button drags from anywhere on the card (preventDefault stops the
// browser's middle-click autoscroll).
function onCardDown(e) {
  if (e.button !== 1) return
  e.preventDefault()
  startDrag(e)
}
function onDragMove(e) {
  if (!dragStart) return
  pos.value = { x: Math.max(0, e.clientX - dragStart.x), y: Math.max(0, e.clientY - dragStart.y) }
}
function onDragUp() {
  dragStart = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragUp)
}
</script>

<template>
  <div class="gcp-toolbar" :style="{ left: pos.x + 'px', top: pos.y + 'px' }" @mousedown.stop="onCardDown" @wheel.stop @dblclick.stop @contextmenu.stop.prevent>
    <div class="gt-header" @mousedown.prevent="onHeaderDown">
      <span class="gt-title">GCPs</span>
      <button class="gt-close" title="Exit GCP editing (Esc)" @click="emit('close')">×</button>
    </div>

    <div class="gt-body">
      <div class="gt-line">
        {{ selectedId != null
          ? `Click the ${noun} to ${noun === 'map' ? 'set its position' : 'mark'}:`
          : `Click the ${noun} to add a new GCP` }}
      </div>

      <div class="gt-list">
        <!-- Drop back to new-GCP mode so you can keep adding after one is placed. -->
        <button
          class="gt-new"
          :class="{ active: selectedId == null }"
          @click="emit('select', null)"
        >＋ New GCP</button>

        <div
          v-for="g in allGcps"
          :key="g.id"
          class="gt-item"
          :class="{ active: g.id === selectedId }"
        >
          <button class="gt-pick" :title="g.name" @click="emit('select', g.id)">
            <span class="gt-dot" :class="{ on: markedIds.includes(g.id) }"></span>
            <span class="gt-name">{{ g.name }}</span>
          </button>
          <button class="gt-del" title="Delete this GCP" @click.stop="emit('delete', g.id)">×</button>
        </div>

        <div v-if="!allGcps.length" class="gt-empty">No GCPs yet — click to add one.</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gcp-toolbar {
  position: absolute;
  z-index: 15;
  width: 180px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  padding: 0 8px 8px;
  user-select: none;
  /* Restore a normal cursor over the toolbar (the viewport underneath is crosshair). */
  cursor: default;
}
.gt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 -8px 6px;
  padding: 4px 8px 4px 10px;
  border-bottom: 1px solid var(--panel-border);
  cursor: grab;
}
.gt-header:active { cursor: grabbing; }
.gt-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}
.gt-close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 15px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
  border-radius: 4px;
}
.gt-close:hover { color: var(--text); background: var(--hover-bg); }
.gt-body { padding: 2px; }
.gt-line { font-size: 12px; color: var(--text); margin-bottom: 6px; }
.gt-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 220px;
  overflow-y: auto;
}
.gt-item {
  display: flex;
  align-items: center;
  border-radius: 4px;
  color: var(--text);
}
.gt-item:hover { background: var(--hover-bg); }
.gt-item.active { background: var(--accent); color: #fff; }
.gt-pick {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  text-align: left;
  background: none;
  border: none;
  color: inherit;
  font-size: 12px;
  padding: 4px 6px;
  cursor: pointer;
}
.gt-del {
  flex: 0 0 auto;
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
}
.gt-item:hover .gt-del { opacity: 1; }
.gt-del:hover { color: #ff8a8a; }
.gt-item.active .gt-del { color: rgba(255, 255, 255, 0.8); opacity: 1; }
.gt-item.active .gt-del:hover { color: #fff; }
/* The "＋ New GCP" row is a plain button, not the two-part item. */
.gt-new {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.gt-new:hover { background: var(--hover-bg); }
.gt-new.active { background: var(--accent); color: #fff; }
.gt-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
  border: 1px solid var(--text-dim);
}
.gt-dot.on { background: var(--accent); border-color: var(--accent); }
.gt-item.active .gt-dot.on { background: #fff; border-color: #fff; }
.gt-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-empty { font-size: 11px; color: var(--text-dim); padding: 4px 6px; }
</style>
