<script setup>
import 'katex/dist/katex.min.css'
import { ref, computed, watch, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import { useGuideStore } from '../../stores/useGuideStore.js'
import { useGlossaryStore } from '../../stores/useGlossaryStore.js'
import { useHelpLinkPreview } from '../../composables/useHelpLinkPreview.js'
import { getGuideDoc, getAllGuideDocs, searchGuide, renderGuide } from '../../core/help/guide.js'
import GlossaryTooltip from '../glossary/GlossaryTooltip.vue'

// Single centered modal holding the Guide. A Home/index tab lists every pipeline
// operation; each opened operation gets a closeable tab showing its intro plus one
// section per parameter (anchored by key so a field's `?` can scroll straight to
// it). Mirrors GlossaryModal; cross-links reach the glossary or another operation.
const guide = useGuideStore()
const glossary = useGlossaryStore()
const { isOpen, tabs, activeId, focusParam } = storeToRefs(guide)

const query = ref('')
function onSearch() { guide.setActive('home') }
const results = computed(() => (query.value.trim() ? searchGuide(query.value) : getAllGuideDocs()))
const groupedResults = computed(() => {
  const groups = []
  for (const doc of results.value) {
    let group = groups.find(g => g.name === doc.category)
    if (!group) {
      group = { name: doc.category, docs: [] }
      groups.push(group)
    }
    group.docs.push(doc)
  }
  return groups
})

const activeDoc = computed(() => (activeId.value === 'home' ? null : getGuideDoc(activeId.value)))
const introHtml = computed(() => (activeDoc.value ? renderGuide(activeDoc.value.intro) : ''))
const sections = computed(() =>
  activeDoc.value ? activeDoc.value.order.map(k => {
    const p = activeDoc.value.params.get(k)
    return { key: k, label: p.label, html: renderGuide(p.body), defaultText: p.defaultText }
  }) : [])

const tabDocs = computed(() => tabs.value.map(id => ({ id, doc: getGuideDoc(id) })))

// Guide and Glossary are peer browsers. Switch between them instead of stacking
// two same-z-index dialogs; each store retains its tabs for the next visit.
function openGlossary(id) { guide.close(); glossary.openTerm(id) }
function openGuide(id) { glossary.close(); guide.openOp(id) }
const {
  RING_MS: previewRingMs, anchor: previewAnchor, visible: previewVisible,
  pinned: previewPinned, tooltipRef: previewTooltip, title: previewTitle,
  summaryHtml: previewSummary, onMouseOver: onPreviewOver, onMouseOut: onPreviewOut,
  hide: hidePreview, readMore: readPreview, followGlossary: previewGlossary,
  followGuide: previewGuide,
} = useHelpLinkPreview({ openGlossary, openGuide })

const bodyEl = ref(null)

// After the active tab / focus param changes, scroll the requested section into
// view (or the top for a fresh tab). nextTick so the v-html sections exist.
watch([activeId, focusParam], async () => {
  await nextTick()
  if (!bodyEl.value) return
  if (focusParam.value) {
    const target = bodyEl.value.querySelector(`[data-param="${CSS.escape(focusParam.value)}"]`)
    if (target) { target.scrollIntoView({ block: 'start' }); return }
  }
  bodyEl.value.scrollTop = 0
})

// help: links open the glossary; guide: links open/focus another operation tab.
function onBodyClick(e) {
  const help = e.target.closest('a[data-help-id]')
  if (help) { e.preventDefault(); hidePreview(); openGlossary(help.dataset.helpId); return }
  const g = e.target.closest('a[data-guide-id]')
  if (g) { e.preventDefault(); hidePreview(); openGuide(g.dataset.guideId) }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="overlay" @click.self="guide.close()" @keydown.esc="guide.close()">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Guide">
        <div class="modal-header">
          <span class="modal-title">Guide</span>
          <input
            v-model="query"
            class="search"
            type="search"
            placeholder="Search operations…"
            @input="onSearch"
          >
          <button class="modal-close" title="Close" @click="guide.close()">×</button>
        </div>

        <div class="tab-strip" role="tablist">
          <button class="gtab" :class="{ active: activeId === 'home' }" role="tab" @click="guide.setActive('home')">Home</button>
          <button
            v-for="t in tabDocs"
            :key="t.id"
            class="gtab"
            :class="{ active: activeId === t.id }"
            role="tab"
            @click="guide.setActive(t.id)"
          >
            {{ t.doc?.title ?? t.id }}
            <span class="gtab-close" title="Close tab" @click.stop="guide.closeTab(t.id)">×</span>
          </button>
        </div>

        <div ref="bodyEl" class="modal-body">
          <!-- Home / index + search -->
          <template v-if="activeId === 'home'">
            <div v-if="!query.trim()" class="guide-hero">
              <div>
                <span class="hero-kicker">FROM PHOTOS TO PRODUCTS</span>
                <h2>What would you like to make?</h2>
                <p>Follow the complete reconstruction path, or jump straight to the step you are working on.</p>
              </div>
              <button class="hero-action" @click="guide.openOp('getting-started')">Start here <span>→</span></button>
            </div>
            <p v-if="!results.length" class="empty">No operations match “{{ query }}”.</p>
            <section v-for="group in groupedResults" v-else :key="group.name" class="guide-group">
              <h3 class="group-title">{{ group.name }}</h3>
              <div class="index-grid">
                <button v-for="d in group.docs" :key="d.id" class="index-item" @click="guide.openOp(d.id)">
                  <span class="index-title">{{ d.title }} <span class="card-arrow">→</span></span>
                  <span class="index-summary">{{ d.summary }}</span>
                </button>
              </div>
            </section>
          </template>

          <!-- An operation -->
          <template v-else-if="activeDoc">
            <div class="guide-body" @click="onBodyClick" @mouseover="onPreviewOver" @mouseout="onPreviewOut">
              <div v-if="introHtml" class="guide-intro" v-html="introHtml"></div>
              <section v-for="s in sections" :key="s.key" :data-param="s.key" class="guide-param">
                <h3 class="param-label">{{ s.label }}</h3>
                <div v-html="s.html"></div>
                <p v-if="s.defaultText" class="param-default">Default: <code>{{ s.defaultText }}</code></p>
              </section>
            </div>
          </template>

          <p v-else class="empty">No guide found for “{{ activeId }}”.</p>
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
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 400;
}
.modal {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  width: 760px; max-width: 92vw;
  height: 650px; max-height: 88vh;
  display: flex; flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}
.modal-header {
  display: flex; align-items: center; gap: 10px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--panel-border);
  flex-shrink: 0;
}
.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }
.search {
  margin-left: auto; width: 220px;
  background: var(--input-bg, var(--panel));
  border: 1px solid var(--panel-border);
  border-radius: 6px; color: var(--text);
  font: inherit; font-size: 12px; padding: 5px 9px;
}
.modal-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 1px 6px; border-radius: 4px;
}
.modal-close:hover { background: var(--hover-bg); color: var(--text); }

.tab-strip {
  display: flex; gap: 2px;
  padding: 6px 10px 0;
  border-bottom: 1px solid var(--panel-border);
  overflow-x: auto; flex-shrink: 0;
}
.gtab {
  display: inline-flex; align-items: center; gap: 6px;
  white-space: nowrap; background: none; border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-dim); font: inherit; font-size: 12.5px;
  padding: 7px 10px; margin-bottom: -1px; cursor: pointer;
}
.gtab:hover:not(.active) { color: var(--text); }
.gtab.active { color: var(--text); border-bottom-color: var(--accent); }
.gtab-close { font-size: 13px; line-height: 1; color: var(--text-dim); border-radius: 3px; padding: 0 2px; }
.gtab-close:hover { background: var(--hover-bg); color: var(--text); }

.modal-body {
  flex: 1; overflow-y: auto;
  padding: 14px 18px;
  font-size: 13px; line-height: 1.6; color: var(--text);
}
.empty { color: var(--text-dim); font-style: italic; }

.guide-hero {
  display: flex; align-items: center; justify-content: space-between; gap: 22px;
  padding: 20px; margin-bottom: 20px; border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--panel-border));
  border-radius: 10px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 13%, var(--panel)), var(--panel));
}
.hero-kicker { font-size: 10px; font-weight: 700; letter-spacing: .12em; color: var(--accent); }
.guide-hero h2 { font-size: 19px; line-height: 1.25; margin: 4px 0 5px; }
.guide-hero p { max-width: 470px; margin: 0; color: var(--text-dim); font-size: 12.5px; }
.hero-action {
  flex: none; border: none; border-radius: 7px; background: var(--accent); color: white;
  padding: 9px 12px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
}
.hero-action span { margin-left: 5px; }
.guide-group { margin: 0 0 20px; }
.group-title {
  margin: 0 0 8px; color: var(--text-dim); font-size: 10.5px; font-weight: 700;
  letter-spacing: .09em; text-transform: uppercase;
}
.index-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.index-item {
  display: flex; flex-direction: column; gap: 2px;
  width: 100%; text-align: left;
  background: var(--bg); border: 1px solid var(--panel-border); border-radius: 7px;
  padding: 10px 11px; cursor: pointer; font: inherit;
}
.index-item:hover { background: var(--hover-bg); border-color: color-mix(in srgb, var(--accent) 45%, var(--panel-border)); }
.index-title { font-size: 13px; font-weight: 600; color: var(--text); }
.card-arrow { float: right; color: var(--accent); opacity: 0; transition: opacity .12s; }
.index-item:hover .card-arrow { opacity: 1; }
.index-summary { font-size: 11.5px; color: var(--text-dim); line-height: 1.4; }

.guide-intro { margin-bottom: 6px; }
.guide-param {
  padding: 12px 0;
  border-top: 1px solid var(--panel-border);
  scroll-margin-top: 8px;
}
.param-label { font-size: 13px; font-weight: 600; color: var(--text); margin: 0 0 6px; }
.param-default { font-size: 11.5px; color: var(--text-dim); margin: 6px 0 0; }

.guide-body :deep(a.glossary-link),
.guide-body :deep(a.guide-link) { color: var(--accent); cursor: pointer; text-decoration: underline dotted; }
.guide-body :deep(a) { color: var(--accent); }
.guide-body :deep(p) { margin: 0 0 10px; }
.guide-body :deep(ul), .guide-body :deep(ol) { margin: 5px 0 12px; padding-left: 21px; }
.guide-body :deep(li) { margin: 3px 0; }
.guide-body :deep(strong) { color: var(--text); }
.guide-body :deep(code) { background: var(--hover-bg); border-radius: 4px; padding: 1px 4px; font-size: 12px; }
.guide-body :deep(img.glossary-img) { max-width: 100%; height: auto; border-radius: 6px; margin: 6px 0; }

@media (max-width: 620px) {
  .guide-hero { align-items: flex-start; flex-direction: column; }
  .index-grid { grid-template-columns: 1fr; }
}
</style>
