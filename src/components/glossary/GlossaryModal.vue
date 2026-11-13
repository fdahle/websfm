<script setup>
import 'katex/dist/katex.min.css'
import { ref, computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useGlossaryStore } from '../../stores/useGlossaryStore.js'
import { useHelpLinkPreview } from '../../composables/useHelpLinkPreview.js'
import { helpLinkFrom, followLink } from '../../composables/useHelpStack.js'
import { getGlossaryEntry, getGlossaryEntriesByTopic, searchGlossary } from '../../core/help/glossary.js'
import { renderHelpMarkdown } from '../../core/help/helpMarkdown.js'
import { formatReference, referenceUrl } from '../../core/help/references.js'
import HelpTabStrip from './HelpTabStrip.vue'
import { useModalStackEntry } from '../../composables/useModalStack.js'

// Single centered modal holding the glossary. A Home/index tab plus one tab per
// opened term (unlimited, closeable). Cross-links inside a term open more tabs.
const glossary = useGlossaryStore()
const { isOpen, tabs, activeId } = storeToRefs(glossary)
// Escape closes it while it is the top-most modal (it can open on top of any dialog).
useModalStackEntry(() => glossary.close(), { open: isOpen })

const query = ref('')

// Typing in search jumps to Home so the results are visible.
function onSearch() {
  glossary.setActive('home')
}

// No query: the pipeline map (stage cards joined by arrows, plus any plain
// non-pipeline sections after). With a query: a flat ranked result list
// (grouping ranked results would fight the ranking).
const sections = computed(() => (query.value.trim() ? null : getGlossaryEntriesByTopic()))
const pipelineSections = computed(() => sections.value?.filter((s) => s.pipeline) ?? [])
const extraSections = computed(() => sections.value?.filter((s) => !s.pipeline) ?? [])
const results = computed(() => (query.value.trim() ? searchGlossary(query.value) : []))

const activeEntry = computed(() => (activeId.value === 'home' ? null : getGlossaryEntry(activeId.value)))
const activeHtml = computed(() =>
  activeEntry.value ? renderHelpMarkdown(activeEntry.value.body, { selfId: activeEntry.value.id }) : '',
)

// The published methods the entry describes (its `refs:`), as full citations.
const activeRefs = computed(() =>
  (activeEntry.value?.refs ?? []).map((key) => ({
    key,
    text: formatReference(key, { link: false }),
    url: referenceUrl(key),
  })),
)

const stripTabs = computed(() => tabs.value.map((id) => ({ id, title: getGlossaryEntry(id)?.title ?? id })))

const { onMouseOver: onPreviewOver, onMouseOut: onPreviewOut } = useHelpLinkPreview()

// Internal [label](help:id) / auto-links open (or focus) a tab.
function onBodyClick(e) {
  const link = helpLinkFrom(e.target)
  if (link) {
    e.preventDefault()
    followLink(link)
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="overlay" @click.self="glossary.close()" @keydown.esc.stop="glossary.close()">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Glossary">
        <div class="modal-header">
          <span class="modal-title">Glossary</span>
          <input v-model="query" class="search" type="search" placeholder="Search terms…" @input="onSearch" />
          <button class="modal-close" title="Close" @click="glossary.close()">×</button>
        </div>

        <HelpTabStrip
          :tabs="stripTabs"
          :active-id="activeId"
          @activate="glossary.setActive"
          @close="glossary.closeTab"
          @move="glossary.moveTab"
          @close-others="glossary.closeOtherTabs"
          @close-left="glossary.closeTabsToLeft"
          @close-right="glossary.closeTabsToRight"
          @close-all="glossary.closeAllTabs"
        />

        <div class="modal-body">
          <!-- Home / index + search results -->
          <template v-if="activeId === 'home'">
            <!-- Browsing: the SfM pipeline as connected stage cards -->
            <template v-if="sections">
              <p class="map-intro">The photogrammetry pipeline, stage by stage — click a term to read about it.</p>
              <template v-for="(s, i) in pipelineSections" :key="s.topic">
                <section class="stage">
                  <div class="stage-head">
                    <span class="stage-icon" aria-hidden="true">{{ s.icon }}</span>
                    <div class="stage-text">
                      <h3 class="stage-title">{{ s.label }}</h3>
                      <p class="stage-blurb">{{ s.blurb }}</p>
                    </div>
                  </div>
                  <div class="chips">
                    <button
                      v-for="e in s.entries"
                      :key="e.id"
                      class="chip"
                      :title="e.summary"
                      @click="glossary.openTerm(e.id)"
                    >
                      {{ e.title }}
                    </button>
                  </div>
                </section>
                <div v-if="i < pipelineSections.length - 1" class="connector" aria-hidden="true"></div>
              </template>
              <section v-for="s in extraSections" :key="s.topic" class="stage stage-extra">
                <div class="stage-head">
                  <div class="stage-text">
                    <h3 class="stage-title">{{ s.label }}</h3>
                  </div>
                </div>
                <div class="chips">
                  <button
                    v-for="e in s.entries"
                    :key="e.id"
                    class="chip"
                    :title="e.summary"
                    @click="glossary.openTerm(e.id)"
                  >
                    {{ e.title }}
                  </button>
                </div>
              </section>
            </template>
            <!-- Searching: flat ranked list -->
            <p v-else-if="!results.length" class="empty">No terms match “{{ query }}”.</p>
            <ul v-else class="index-list">
              <li v-for="e in results" :key="e.id">
                <button class="index-item" @click="glossary.openTerm(e.id)">
                  <span class="index-title">{{ e.title }}</span>
                  <span class="index-summary">{{ e.summary }}</span>
                </button>
              </li>
            </ul>
          </template>

          <!-- A term -->
          <template v-else>
            <div
              v-if="activeEntry"
              class="term-body"
              v-html="activeHtml"
              @click="onBodyClick"
              @mouseover="onPreviewOver"
              @mouseout="onPreviewOut"
            ></div>
            <div v-if="activeEntry && activeRefs.length" class="term-sources">
              <div class="term-sources-title">Sources</div>
              <ol>
                <li v-for="r in activeRefs" :key="r.key">
                  {{ r.text }}
                  <a v-if="r.url" :href="r.url" target="_blank" rel="noopener">{{
                    r.url.replace(/^https:\/\//, '')
                  }}</a>
                </li>
              </ol>
            </div>
            <p v-else-if="!activeEntry" class="empty">No glossary entry found for “{{ activeId }}”.</p>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 400;
}
.modal {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  width: 640px;
  max-width: 92vw;
  height: 560px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}
.modal-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--panel-border);
  flex-shrink: 0;
}
.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.search {
  margin-left: auto;
  width: 220px;
  background: var(--input-bg, var(--panel));
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 5px 9px;
}
.modal-close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 4px;
}
.modal-close:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 18px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}
.empty {
  color: var(--text-dim);
  font-style: italic;
}

/* ── Pipeline map (home, no query) ── */
.map-intro {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--text-dim);
}
.stage {
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--hover-bg);
}
.stage-extra {
  margin-top: 14px;
}
.stage-head {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin-bottom: 8px;
}
.stage-icon {
  font-size: 17px;
  line-height: 1.25;
}
.stage-text {
  min-width: 0;
}
.stage-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.stage-blurb {
  margin: 1px 0 0;
  font-size: 11.5px;
  color: var(--text-dim);
  line-height: 1.4;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 999px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 3px 10px;
  cursor: pointer;
}
.chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}
/* Line + arrowhead both drawn inside the element's own height, so the tip
   can't overlap the stage card below. */
.connector {
  width: 8px;
  height: 18px;
  margin: 4px auto;
  position: relative;
}
.connector::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  height: 13px;
  transform: translateX(-50%);
  border-left: 2px solid var(--panel-border);
}
.connector::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 0;
  transform: translateX(-50%);
  border: 4px solid transparent;
  border-top: 5px solid var(--panel-border);
  border-bottom: none;
}

/* ── Flat ranked list (search results) ── */
.index-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.index-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  font: inherit;
}
.index-item:hover {
  background: var(--hover-bg);
}
.index-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.index-summary {
  font-size: 11.5px;
  color: var(--text-dim);
  line-height: 1.4;
}

.term-sources {
  margin-top: 18px;
  padding-top: 10px;
  border-top: 1px solid var(--panel-border);
  font-size: 12px;
  color: var(--text-dim);
}
.term-sources-title {
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}
.term-sources ol {
  margin: 0;
  padding-left: 18px;
}
.term-sources li {
  margin-bottom: 4px;
  overflow-wrap: anywhere;
}
.term-sources a {
  color: var(--accent);
}
.term-body :deep(a.glossary-link) {
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline dotted;
}
.term-body :deep(a) {
  color: var(--accent);
}
.term-body :deep(p) {
  margin: 0 0 10px;
}
.term-body :deep(ul),
.term-body :deep(ol) {
  margin: 5px 0 12px;
  padding-left: 21px;
}
.term-body :deep(li) {
  margin: 3px 0;
}
.term-body :deep(h1),
.term-body :deep(h2),
.term-body :deep(h3) {
  font-size: 14px;
  color: var(--text);
  margin: 16px 0 7px;
}
.term-body :deep(code) {
  background: var(--hover-bg);
  border-radius: 4px;
  padding: 1px 4px;
  font-size: 12px;
}
.term-body :deep(img.glossary-img) {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
  margin: 6px 0;
}
</style>
