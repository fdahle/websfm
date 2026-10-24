<script setup>
// Help ▸ What's New: CHANGELOG.md, newest release first. Releases that shipped
// since this browser last looked are marked New and open; the rest are folded.
// Changes shows each entry's headline and first sentence, Full the whole entry
// (with its evidence). Glossary terms in the text link as in the Guide.
import { computed, onMounted, reactive, ref, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import Icon from '../../Icon.vue'
import { renderHelpMarkdown } from '../../../core/help/helpMarkdown.js'
import { compareVersions, entryCount, UNRELEASED } from '../../../core/help/changelog.js'
import { followLink, helpLinkFrom } from '../../../composables/useHelpStack.js'
import { loadChangelog, markSeen, newCount, releases, seenVersion } from '../../../composables/useWhatsNew.js'

const emit = defineEmits(['close'])

const MODE_KEY = 'whatsNewMode'
function readMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'full' ? 'full' : 'changes'
  } catch {
    return 'changes'
  }
}
const mode = ref(readMode())
watch(mode, (m) => {
  try {
    localStorage.setItem(MODE_KEY, m)
  } catch {
    // the choice just isn't remembered
  }
})
const MODES = [
  { id: 'changes', label: 'Changes' },
  { id: 'full', label: 'Full' },
]

// What was new when the dialog opened: opening it marks everything seen, but the
// New marks stay until it closes.
const seenBefore = ref(null)
const newOnOpen = ref(0)
const open = reactive({})

const isNew = (r) => !!seenBefore.value && r.version !== UNRELEASED && compareVersions(r.version, seenBefore.value) > 0

const shown = computed(() => (releases.value ?? []).filter((r) => r.version !== UNRELEASED || entryCount(r) > 0))

onMounted(async () => {
  await loadChangelog()
  seenBefore.value = seenVersion.value
  newOnOpen.value = newCount.value
  // Open what is new; with nothing new, the latest release and anything unreleased.
  const anyNew = shown.value.some(isNew)
  const firstReleased = shown.value.find((r) => r.version !== UNRELEASED)
  for (const r of shown.value) open[r.version] = anyNew ? isNew(r) : r === firstReleased || r.version === UNRELEASED
  markSeen()
})

const allOpen = computed(() => shown.value.length > 0 && shown.value.every((r) => open[r.version]))
function toggleAll() {
  const to = !allOpen.value
  for (const r of shown.value) open[r.version] = to
}

// Rendered per release and mode, on first open (180 entries through marked at once
// would hold up the dialog).
const htmlCache = new Map()
function entriesHtml(r) {
  const key = `${r.version}|${mode.value}`
  if (!htmlCache.has(key))
    htmlCache.set(
      key,
      r.sections.map((s) => ({
        title: s.title,
        items: s.entries.map((e) => renderHelpMarkdown(mode.value === 'full' ? e.markdown : e.summary)),
      })),
    )
  return htmlCache.get(key)
}

function formatDate(iso) {
  if (!iso) return ''
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function onBodyClick(e) {
  const link = helpLinkFrom(e.target)
  if (link) {
    e.preventDefault()
    followLink(link)
  }
}
</script>

<template>
  <ModalShell title="What's new" width="780px" height="82vh" @close="emit('close')">
    <div class="wn-bar">
      <span v-if="newOnOpen" class="wn-new-count"><Icon name="sparkles" /> {{ newOnOpen }} new</span>
      <span v-else class="wn-hint">Every change to websfm, newest first.</span>
      <span class="wn-spacer"></span>
      <button class="link-btn" type="button" @click="toggleAll">{{ allOpen ? 'Collapse all' : 'Expand all' }}</button>
      <SegmentedControl v-model="mode" :options="MODES" />
    </div>

    <p v-if="!releases" class="wn-hint">Loading…</p>

    <div class="wn-list" @click="onBodyClick">
      <section v-for="r in shown" :key="r.version" class="wn-release" :class="{ new: isNew(r) }">
        <button
          type="button"
          class="wn-head"
          :aria-expanded="!!open[r.version]"
          @click="open[r.version] = !open[r.version]"
        >
          <span class="wn-version">{{ r.version === UNRELEASED ? 'Next release' : `v${r.version}` }}</span>
          <span v-if="r.date" class="wn-date">{{ formatDate(r.date) }}</span>
          <span v-if="r.title" class="wn-title">{{ r.title }}</span>
          <span v-if="isNew(r)" class="wn-badge">New</span>
          <span class="wn-spacer"></span>
          <span class="wn-count">{{ entryCount(r) }} {{ entryCount(r) === 1 ? 'change' : 'changes' }}</span>
          <span class="wn-chevron" :class="{ open: open[r.version] }">›</span>
        </button>
        <div v-if="open[r.version]" class="wn-body">
          <p v-if="r.intro" class="wn-intro">{{ r.intro }}</p>
          <div v-for="(s, i) in entriesHtml(r)" :key="i" class="wn-section">
            <h4 v-if="s.title" class="wn-section-title">{{ s.title }}</h4>
            <ul :class="{ compact: mode === 'changes' }">
              <li v-for="(html, j) in s.items" :key="j" v-html="html"></li>
            </ul>
          </div>
        </div>
      </section>
    </div>

    <template #footer>
      <a
        class="link-btn wn-source"
        href="https://github.com/fdahle/websfm/blob/main/CHANGELOG.md"
        target="_blank"
        rel="noopener"
        >CHANGELOG.md on GitHub</a
      >
      <button class="btn" @click="emit('close')">Close</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.wn-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.wn-spacer {
  flex: 1;
}
.wn-hint {
  font-size: 12.5px;
  color: var(--text-dim);
  margin: 0;
}
.wn-new-count {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: var(--accent);
  border-radius: 999px;
  padding: 3px 10px 3px 8px;
}
.wn-new-count :deep(.icon) {
  width: 14px;
  height: 14px;
}
.wn-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wn-release {
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  background: var(--panel);
}
.wn-release.new {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--panel-border));
}
.wn-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  background: none;
  border: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  padding: 9px 12px;
  cursor: pointer;
  border-radius: 8px;
}
.wn-head:hover {
  background: var(--hover-bg);
}
.wn-version {
  font-size: 13px;
  font-weight: 700;
}
.wn-date {
  font-size: 12px;
  color: var(--text-dim);
}
.wn-title {
  font-size: 13px;
  font-weight: 600;
}
.wn-badge {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 999px;
  padding: 1px 7px;
}
.wn-count {
  font-size: 11.5px;
  color: var(--text-dim);
}
.wn-chevron {
  font-size: 16px;
  line-height: 1;
  color: var(--text-dim);
  transition: transform 0.15s;
}
.wn-chevron.open {
  transform: rotate(90deg);
}
.wn-body {
  padding: 2px 14px 10px;
  border-top: 1px solid var(--panel-border);
}
.wn-intro {
  font-size: 12.5px;
  color: var(--text-dim);
  margin: 10px 0 4px;
}
.wn-section-title {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin: 12px 0 4px;
}
.wn-section ul {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text);
}
.wn-section li {
  margin: 0 0 8px;
}
.wn-section ul.compact li {
  margin-bottom: 4px;
}
.wn-section :deep(p) {
  margin: 0 0 6px;
}
.wn-section :deep(ul) {
  margin: 4px 0;
  padding-left: 18px;
}
.wn-section :deep(code) {
  background: var(--hover-bg);
  border-radius: 4px;
  padding: 1px 4px;
  font-size: 11.5px;
}
.wn-section :deep(a) {
  color: var(--accent);
}
.wn-section :deep(a.glossary-link),
.wn-section :deep(a.guide-link) {
  cursor: pointer;
  text-decoration: underline dotted;
}
.wn-source {
  margin-right: auto;
  font-size: 12px;
}
</style>
