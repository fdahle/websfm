<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  images:     { type: Array,  required: true },
  selectedId: { type: String, default: null },
})

const emit = defineEmits(['add-images', 'remove-image', 'select', 'open', 'show-info', 'delete-keypoints'])

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
const open = ref({ images: true, cameras: false })

function toggle(key) {
  open.value[key] = !open.value[key]
}

// Per-image expand state
const expanded = ref({})

function toggleExpand(id) {
  if (expanded.value[id]) delete expanded.value[id]
  else expanded.value[id] = true
}

// Multi-select: local array of selected ids + anchor for shift-range
const localSelected = ref([])
const anchor = ref(null)
let suppressWatch = false

function handleItemClick(e, img) {
  suppressWatch = true
  if (e.shiftKey && anchor.value !== null) {
    const ids = props.images.map((i) => i.id)
    const ai = ids.indexOf(anchor.value)
    const ci = ids.indexOf(img.id)
    const [from, to] = ai <= ci ? [ai, ci] : [ci, ai]
    localSelected.value = ids.slice(from, to + 1)
  } else {
    localSelected.value = [img.id]
    anchor.value = img.id
  }
  emit('select', img.id)
}

watch(() => props.selectedId, (newId) => {
  if (suppressWatch) { suppressWatch = false; return }
  localSelected.value = newId ? [newId] : []
  anchor.value = newId
})

// Context menu
const ctxMenu = ref(null) // { x, y, img }

// The set of images the context menu should act on:
// multi if right-clicking within an existing multi-selection, else just the one image.
const ctxTargets = computed(() => {
  if (!ctxMenu.value) return []
  const { img } = ctxMenu.value
  if (localSelected.value.length > 1 && localSelected.value.includes(img.id))
    return props.images.filter((i) => localSelected.value.includes(i.id))
  return [img]
})

const ctxIsMulti    = computed(() => ctxTargets.value.length > 1)
const ctxHasKp      = computed(() => ctxTargets.value.some((i) => i.kpStatus === 'done'))

function onRightClick(e, img) {
  e.preventDefault()
  // Right-clicking outside the current selection collapses to that single image
  if (!localSelected.value.includes(img.id)) {
    localSelected.value = [img.id]
    anchor.value = img.id
    suppressWatch = true
    emit('select', img.id)
  }
  const menuW = 190, menuH = 160
  ctxMenu.value = {
    x: Math.min(e.clientX, window.innerWidth - menuW),
    y: Math.min(e.clientY, window.innerHeight - menuH),
    img,
  }
}

function closeCtxMenu() {
  ctxMenu.value = null
}

function ctxOpen()     { emit('open', ctxMenu.value.img.id); closeCtxMenu() }
function ctxInfo()     { emit('show-info', ctxMenu.value.img.id); closeCtxMenu() }
function ctxDeleteKp() {
  ctxTargets.value.forEach((img) => {
    if (img.kpStatus === 'done') emit('delete-keypoints', img.id)
  })
  closeCtxMenu()
}
function ctxRemove() {
  ctxTargets.value.forEach((img) => emit('remove-image', img.id))
  closeCtxMenu()
}

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
        <template v-for="img in images" :key="img.id">
          <li
            class="list-item"
            :class="{ selected: localSelected.includes(img.id) }"
            :title="img.name"
            @click="handleItemClick($event, img)"
            @dblclick="emit('open', img.id)"
            @contextmenu="onRightClick($event, img)"
          >
            <button
              class="expand-btn"
              :class="{ open: expanded[img.id] }"
              @click.stop="toggleExpand(img.id)"
              :title="expanded[img.id] ? 'Collapse' : 'Expand'"
            ></button>
            <span v-if="img.kpStatus === 'running'" class="status-dot running"></span>
            <span v-else-if="img.kpStatus === 'error'" class="status-dot error"></span>
            <span class="item-name">{{ img.name }}</span>
          </li>
          <li v-if="expanded[img.id]" class="img-details" @contextmenu.stop>
            <div class="detail-row">
              <span class="detail-label">Keypoints</span>
              <span class="detail-value">
                <template v-if="img.kpStatus === 'done'">
                  {{ img.kpCount }}
                </template>
                <span v-else-if="img.kpStatus === 'running'" class="detail-dim">detecting…</span>
                <span v-else-if="img.kpStatus === 'error'" class="detail-error">failed</span>
                <span v-else class="detail-dim">—</span>
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Mask</span>
              <span class="detail-value">
                <span v-if="img.mask">yes</span>
                <span v-else class="detail-dim">—</span>
              </span>
            </div>
          </li>
        </template>
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

    <!-- Context menu -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        class="ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item" :class="{ 'ctx-disabled': ctxIsMulti }" :disabled="ctxIsMulti" @click="ctxOpen">Open in tab</button>
        <button class="ctx-item" :class="{ 'ctx-disabled': ctxIsMulti }" :disabled="ctxIsMulti" @click="ctxInfo">Show information</button>
        <template v-if="ctxHasKp">
          <div class="ctx-sep"></div>
          <button class="ctx-item" @click="ctxDeleteKp">Delete keypoints</button>
        </template>
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
  user-select: none;
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
}

.status-dot.error   { background: #e55; }
.status-dot.running { background: #fa0; animation: pulse 0.9s ease-in-out infinite; }

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

/* Per-image expand toggle */
.expand-btn {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
}

.expand-btn::before {
  content: '';
  display: block;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 5px 0 5px 8px;
  border-color: transparent transparent transparent currentColor;
  transition: transform 0.15s;
}

.expand-btn:hover { color: var(--text); }
.expand-btn.open::before { transform: rotate(90deg); }

/* Image detail panel — white card with dotted left connector */
.img-details {
  background: #fff;
  border-left: 1.5px dotted #bbb;
  margin: 0 8px 4px 19px;
  border-radius: 0 4px 4px 0;
  padding: 4px 8px 4px 10px;
}

.detail-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  line-height: 1.8;
}

.detail-label { color: #777; }

.detail-value {
  color: #222;
  font-variant-numeric: tabular-nums;
}

.detail-dim   { color: #aaa; }
.detail-error { color: #c33; }

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

.ctx-disabled {
  opacity: 0.35;
  cursor: default;
  pointer-events: none;
}

.ctx-sep {
  height: 1px;
  background: var(--panel-border);
  margin: 4px 0;
}
</style>
