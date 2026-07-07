<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import { useGuideStore } from '../../stores/useGuideStore.js'
import { useGlossaryStore } from '../../stores/useGlossaryStore.js'
import { getGuideDoc, getAllGuideDocs, searchGuide, renderGuide } from '../../core/guide.js'

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

const activeDoc = computed(() => (activeId.value === 'home' ? null : getGuideDoc(activeId.value)))
const introHtml = computed(() => (activeDoc.value ? renderGuide(activeDoc.value.intro) : ''))
const sections = computed(() =>
  activeDoc.value ? activeDoc.value.order.map(k => {
    const p = activeDoc.value.params.get(k)
    return { key: k, label: p.label, html: renderGuide(p.body), defaultText: p.defaultText }
  }) : [])

const tabDocs = computed(() => tabs.value.map(id => ({ id, doc: getGuideDoc(id) })))

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
  if (help) { e.preventDefault(); glossary.openTerm(help.dataset.helpId); return }
  const g = e.target.closest('a[data-guide-id]')
  if (g) { e.preventDefault(); guide.openOp(g.dataset.guideId) }
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
            <p v-if="!results.length" class="empty">No operations match “{{ query }}”.</p>
            <ul v-else class="index-list">
              <li v-for="d in results" :key="d.id">
                <button class="index-item" @click="guide.openOp(d.id)">
                  <span class="index-title">{{ d.title }}</span>
                  <span class="index-summary">{{ d.summary }}</span>
                </button>
              </li>
            </ul>
          </template>

          <!-- An operation -->
          <template v-else-if="activeDoc">
            <div class="guide-body" @click="onBodyClick">
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
  width: 640px; max-width: 92vw;
  height: 560px; max-height: 88vh;
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
.guide-body :deep(code) { background: var(--hover-bg); border-radius: 4px; padding: 1px 4px; font-size: 12px; }
.guide-body :deep(img.glossary-img) { max-width: 100%; height: auto; border-radius: 6px; margin: 6px 0; }
</style>
