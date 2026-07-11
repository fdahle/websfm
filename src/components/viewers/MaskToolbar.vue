<script setup>
import { ref } from 'vue'
import Icon from '../Icon.vue'

// Floating mask-editing toolbar shown over the image viewport while the tab is
// in mask-edit mode. Pure presentation: tool/brush/opacity state lives in the
// owning ViewerImage, which also implements every action. Draggable by its
// header; the position is module-scoped so it sticks across images and tabs
// for the session (not persisted).
const props = defineProps({
  tool:        { type: String,  default: null }, // 'brush' | 'erase' | 'rect' | null (pan)
  brushRadius: { type: Number,  default: 20 },
  opacity:     { type: Number,  default: 0.45 },
  hasMask:     { type: Boolean, default: false },
  canUndo:     { type: Boolean, default: false },
  canRedo:     { type: Boolean, default: false },
})

const emit = defineEmits([
  'set-tool', 'update:brushRadius', 'update:opacity',
  'invert', 'undo', 'redo', 'import', 'clear', 'close',
])

const TOOLS = [
  { id: 'brush', icon: 'brush',  title: 'Brush — paint mask (B)' },
  { id: 'erase', icon: 'eraser', title: 'Eraser — unpaint mask (E)' },
  { id: 'rect',  icon: 'rect',   title: 'Rectangle — drag to mask, hold Alt to erase (R)' },
]

// Clicking the active tool deselects it → pan/zoom without leaving edit mode.
function pickTool(id) {
  emit('set-tool', props.tool === id ? null : id)
}

// ── Drag by the header ─────────────────────────────────────────────────────────
const pos = ref({ x: 12, y: 12 })
let dragStart = null

function onHeaderDown(e) {
  dragStart = { x: e.clientX - pos.value.x, y: e.clientY - pos.value.y }
  window.addEventListener('mousemove', onHeaderMove)
  window.addEventListener('mouseup', onHeaderUp)
}
function onHeaderMove(e) {
  if (!dragStart) return
  pos.value = { x: Math.max(0, e.clientX - dragStart.x), y: Math.max(0, e.clientY - dragStart.y) }
}
function onHeaderUp() {
  dragStart = null
  window.removeEventListener('mousemove', onHeaderMove)
  window.removeEventListener('mouseup', onHeaderUp)
}
</script>

<template>
  <div class="mask-toolbar" :style="{ left: pos.x + 'px', top: pos.y + 'px' }" @mousedown.stop @wheel.stop @dblclick.stop @contextmenu.stop.prevent>
    <div class="mt-header" @mousedown.prevent="onHeaderDown">
      <span class="mt-title">Mask</span>
      <button class="mt-close" title="Exit mask editing (Esc)" @click="emit('close')">×</button>
    </div>

    <div class="mt-row">
      <button
        v-for="t in TOOLS"
        :key="t.id"
        class="mt-btn"
        :class="{ active: tool === t.id }"
        :title="t.title"
        @click="pickTool(t.id)"
      >
        <Icon :name="t.icon" class="mt-icon" />
      </button>
      <span class="mt-gap" />
      <button class="mt-btn" :class="{ disabled: !canUndo }" title="Undo (Ctrl+Z)" @click="canUndo && emit('undo')">
        <Icon name="undo" class="mt-icon" />
      </button>
      <button class="mt-btn" :class="{ disabled: !canRedo }" title="Redo (Ctrl+Shift+Z)" @click="canRedo && emit('redo')">
        <Icon name="redo" class="mt-icon" />
      </button>
    </div>

    <div class="mt-row">
      <button class="mt-btn" title="Invert mask (I)" @click="emit('invert')">
        <Icon name="invert" class="mt-icon" />
      </button>
      <button class="mt-btn" title="Import an image as mask" @click="emit('import')">
        <Icon name="download" class="mt-icon" />
      </button>
      <button class="mt-btn danger" :class="{ disabled: !hasMask }" title="Clear mask (undoable)" @click="hasMask && emit('clear')">
        <Icon name="x" class="mt-icon" />
      </button>
    </div>

    <label class="mt-slider" title="Brush size ([ / ])">
      <span class="mt-label">Size</span>
      <input
        type="range" min="4" max="80" step="1"
        :value="brushRadius"
        @input="emit('update:brushRadius', Number($event.target.value))"
      />
      <span class="mt-val">{{ brushRadius }}</span>
    </label>

    <label class="mt-slider" title="Mask overlay opacity">
      <span class="mt-label">Opacity</span>
      <input
        type="range" min="0.1" max="1" step="0.05"
        :value="opacity"
        @input="emit('update:opacity', Number($event.target.value))"
      />
      <span class="mt-val">{{ Math.round(opacity * 100) }}%</span>
    </label>
  </div>
</template>

<style scoped>
.mask-toolbar {
  position: absolute;
  z-index: 15;
  width: 168px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  padding: 0 8px 8px;
  user-select: none;
}

.mt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 -8px 6px;
  padding: 4px 8px 4px 10px;
  border-bottom: 1px solid var(--panel-border);
  cursor: grab;
}
.mt-header:active { cursor: grabbing; }

.mt-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}

.mt-close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 15px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
  border-radius: 4px;
}
.mt-close:hover { color: var(--text); background: var(--hover-bg); }

.mt-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
}

.mt-gap { flex: 1; }

.mt-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--text);
  cursor: pointer;
  padding: 0;
}
.mt-btn:hover { background: var(--hover-bg); }
.mt-btn.active {
  background: var(--active-bg, var(--hover-bg));
  border-color: var(--accent);
  color: var(--accent);
}
.mt-btn.danger:hover { color: #ff8a8a; }
.mt-btn.disabled { opacity: 0.35; cursor: default; }
.mt-btn.disabled:hover { background: none; color: var(--text); }

.mt-icon { width: 16px; height: 16px; }

.mt-slider {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 10px;
  color: var(--text-dim);
}

.mt-slider input[type='range'] {
  flex: 1;
  min-width: 0;
  accent-color: var(--accent);
}

.mt-label { width: 38px; flex-shrink: 0; }
.mt-val   { width: 30px; text-align: right; font-variant-numeric: tabular-nums; }
</style>
