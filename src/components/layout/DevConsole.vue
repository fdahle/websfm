<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useLog } from '../../composables/useLog.js'

const { entries, clear } = useLog()
const body = ref(null)

watch(entries, async () => {
  await nextTick()
  const el = body.value
  if (!el) return
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  if (nearBottom) el.scrollTop = el.scrollHeight
}, { deep: true })

// Drag-to-resize from the top edge.
const height = ref(200)
let dragStart = null

function onDragStart(e) {
  dragStart = { y: e.clientY, h: height.value }
  window.addEventListener('mousemove', onDrag)
  window.addEventListener('mouseup', onDragEnd)
}

function onDrag(e) {
  if (!dragStart) return
  height.value = Math.max(80, Math.min(600, dragStart.h - (e.clientY - dragStart.y)))
}

function onDragEnd() {
  dragStart = null
  window.removeEventListener('mousemove', onDrag)
  window.removeEventListener('mouseup', onDragEnd)
}

// Source badge visibility toggle
const showSource = ref(true)

// Detailed (debug-level) log visibility. Debug entries are always recorded;
// this only controls whether they're shown here. Off by default.
const showDetail = ref(false)

// Filter panel
const filterOpen = ref(false)
const hiddenSources = ref(new Set())

const allSources = computed(() => {
  const s = new Set()
  for (const e of entries.value) if (e.source) s.add(e.source)
  return [...s].sort()
})

const filteredEntries = computed(() => {
  return entries.value.filter(e => {
    if (!showDetail.value && e.level === 'debug') return false
    if (hiddenSources.value.has(e.source)) return false
    return true
  })
})

function toggleSource(source) {
  const next = new Set(hiddenSources.value)
  if (next.has(source)) next.delete(source)
  else next.add(source)
  hiddenSources.value = next
}

function isVisible(source) {
  return !hiddenSources.value.has(source)
}

function showAll() { hiddenSources.value = new Set() }
function hideAll() { hiddenSources.value = new Set(allSources.value) }

// Source colors
const SOURCE_COLORS = {
  'Images':   '#4d9de0',
  'Metadata': '#9b59b6',
  'SIFT':     '#e67e22',
  'Matching': '#1abc9c',
  'Project':  '#2ecc71',
  'Reconstruction': '#e0518a',
}

function sourceColor(source) {
  return SOURCE_COLORS[source] ?? '#888888'
}

function sourceStyle(source) {
  const c = sourceColor(source)
  return { color: c, borderColor: c + '60', background: c + '18' }
}

function onKeyDown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    e.preventDefault()
    const el = body.value
    if (!el) return
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  }
}

// Save visible entries to a .txt file
function saveTxt() {
  const lines = filteredEntries.value.map(e => {
    const src = (e.source ?? '').padEnd(10)
    const lvl = e.level.padEnd(7)
    return `${e.time}  ${src}  ${lvl}  ${e.message}`
  })
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const now = new Date()
  const pad = n => n.toString().padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  a.download = `console-${stamp}.txt`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="console" :style="{ height: height + 'px' }">
    <div class="resize-handle" @mousedown.prevent="onDragStart" />
    <div class="console-header">
      <span class="console-title">Console</span>
      <div class="header-actions">
        <button
          class="btn-action"
          :class="{ active: showSource }"
          title="Toggle source labels"
          @click="showSource = !showSource"
        >src</button>
        <button
          class="btn-action"
          :class="{ active: showDetail }"
          title="Show detailed (debug) log entries"
          @click="showDetail = !showDetail"
        >Detail</button>
        <button
          class="btn-action"
          :class="{ active: filterOpen }"
          title="Filter by source"
          @click="filterOpen = !filterOpen"
        >Filter</button>
        <button class="btn-action" title="Save visible entries to TXT" @click="saveTxt">Save TXT</button>
        <button class="btn-clear" title="Clear" @click="clear">Clear</button>
      </div>
    </div>
    <div class="console-main">
      <div ref="body" class="console-body" tabindex="0" @keydown="onKeyDown">
        <div
          v-for="entry in filteredEntries"
          :key="entry.id"
          class="entry"
          :class="`level-${entry.level}`"
        >
          <span class="entry-time">{{ entry.time }}</span>
          <span
            v-if="showSource"
            class="entry-source"
            :style="entry.source ? sourceStyle(entry.source) : {}"
          >{{ entry.source ?? '—' }}</span>
          <span class="entry-msg">{{ entry.message }}</span>
        </div>
        <div v-if="filteredEntries.length === 0" class="empty">
          {{ entries.length === 0 ? 'No output yet.' : 'No entries match the current filter.' }}
        </div>
      </div>

      <div v-if="filterOpen" class="filter-panel">
        <div class="filter-header">
          <span class="filter-title">Sources</span>
          <div class="filter-links">
            <button class="filter-link" @click="showAll">All</button>
            <button class="filter-link" @click="hideAll">None</button>
          </div>
        </div>
        <div class="filter-items">
          <label
            v-for="source in allSources"
            :key="source"
            class="filter-item"
          >
            <input
              type="checkbox"
              :checked="isVisible(source)"
              @change="toggleSource(source)"
            />
            <span class="filter-dot" :style="{ background: sourceColor(source) }" />
            <span class="filter-label">{{ source }}</span>
          </label>
          <div v-if="allSources.length === 0" class="filter-empty">No sources yet.</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.console {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--console-bg);
  border-top: 1px solid var(--console-border);
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
  font-size: 12px;
}

.resize-handle {
  height: 4px;
  cursor: ns-resize;
  background: transparent;
  flex-shrink: 0;
}

.resize-handle:hover {
  background: var(--accent);
}

.console-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 10px;
  border-bottom: 1px solid var(--console-border);
  flex-shrink: 0;
}

.console-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--console-text-label);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.btn-action {
  background: none;
  border: 1px solid transparent;
  color: var(--console-text-dim);
  font-size: 11px;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 3px;
  font-family: inherit;
}

.btn-action:hover {
  color: var(--console-text);
  background: var(--console-btn-hover);
}

.btn-action.active {
  color: var(--console-text);
  background: var(--console-btn-hover);
  border-color: var(--console-border);
}

.btn-clear {
  background: none;
  border: none;
  color: var(--console-text-dim);
  font-size: 11px;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 3px;
  font-family: inherit;
}

.btn-clear:hover {
  color: var(--console-text);
  background: var(--console-btn-hover);
}

/* Body row: entries + optional filter panel side by side */
.console-main {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.console-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.entry {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 1px 10px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.entry:hover {
  background: var(--console-hover);
}

.entry-time {
  flex-shrink: 0;
  color: var(--console-text-dim);
}

.entry-source {
  flex-shrink: 0;
  min-width: 66px;
  font-size: 10px;
  padding: 0 5px;
  border-radius: 3px;
  border: 1px solid transparent;
  text-align: center;
  line-height: 1.7;
  color: var(--console-text-dim);
}

.entry-msg {
  color: var(--console-text);
}

.level-success .entry-msg { color: #4ec94e; }
.level-warn    .entry-msg { color: #d4900a; }
.level-error   .entry-msg { color: #f05050; }
.level-debug   .entry-msg { color: var(--console-text-dim); }

.empty {
  padding: 8px 10px;
  color: var(--console-text-dim);
  font-style: italic;
}

/* Filter panel */
.filter-panel {
  flex-shrink: 0;
  width: 148px;
  border-left: 1px solid var(--console-border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.filter-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-bottom: 1px solid var(--console-border);
  flex-shrink: 0;
}

.filter-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--console-text-label);
}

.filter-links {
  display: flex;
  gap: 4px;
}

.filter-link {
  background: none;
  border: none;
  color: var(--console-text-dim);
  font-size: 10px;
  cursor: pointer;
  padding: 0 3px;
  font-family: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.filter-link:hover {
  color: var(--console-text);
}

.filter-items {
  padding: 6px 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.filter-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 3px;
  font-size: 11px;
  color: var(--console-text);
  user-select: none;
}

.filter-item:hover {
  background: var(--console-hover);
}

.filter-item input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
  accent-color: var(--accent);
}

.filter-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.filter-label {
  flex: 1;
}

.filter-empty {
  padding: 4px;
  color: var(--console-text-dim);
  font-style: italic;
  font-size: 11px;
}
</style>
