<script setup>
import 'katex/dist/katex.min.css'
import { ref, computed, watch, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import { useGlossaryStore } from '../../stores/useGlossaryStore.js'
import { useGuideStore } from '../../stores/useGuideStore.js'
import { useHelpLinkPreview } from '../../composables/useHelpLinkPreview.js'
import GlossaryTooltip from './GlossaryTooltip.vue'
import {
  getGlossaryEntry, getGlossaryEntriesByTopic, searchGlossary, renderHelpMarkdown,
} from '../../core/help/glossary.js'

// Single centered modal holding the glossary. A Home/index tab plus one tab per
// opened term (unlimited, closeable). Cross-links inside a term open more tabs.
const glossary = useGlossaryStore()
const guide = useGuideStore()
const { isOpen, tabs, activeId } = storeToRefs(glossary)

const query = ref('')

// Typing in search jumps to Home so the results are visible.
function onSearch() { glossary.setActive('home') }

// No query: the pipeline map (stage cards joined by arrows, plus any plain
// non-pipeline sections after). With a query: a flat ranked result list
// (grouping ranked results would fight the ranking).
const sections = computed(() => (query.value.trim() ? null : getGlossaryEntriesByTopic()))
const pipelineSections = computed(() => sections.value?.filter(s => s.pipeline) ?? [])
const extraSections = computed(() => sections.value?.filter(s => !s.pipeline) ?? [])
const results = computed(() => (query.value.trim() ? searchGlossary(query.value) : []))

const activeEntry = computed(() => (activeId.value === 'home' ? null : getGlossaryEntry(activeId.value)))
const activeHtml = computed(() =>
  activeEntry.value ? renderHelpMarkdown(activeEntry.value.body, { selfId: activeEntry.value.id }) : '')

const tabEntries = computed(() => tabs.value.map(id => ({ id, entry: getGlossaryEntry(id) })))

function openGlossary(id) { guide.close(); glossary.openTerm(id) }
function openGuide(id) { glossary.close(); guide.openOp(id) }
const {
  RING_MS: previewRingMs, anchor: previewAnchor, visible: previewVisible,
  pinned: previewPinned, tooltipRef: previewTooltip, title: previewTitle,
  summaryHtml: previewSummary, onMouseOver: onPreviewOver, onMouseOut: onPreviewOut,
  hide: hidePreview, readMore: readPreview, followGlossary: previewGlossary,
  followGuide: previewGuide,
} = useHelpLinkPreview({ openGlossary, openGuide })

// A newly opened tab is appended at the right of the strip and can land past
// the visible edge — scroll it into view so the user sees where it went.
// Manual scrollLeft (not scrollIntoView) so only this strip ever moves.
const tabScroll = ref(null)
watch([activeId, tabs], async () => {
  if (!isOpen.value || activeId.value === 'home') return
  await nextTick()
  const strip = tabScroll.value
  const el = strip?.querySelector('.gtab.active')
  if (!el) return
  const sr = strip.getBoundingClientRect()
  const er = el.getBoundingClientRect()
  if (er.left < sr.left) strip.scrollLeft -= sr.left - er.left
  else if (er.right > sr.right) strip.scrollLeft += er.right - sr.right
})

// Internal [label](help:id) / auto-links open (or focus) a tab.
function onBodyClick(e) {
  const help = e.target.closest('a[data-help-id]')
  if (help) { e.preventDefault(); hidePreview(); openGlossary(help.dataset.helpId); return }
  const g = e.target.closest('a[data-guide-id]')
  if (g) { e.preventDefault(); hidePreview(); openGuide(g.dataset.guideId) }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="overlay" @click.self="glossary.close()" @keydown.esc="glossary.close()">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Glossary">
        <div class="modal-header">
          <span class="modal-title">Glossary</span>
          <input
            v-model="query"
            class="search"
            type="search"
            placeholder="Search terms…"
            @input="onSearch"
          >
          <button class="modal-close" title="Close" @click="glossary.close()">×</button>
        </div>

        <div class="tab-strip" role="tablist">
          <button
            class="gtab gtab-home"
            :class="{ active: activeId === 'home' }"
            role="tab"
            @click="glossary.setActive('home')"
          >Home</button>
          <div ref="tabScroll" class="tab-scroll">
            <button
              v-for="t in tabEntries"
              :key="t.id"
              class="gtab"
              :class="{ active: activeId === t.id }"
              role="tab"
              @click="glossary.setActive(t.id)"
            >
              {{ t.entry?.title ?? t.id }}
              <span class="gtab-close" title="Close tab" @click.stop="glossary.closeTab(t.id)">×</span>
            </button>
          </div>
        </div>

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
                    >{{ e.title }}</button>
                  </div>
                </section>
                <div v-if="i < pipelineSections.length - 1" class="connector" aria-hidden="true"></div>
              </template>
              <section v-for="s in extraSections" :key="s.topic" class="stage stage-extra">
                <div class="stage-head">
                  <div class="stage-text"><h3 class="stage-title">{{ s.label }}</h3></div>
                </div>
                <div class="chips">
                  <button
                    v-for="e in s.entries"
                    :key="e.id"
                    class="chip"
                    :title="e.summary"
                    @click="glossary.openTerm(e.id)"
                  >{{ e.title }}</button>
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
            <p v-else class="empty">No glossary entry found for “{{ activeId }}”.</p>
          </template>
        </div>
      </div>
      <GlossaryTooltip
        v-if="previewVisible"
        ref="previewTooltip"
        :anchor="previewAnchor"
        :title="previewTitle"
        :summary-html="previewSummary"
        :pinned="previewPinned"
        :ring-ms="previewRingMs"
        @read-more="readPreview"
        @link="previewGlossary"
        @guide-link="previewGuide"
      />
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
.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }
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
  background: none; border: none; color: var(--text-dim);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 1px 6px; border-radius: 4px;
}
.modal-close:hover { background: var(--hover-bg); color: var(--text); }

/* Home sits outside the scroll area (fixed); only the term tabs scroll. */
.tab-strip {
  display: flex;
  padding: 6px 0 0;
  border-bottom: 1px solid var(--panel-border);
  flex-shrink: 0;
}
.tab-scroll {
  display: flex;
  gap: 2px;
  flex: 1;
  min-width: 0;
  padding: 0 10px 0 8px;
  overflow-x: auto;
  /* overflow-x:auto alone makes the browser compute overflow-y to auto too,
     which adds a stray vertical scrollbar and fights touchpad h-scroll. */
  overflow-y: hidden;
  scrollbar-width: thin;
}
.gtab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  background: none;
  border: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 12.5px;
  /* Extra bottom padding gives the thin horizontal scrollbar its own lane so it
     doesn't crowd the tab text. Active underline is an inset shadow (not a
     border) so it survives overflow-y:hidden without a negative-margin trick. */
  padding: 7px 10px 11px;
  cursor: pointer;
}
/* Home is fixed at the left, divided from the scrolling tabs by a thin rule. */
.gtab-home {
  flex-shrink: 0;
  padding-left: 12px;
  border-right: 1px solid var(--panel-border);
}
.gtab:hover:not(.active) { color: var(--text); }
.gtab.active { color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
.gtab-close {
  font-size: 13px; line-height: 1; color: var(--text-dim);
  border-radius: 3px; padding: 0 2px;
}
.gtab-close:hover { background: var(--hover-bg); color: var(--text); }

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 18px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}
.empty { color: var(--text-dim); font-style: italic; }

/* ── Pipeline map (home, no query) ── */
.map-intro { margin: 0 0 12px; font-size: 12px; color: var(--text-dim); }
.stage {
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--hover-bg);
}
.stage-extra { margin-top: 14px; }
.stage-head { display: flex; align-items: flex-start; gap: 9px; margin-bottom: 8px; }
.stage-icon { font-size: 17px; line-height: 1.25; }
.stage-text { min-width: 0; }
.stage-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--text); }
.stage-blurb { margin: 1px 0 0; font-size: 11.5px; color: var(--text-dim); line-height: 1.4; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
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
.chip:hover { border-color: var(--accent); color: var(--accent); }
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
.index-list { list-style: none; margin: 0; padding: 0; }
.index-item {
  display: flex; flex-direction: column; gap: 2px;
  width: 100%; text-align: left;
  background: none; border: none; border-radius: 6px;
  padding: 8px 10px; cursor: pointer; font: inherit;
}
.index-item:hover { background: var(--hover-bg); }
.index-title { font-size: 13px; font-weight: 600; color: var(--text); }
.index-summary { font-size: 11.5px; color: var(--text-dim); line-height: 1.4; }

.term-body :deep(a.glossary-link) { color: var(--accent); cursor: pointer; text-decoration: underline dotted; }
.term-body :deep(a) { color: var(--accent); }
.term-body :deep(p) { margin: 0 0 10px; }
.term-body :deep(h1), .term-body :deep(h2), .term-body :deep(h3) {
  font-size: 14px; color: var(--text); margin: 16px 0 7px;
}
.term-body :deep(code) {
  background: var(--hover-bg); border-radius: 4px; padding: 1px 4px; font-size: 12px;
}
.term-body :deep(img.glossary-img) {
  max-width: 100%; height: auto; border-radius: 6px; margin: 6px 0;
}
</style>
