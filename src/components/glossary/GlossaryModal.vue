<script setup>
import { ref, computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useGlossaryStore } from '../../stores/useGlossaryStore.js'
import {
  getHelpEntry, getAllHelpEntries, searchGlossary, renderHelpMarkdown,
} from '../../core/help/glossary.js'

// Single centered modal holding the glossary. A Home/index tab plus one tab per
// opened term (unlimited, closeable). Cross-links inside a term open more tabs.
const glossary = useGlossaryStore()
const { isOpen, tabs, activeId } = storeToRefs(glossary)

const query = ref('')

// Typing in search jumps to Home so the results are visible.
function onSearch() { glossary.setActive('home') }

const results = computed(() => (query.value.trim() ? searchGlossary(query.value) : getAllHelpEntries()))

const activeEntry = computed(() => (activeId.value === 'home' ? null : getHelpEntry(activeId.value)))
const activeHtml = computed(() =>
  activeEntry.value ? renderHelpMarkdown(activeEntry.value.body, { selfId: activeEntry.value.id }) : '')

const tabEntries = computed(() => tabs.value.map(id => ({ id, entry: getHelpEntry(id) })))

// Internal [label](help:id) / auto-links open (or focus) a tab.
function onBodyClick(e) {
  const link = e.target.closest('a[data-help-id]')
  if (!link) return
  e.preventDefault()
  glossary.openTerm(link.dataset.helpId)
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
            class="gtab"
            :class="{ active: activeId === 'home' }"
            role="tab"
            @click="glossary.setActive('home')"
          >Home</button>
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

        <div class="modal-body">
          <!-- Home / index + search results -->
          <template v-if="activeId === 'home'">
            <p v-if="!results.length" class="empty">No terms match “{{ query }}”.</p>
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
            <div v-if="activeEntry" class="term-body" v-html="activeHtml" @click="onBodyClick"></div>
            <p v-else class="empty">No glossary entry found for “{{ activeId }}”.</p>
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

.tab-strip {
  display: flex;
  gap: 2px;
  padding: 6px 10px 0;
  border-bottom: 1px solid var(--panel-border);
  overflow-x: auto;
  flex-shrink: 0;
}
.gtab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12.5px;
  padding: 7px 10px;
  margin-bottom: -1px;
  cursor: pointer;
}
.gtab:hover:not(.active) { color: var(--text); }
.gtab.active { color: var(--text); border-bottom-color: var(--accent); }
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
