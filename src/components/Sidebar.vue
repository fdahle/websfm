<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  images: { type: Array, required: true },
  selectedId: { type: String, default: null },
})

const emit = defineEmits(['add-images', 'remove-image', 'select', 'open', 'show-info'])

// Whole-sidebar drag-and-drop (counter avoids false dragleave on children)
const isDragging = ref(false)
let dragCounter = 0

function onDragEnter(e) {
  e.preventDefault()
  dragCounter++
  isDragging.value = true
}

function onDragLeave() {
  if (--dragCounter === 0) isDragging.value = false
}

function onDrop(e) {
  e.preventDefault()
  dragCounter = 0
  isDragging.value = false
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
  if (files.length) emit('add-images', files)
}

// Collapsible sections
const open = ref({ images: true, cameras: false, features: false, matches: false, sparse: false })

function toggle(key) {
  open.value[key] = !open.value[key]
}

// Context menu
const ctxMenu = ref(null) // { x, y, img }

function onRightClick(e, img) {
  e.preventDefault()
  const menuW = 175, menuH = 115
  ctxMenu.value = {
    x: Math.min(e.clientX, window.innerWidth - menuW),
    y: Math.min(e.clientY, window.innerHeight - menuH),
    img,
  }
}

function closeCtxMenu() {
  ctxMenu.value = null
}

function ctxOpen() { emit('open', ctxMenu.value.img.id); closeCtxMenu() }
function ctxInfo()  { emit('show-info', ctxMenu.value.img.id); closeCtxMenu() }
function ctxRemove() { emit('remove-image', ctxMenu.value.img.id); closeCtxMenu() }

onMounted(() => document.addEventListener('click', closeCtxMenu))
onBeforeUnmount(() => document.removeEventListener('click', closeCtxMenu))
</script>

<template>
  <aside
    class="sidebar"
    :class="{ dragging: isDragging }"
    @dragover.prevent
    @dragenter="onDragEnter"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Drop overlay -->
    <div v-if="isDragging" class="drop-overlay">Drop images here</div>

    <!-- Images -->
    <div class="section">
      <button class="section-hd" @click="toggle('images')">
        <span class="chevron">{{ open.images ? '▾' : '▸' }}</span>
        <span class="section-name">Images</span>
        <span v-if="images.length" class="badge">{{ images.length }}</span>
      </button>
      <ul v-if="open.images" class="item-list">
        <li
          v-for="img in images"
          :key="img.id"
          class="list-item"
          :class="{ selected: img.id === selectedId }"
          :title="img.name"
          @click="emit('select', img.id)"
          @dblclick="emit('open', img.id)"
          @contextmenu="onRightClick($event, img)"
        >
          <span class="status-dot" :class="img.kpStatus"></span>
          <span class="item-name">{{ img.name }}</span>
        </li>
        <li v-if="!images.length" class="empty">No images — drop here to add</li>
      </ul>
    </div>

    <!-- Camera Models -->
    <div class="section">
      <button class="section-hd" @click="toggle('cameras')">
        <span class="chevron">{{ open.cameras ? '▾' : '▸' }}</span>
        <span class="section-name">Camera Models</span>
      </button>
      <div v-if="open.cameras" class="placeholder">No camera models yet</div>
    </div>

    <!-- Features -->
    <div class="section">
      <button class="section-hd" @click="toggle('features')">
        <span class="chevron">{{ open.features ? '▾' : '▸' }}</span>
        <span class="section-name">Features</span>
      </button>
      <div v-if="open.features" class="placeholder">No features extracted yet</div>
    </div>

    <!-- Matches -->
    <div class="section">
      <button class="section-hd" @click="toggle('matches')">
        <span class="chevron">{{ open.matches ? '▾' : '▸' }}</span>
        <span class="section-name">Matches</span>
      </button>
      <div v-if="open.matches" class="placeholder">No matches computed yet</div>
    </div>

    <!-- Sparse Model -->
    <div class="section">
      <button class="section-hd" @click="toggle('sparse')">
        <span class="chevron">{{ open.sparse ? '▾' : '▸' }}</span>
        <span class="section-name">Sparse Model</span>
      </button>
      <div v-if="open.sparse" class="placeholder">No reconstruction yet</div>
    </div>

    <!-- Context menu -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        class="ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item" @click="ctxOpen">Open in tab</button>
        <button class="ctx-item" @click="ctxInfo">Show information</button>
        <div class="ctx-sep"></div>
        <button class="ctx-item danger" @click="ctxRemove">Remove</button>
      </div>
    </Teleport>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 220px;
  flex-shrink: 0;
  height: 100%;
  background: var(--panel);
  border-right: 1px solid var(--panel-border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  position: relative;
}

/* Drop overlay */
.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: none;
  background: rgba(14, 99, 156, 0.12);
  border: 2px dashed var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
}

/* Sections */
.section {
  border-bottom: 1px solid var(--panel-border);
}

.section-hd {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  color: var(--text-dim);
  font: inherit;
}

.section-hd:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.chevron {
  font-size: 10px;
  width: 10px;
  flex-shrink: 0;
}

.section-name {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  flex: 1;
}

.badge {
  font-size: 11px;
  color: var(--text-dim);
  background: var(--hover-bg);
  padding: 1px 6px;
  border-radius: 8px;
}

.placeholder {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--text-dim);
  font-style: italic;
}

/* Image list */
.item-list {
  list-style: none;
  padding: 2px 0 6px;
}

.list-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 12px;
  cursor: pointer;
  font-size: 12px;
  height: 24px;
}

.list-item:hover {
  background: var(--hover-bg);
}

.list-item.selected {
  background: rgba(14, 99, 156, 0.25);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-dim);
  opacity: 0.5;
}

.status-dot.done    { background: #4c9; opacity: 1; }
.status-dot.error   { background: #e55; opacity: 1; }
.status-dot.running { background: #fa0; opacity: 1; animation: pulse 0.9s ease-in-out infinite; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.35; }
}

.item-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}

.empty {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-dim);
  font-style: italic;
}

/* Context menu */
.ctx-menu {
  position: fixed;
  z-index: 300;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 4px;
  min-width: 165px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}

.ctx-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.ctx-item:hover {
  background: var(--hover-bg);
}

.ctx-item.danger       { color: #e55; }
.ctx-item.danger:hover { background: rgba(220, 80, 80, 0.12); }

.ctx-sep {
  height: 1px;
  background: var(--panel-border);
  margin: 4px 0;
}
</style>
