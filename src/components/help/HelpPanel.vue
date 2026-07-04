<script setup>
import { computed } from 'vue'
import { useHelpStore } from '../../stores/useHelpStore.js'
import { getHelpEntry, renderHelpMarkdown } from '../../core/help.js'

const props = defineProps({
  id: { type: String, required: true },
  index: { type: Number, required: true },        // position in the stack (0 = oldest)
  depthFromTop: { type: Number, required: true },  // 0 = frontmost panel
})

const helpStore = useHelpStore()
const entry = computed(() => getHelpEntry(props.id))
const html = computed(() => (entry.value ? renderHelpMarkdown(entry.value.body) : ''))

const style = computed(() => ({
  right: `${16 + props.depthFromTop * 28}px`,
  zIndex: 300 + props.index,
}))

// Clicking an internal [label](help:other-id) link pushes another panel
// instead of navigating; delegated so newly-rendered links keep working.
function onBodyClick(e) {
  const link = e.target.closest('a[data-help-id]')
  if (!link) return
  e.preventDefault()
  helpStore.push(link.dataset.helpId)
}

function close() {
  helpStore.popTo(props.index - 1)
}
</script>

<template>
  <div class="help-panel" :style="style">
    <div class="help-panel-header">
      <span class="help-panel-title">{{ entry?.title ?? id }}</span>
      <button class="help-panel-close" title="Close" @click="close">×</button>
    </div>
    <div v-if="entry" class="help-panel-body" v-html="html" @click="onBodyClick"></div>
    <div v-else class="help-panel-body help-panel-missing">No help entry found for "{{ id }}".</div>
  </div>
</template>

<style scoped>
.help-panel {
  position: fixed;
  top: 60px;
  bottom: 24px;
  width: 320px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.help-panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid var(--panel-border);
  flex-shrink: 0;
}
.help-panel-title { font-size: 13px; font-weight: 600; color: var(--text); }
.help-panel-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 18px; line-height: 1; cursor: pointer; padding: 1px 6px; border-radius: 4px;
}
.help-panel-close:hover { background: var(--hover-bg); color: var(--text); }
.help-panel-body {
  padding: 12px 14px;
  overflow-y: auto;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text);
}
.help-panel-missing { color: var(--text-dim); font-style: italic; }
.help-panel-body :deep(a.help-link) {
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline dashed;
}
.help-panel-body :deep(p) { margin: 0 0 10px; }
.help-panel-body :deep(h1),
.help-panel-body :deep(h2),
.help-panel-body :deep(h3) {
  font-size: 13px; color: var(--text); margin: 14px 0 6px;
}
</style>
