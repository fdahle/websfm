<script setup>
import { onBeforeUnmount, onMounted } from 'vue'
import { matches } from '../../core/help/shortcuts.js'

// A tab strip's right-click menu (useTabDrag's tabCtx): Close, Close others, to the
// left, to the right, all. The workspace's tabs use it, and the Guide's and the
// Glossary's (HelpTabStrip). Above the help dialogs, which it may open over.
defineProps({
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  hasOthers: { type: Boolean, default: false },
  hasLeft: { type: Boolean, default: false },
  hasRight: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'close-others', 'close-left', 'close-right', 'close-all', 'dismiss'])

function pick(event) {
  emit(event)
  emit('dismiss')
}

// The menu answers Escape and outside clicks before anything else sees them.
// Capture phase: the viewers below (3D selection, measuring) also listen on window,
// and a help dialog closes on Escape, so a bubbling listener would let them act on
// the same press that only meant to close the menu.
function onKeydown(e) {
  if (!matches(e, 'app.escape')) return
  emit('dismiss')
  e.preventDefault()
  e.stopImmediatePropagation()
}
const onDocumentClick = () => emit('dismiss')
onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  document.addEventListener('click', onDocumentClick)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('click', onDocumentClick)
})
</script>

<template>
  <!-- data-modal-exempt: teleported out of the Guide or Glossary dialog, so the modal
       focus trap (utils/modalFocus.js) would otherwise make it inert. -->
  <Teleport to="body">
    <div class="tab-ctx-menu" :style="{ left: x + 'px', top: y + 'px' }" data-modal-exempt @click.stop>
      <button class="tab-ctx-item" @click="pick('close')">Close</button>
      <button class="tab-ctx-item" :disabled="!hasOthers" @click="pick('close-others')">Close others</button>
      <button class="tab-ctx-item" :disabled="!hasLeft" @click="pick('close-left')">Close to the left</button>
      <button class="tab-ctx-item" :disabled="!hasRight" @click="pick('close-right')">Close to the right</button>
      <div class="tab-ctx-sep" />
      <button class="tab-ctx-item" @click="pick('close-all')">Close all</button>
    </div>
  </Teleport>
</template>

<style scoped>
.tab-ctx-menu {
  position: fixed;
  z-index: 600;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 4px;
  min-width: 140px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.tab-ctx-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.tab-ctx-item:hover:not(:disabled) {
  background: var(--hover-bg);
}
.tab-ctx-item:disabled {
  opacity: 0.35;
  cursor: default;
}
.tab-ctx-sep {
  height: 1px;
  background: var(--panel-border);
  margin: 4px 0;
}
</style>
