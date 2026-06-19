<script setup>
import { ref, watch, nextTick } from 'vue'
import { useLog } from '../composables/useLog.js'

const { entries, clear } = useLog()
const body = ref(null)

// Auto-scroll to bottom on new entries, but only if already near the bottom.
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
</script>

<template>
  <div class="console" :style="{ height: height + 'px' }">
    <div class="resize-handle" @mousedown.prevent="onDragStart" />
    <div class="console-header">
      <span class="console-title">Console</span>
      <button class="btn-clear" title="Clear" @click="clear">Clear</button>
    </div>
    <div ref="body" class="console-body">
      <div
        v-for="entry in entries"
        :key="entry.id"
        class="entry"
        :class="`level-${entry.level}`"
      >
        <span class="entry-time">{{ entry.time }}</span>
        <span class="entry-msg">{{ entry.message }}</span>
      </div>
      <div v-if="entries.length === 0" class="empty">No output yet.</div>
    </div>
  </div>
</template>

<style scoped>
.console {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #1a1a1a;
  border-top: 1px solid #333;
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
  border-bottom: 1px solid #333;
  flex-shrink: 0;
}

.console-title {
  font-size: 11px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.btn-clear {
  background: none;
  border: none;
  color: #666;
  font-size: 11px;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 3px;
  font-family: inherit;
}

.btn-clear:hover {
  color: #aaa;
  background: #2a2a2a;
}

.console-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.entry {
  display: flex;
  gap: 10px;
  padding: 1px 10px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.entry:hover {
  background: #222;
}

.entry-time {
  flex-shrink: 0;
  color: #555;
}

.entry-msg {
  color: #ccc;
}

.level-success .entry-msg { color: #4ec94e; }
.level-warn    .entry-msg { color: #d4900a; }
.level-error   .entry-msg { color: #f05050; }

.empty {
  padding: 8px 10px;
  color: #555;
  font-style: italic;
}
</style>
