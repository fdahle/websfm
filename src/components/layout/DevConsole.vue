<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useLog, stripSourcePrefix } from '../../composables/useLog.js'
import { useLogStore } from '../../stores/useLogStore.js'
import { useProjectsStore } from '../../stores/useProjectsStore.js'
import { useCommands } from '../../composables/useCommands.js'
import { completions, commonPrefix } from '../../core/help/commands.js'

// The command prompt drives App.vue's handleCommand (same registry as the
// ribbon); commandState carries the guard flags (counts / ready-booleans).
const props = defineProps({
  dispatch: { type: Function, default: null },
  commandState: { type: Object, default: () => ({}) },
})

const { entries, log } = useLog()
// Instantiating the store here also activates its log→OPFS streaming from app
// boot; it owns the on-disk record that scroll-back and export read from.
const logStore = useLogStore()
const projects = useProjectsStore()
const body = ref(null)

// "Stick to bottom": follow new log lines automatically, but only while the user
// hasn't manually scrolled up. Scrolling back down to within THRESHOLD px re-sticks.
const THRESHOLD = 60
const stickToBottom = ref(true)

// Scroll-back: the in-memory `entries` are only the live tail (capped at
// MAX_BUFFER). Older lines live in the on-disk stream. When the user scrolls to
// the top we read the previous chunk from the file (via the store) and prepend
// it to `earlier`, which is rendered ahead of the live tail. `fullCache` is the
// once-read parsed stream; we only ever slice its *older* (immutable) portion.
const CHUNK = 500
const earlier = ref([])
let fullCache = null
let loadingEarlier = false
const allEarlierLoaded = ref(false)

function resetEarlier() {
  earlier.value = []
  fullCache = null
  loadingEarlier = false
  allEarlierLoaded.value = false
}

// Switching projects replaces the console contents; the cached stream is now a
// different project's, so drop the scroll-back state.
watch(() => projects.currentProjectId, resetEarlier)

async function loadEarlier() {
  if (loadingEarlier || allEarlierLoaded.value) return
  loadingEarlier = true
  try {
    if (!fullCache) fullCache = await logStore.readAll()
    if (!fullCache.length) { allEarlierLoaded.value = true; return }
    // Anchor on the oldest line currently shown; load the chunk before it.
    const firstId = earlier.value.length ? earlier.value[0].id : entries.value[0]?.id
    let idx = firstId ? fullCache.findIndex(e => e.id === firstId) : fullCache.length
    if (idx < 0) idx = fullCache.length // not yet on disk ⇒ everything is earlier
    if (idx <= 0) { allEarlierLoaded.value = true; return }
    const start = Math.max(0, idx - CHUNK)
    const chunk = fullCache.slice(start, idx)
    // Preserve the viewport: prepending grows scrollHeight, so re-offset scrollTop.
    const el = body.value
    const before = el ? el.scrollHeight : 0
    earlier.value = [...chunk, ...earlier.value]
    if (start === 0) allEarlierLoaded.value = true
    await nextTick()
    if (el) el.scrollTop += el.scrollHeight - before
  } finally {
    loadingEarlier = false
  }
}

function atBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD
}

function onScroll() {
  const el = body.value
  if (!el) return
  stickToBottom.value = atBottom(el)
  if (el.scrollTop < THRESHOLD) loadEarlier()
}

function scrollToBottom() {
  const el = body.value
  if (!el) return
  // Drop the loaded history to free the DOM; scrolling up re-loads it.
  if (earlier.value.length) resetEarlier()
  nextTick(() => {
    el.scrollTop = el.scrollHeight
    stickToBottom.value = true
  })
}

watch(entries, async () => {
  await nextTick()
  if (stickToBottom.value) scrollToBottom()
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

// Channel tabs: 'pipeline' = the process/scientific record, 'activity' = user-action
// confirmations (toggles, add/enable/rename), 'all' = both. Entries persisted before
// this field existed have no `channel` ⇒ treated as pipeline.
const activeTab = ref('pipeline')
function entryChannel(e) { return e.channel === 'activity' ? 'activity' : 'pipeline' }

// Filter panel
const filterOpen = ref(false)
const hiddenSources = ref(new Set())

const allSources = computed(() => {
  const s = new Set()
  for (const e of earlier.value) if (e.source) s.add(e.source)
  for (const e of entries.value) if (e.source) s.add(e.source)
  return [...s].sort()
})

function passesFilter(e) {
  if (activeTab.value !== 'all' && entryChannel(e) !== activeTab.value) return false
  if (!showDetail.value && e.level === 'debug') return false
  if (hiddenSources.value.has(e.source)) return false
  return true
}

// The rendered list: loaded scroll-back history followed by the live tail.
const filteredEntries = computed(() => {
  const out = []
  for (const e of earlier.value) if (passesFilter(e)) out.push(e)
  for (const e of entries.value) if (passesFilter(e)) out.push(e)
  return out
})

// Per-tab counts for the tab badges (live tail + loaded scroll-back).
const channelCounts = computed(() => {
  let pipeline = 0, activity = 0
  const tally = e => { entryChannel(e) === 'activity' ? activity++ : pipeline++ }
  for (const e of earlier.value) tally(e)
  for (const e of entries.value) tally(e)
  return { pipeline, activity, all: pipeline + activity }
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
  'Detection': '#e67e22',
  'Matching': '#1abc9c',
  'Project':  '#2ecc71',
  'Reconstruction': '#e0518a',
  'Console':  '#c0a020',
}

function sourceColor(source) {
  return SOURCE_COLORS[source] ?? '#888888'
}

function sourceStyle(source) {
  const c = sourceColor(source)
  return { color: c, borderColor: c + '60', background: c + '18' }
}

// --- Command prompt -------------------------------------------------------
const { runLine } = useCommands(
  (id) => props.dispatch?.(id),
  () => props.commandState,
)

const promptInput = ref(null)
const command = ref('')

// Recent command history, newest last; persisted so it survives reloads.
const HISTORY_KEY = 'consoleHistory'
const HISTORY_MAX = 50
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [] } catch { return [] }
}
const history = ref(loadHistory())
// -1 == editing a fresh line; 0..n-1 index into history from the newest end.
const histCursor = ref(-1)

function submitCommand() {
  const line = command.value.trim()
  if (!line) return
  runLine(line)
  if (history.value[history.value.length - 1] !== line) {
    history.value.push(line)
    if (history.value.length > HISTORY_MAX) history.value.shift()
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value)) } catch { /* ignore quota */ }
  }
  command.value = ''
  histCursor.value = -1
}

function recallHistory(delta) {
  if (!history.value.length) return
  // cursor counts back from the newest entry; -1 is the live (empty-ish) line.
  let next = histCursor.value + delta
  if (next < -1) next = -1
  if (next > history.value.length - 1) next = history.value.length - 1
  histCursor.value = next
  command.value = next === -1 ? '' : history.value[history.value.length - 1 - next]
  nextTick(() => {
    const el = promptInput.value
    if (el) el.setSelectionRange(el.value.length, el.value.length)
  })
}

// Tab: complete to the single match, or to the longest shared prefix and list
// the candidates in the log so the user can see where it forked.
function completeCommand() {
  const matches = completions(command.value)
  if (matches.length === 0) return
  if (matches.length === 1) { command.value = matches[0]; return }
  const shared = commonPrefix(matches)
  if (shared && shared.length > command.value.trimStart().length) command.value = shared
  log(matches.join('   '), 'debug', 'Console')
}

function onPromptKey(e) {
  switch (e.key) {
    case 'Enter':      e.preventDefault(); submitCommand(); break
    case 'ArrowUp':    e.preventDefault(); recallHistory(+1); break
    case 'ArrowDown':  e.preventDefault(); recallHistory(-1); break
    case 'Tab':        e.preventDefault(); completeCommand(); break
  }
}

defineExpose({ focusPrompt: () => promptInput.value?.focus() })
onMounted(() => promptInput.value?.focus())

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

// Wipe the console — both the display and the on-disk stream for this project.
async function onClear() {
  resetEarlier()
  await logStore.clearConsole()
}

// Export options. The default export is the clean process record: pipeline lines
// only, no debug noise. Activity confirmations and debug diagnostics are opt-in so
// they never clog the exported log (the whole point of the Activity channel). These
// are export-only and independent of the view's tab / Detail toggles.
const exportMenuOpen = ref(false)
const exportActivity = ref(false)
const exportDebug = ref(false)

// Save the stream to a .txt file — the whole on-disk record, not the capped live
// window. Filtered by the export options above (never by the view's Detail/tab/
// source toggles). The source-name prefix is stripped so the column isn't doubled.
// Falls back to what's in memory if the stream can't be read.
async function saveTxt() {
  const fmt = e => `${e.time}  ${(e.source ?? '').padEnd(10)}  ${e.level.padEnd(7)}  ${stripSourcePrefix(e.source, e.message)}`
  let src = await logStore.readAll()
  if (!src || src.length === 0) src = [...earlier.value, ...entries.value]
  src = src.filter(e => {
    if (!exportActivity.value && (e.channel === 'activity')) return false
    if (!exportDebug.value && e.level === 'debug') return false
    return true
  })
  const lines = src.map(fmt)
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
      <div class="console-tabs">
        <button
          v-for="tab in [
            { id: 'pipeline', label: 'Pipeline', count: channelCounts.pipeline },
            { id: 'activity', label: 'Activity', count: channelCounts.activity },
            { id: 'all', label: 'All', count: channelCounts.all },
          ]"
          :key="tab.id"
          class="console-tab"
          :class="{ active: activeTab === tab.id }"
          @click="activeTab = tab.id"
        >{{ tab.label }}<span class="tab-count">{{ tab.count }}</span></button>
      </div>
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
        <div class="export-wrap">
          <button class="btn-action" title="Save the log to a TXT file" @click="saveTxt">Save TXT</button>
          <button
            class="btn-action export-caret"
            :class="{ active: exportMenuOpen }"
            title="Export options"
            @click="exportMenuOpen = !exportMenuOpen"
          >▾</button>
          <div v-if="exportMenuOpen" class="export-menu" @mouseleave="exportMenuOpen = false">
            <div class="export-menu-title">Include in export</div>
            <label class="export-opt">
              <input type="checkbox" v-model="exportActivity" />
              <span>Activity (user actions)</span>
            </label>
            <label class="export-opt">
              <input type="checkbox" v-model="exportDebug" />
              <span>Detailed (debug) lines</span>
            </label>
          </div>
        </div>
        <button class="btn-clear" title="Clear" @click="onClear">Clear</button>
      </div>
    </div>
    <div class="console-main">
      <div ref="body" class="console-body" tabindex="0" @keydown="onKeyDown" @scroll.passive="onScroll">
        <div
          v-for="entry in filteredEntries"
          :key="entry.id"
          class="entry"
          :class="[`level-${entry.level}`, { 'channel-activity': entryChannel(entry) === 'activity' }]"
        >
          <span v-if="entryChannel(entry) === 'activity'" class="entry-activity-glyph" title="User action">▸</span>
          <span class="entry-time">{{ entry.time }}</span>
          <span
            v-if="showSource"
            class="entry-source"
            :style="entry.source ? sourceStyle(entry.source) : {}"
          >{{ entry.source ?? '—' }}</span>
          <span class="entry-msg">{{ stripSourcePrefix(entry.source, entry.message) }}</span>
        </div>
        <div v-if="filteredEntries.length === 0" class="empty">
          {{ entries.length === 0 && earlier.length === 0
            ? 'No output yet.'
            : activeTab === 'activity' ? 'No activity yet — actions you take appear here.'
            : 'No entries match the current filter.' }}
        </div>
      </div>

      <button
        v-if="!stickToBottom"
        class="jump-btn"
        title="Jump to newest log entries"
        @click="scrollToBottom"
      >↓ New logs</button>

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

    <div class="console-prompt">
      <span class="prompt-caret">›</span>
      <input
        ref="promptInput"
        v-model="command"
        class="prompt-input"
        type="text"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        placeholder="Type a command — try &quot;help&quot;"
        @keydown="onPromptKey"
      />
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

.console-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
}

.console-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--console-text-dim);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  cursor: pointer;
  padding: 3px 8px;
  font-family: inherit;
}

.console-tab:hover {
  color: var(--console-text);
}

.console-tab.active {
  color: var(--console-text);
  border-bottom-color: var(--accent);
}

.tab-count {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--console-text-dim);
  background: var(--console-btn-hover);
  border-radius: 8px;
  padding: 0 5px;
  line-height: 1.5;
}

.console-tab.active .tab-count {
  color: var(--console-text);
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

/* Save TXT + its export-options popover */
.export-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.export-caret {
  padding: 1px 4px;
}

.export-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  z-index: 5;
  background: var(--console-bg);
  border: 1px solid var(--console-border);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  padding: 6px;
  min-width: 190px;
}

.export-menu-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--console-text-label);
  padding: 2px 4px 6px;
}

.export-opt {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  cursor: pointer;
  border-radius: 3px;
  font-size: 11px;
  color: var(--console-text);
  user-select: none;
}

.export-opt:hover {
  background: var(--console-hover);
}

.export-opt input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
  accent-color: var(--accent);
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

/* Command prompt — the power-user command line, always pinned to the bottom. */
.console-prompt {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 4px 10px;
  border-top: 1px solid var(--console-border);
}

.prompt-caret {
  color: var(--accent);
  font-weight: 700;
  flex-shrink: 0;
}

.prompt-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--console-text);
  font-family: inherit;
  font-size: 12px;
  padding: 2px 0;
}

.prompt-input::placeholder {
  color: var(--console-text-dim);
}

/* Body row: entries + optional filter panel side by side */
.console-main {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

/* Floating "jump to newest" chip — shown only when the user has scrolled up. */
.jump-btn {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 12px;
  font-family: inherit;
  font-size: 11px;
  padding: 3px 12px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  opacity: 0.92;
}

.jump-btn:hover { opacity: 1; }

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

/* Activity lines read as "you did this", not "the algorithm found this":
   a leading glyph + a slightly recessed message. */
.entry-activity-glyph {
  flex-shrink: 0;
  color: var(--accent);
  font-size: 10px;
  opacity: 0.8;
}

.channel-activity .entry-msg {
  color: var(--console-text-dim);
  font-style: italic;
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
