<script setup lang="ts">
import { computed, ref } from 'vue'
import { useModalStackEntry } from '../../../composables/useModalStack.js'
import { t } from '../../../composables/useI18n.js'
// Shared modal chrome (WS5): overlay + centered panel + header (title/close) + scrollable
// body slot + footer slot. Clicking the backdrop closes (@click.self) and Escape closes
// (@keydown.esc, stopped here so App's global Escape handler does not also act). While
// mounted, the shell is on the modal stack (composables/useModalStack.js), so Escape
// with the focus outside it closes it too when it is the newest modal.
//
//   width / height  CSS sizes for the panel (default 600px wide, content height);
//                   max 90vw / 90vh always apply. With a height the body fills the
//                   panel (and the panel clips its corners)
//   flush           no body padding or gap — for split panes, tables and graphs
//   scroll          false: the body does not scroll — an inner list does
//   dismissible     false: backdrop, Escape and × do nothing (a blocking dialog)
//   subtitle        a dim line under the title (counts, the CRS a table is in)
//   #badge          after the title text (an Experimental badge)
//   #actions        the header's controls, between the title and × (the presets
//                   menu, a refresh button, a view toggle)
//   #tabs           a row of tabs under the header, styled as the ribbon's: put
//                   <button class="modal-tab" :class="{ active }"> in it
//   #footer         omitted ⇒ no footer bar at all
//
// Every dialog's title is this one element, so they all look alike: there is no slot
// that replaces it (docs/conventions.md ▸ Dialogs).
const props = defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
  ariaLabel: { type: String, default: '' },
  width: { type: String, default: '' },
  height: { type: String, default: '' },
  flush: { type: Boolean, default: false },
  scroll: { type: Boolean, default: true },
  dismissible: { type: Boolean, default: true },
})
const emit = defineEmits(['close'])
const modal = ref(null)
const panelStyle = computed(() => ({
  ...(props.width ? { width: props.width } : {}),
  ...(props.height ? { height: props.height } : {}),
}))
function close() {
  if (props.dismissible) emit('close')
}
useModalStackEntry(close)
</script>

<template>
  <div class="overlay" @click.self="close" @keydown.esc.stop="close">
    <div
      ref="modal"
      class="modal"
      :class="{ sized: !!height }"
      :style="panelStyle"
      role="dialog"
      aria-modal="true"
      :aria-label="ariaLabel || title"
      tabindex="-1"
    >
      <div class="modal-header">
        <div class="modal-heading">
          <span class="modal-title" :title="title"
            ><span class="modal-title-text">{{ title }}</span
            ><slot name="badge"
          /></span>
          <span v-if="subtitle" class="modal-subtitle" :title="subtitle">{{ subtitle }}</span>
        </div>
        <div v-if="$slots.actions" class="modal-actions"><slot name="actions" /></div>
        <button
          v-if="dismissible"
          class="modal-close"
          type="button"
          :title="t('common.close')"
          :aria-label="t('common.close')"
          @click="close"
        >
          ×
        </button>
      </div>

      <div v-if="$slots.tabs" class="modal-tabs" role="tablist"><slot name="tabs" /></div>

      <div class="modal-body" :class="{ flush, 'fill': !!height, 'no-scroll': !scroll }">
        <slot />
      </div>

      <div v-if="$slots.footer" class="modal-footer">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style scoped src="./modal.css"></style>
<style scoped>
.modal-header {
  gap: 12px;
}
.modal-heading {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.modal-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.modal-title-text,
.modal-subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.modal-subtitle {
  color: var(--text-dim);
  font-size: 12px;
}
.modal-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
/* Tabs as the ribbon's (layout/Ribbon.vue .tab): plain text, the active one underlined
   in the accent colour, on the row's bottom border. */
.modal-tabs {
  display: flex;
  gap: 2px;
  padding: 0 16px;
  border-bottom: 1px solid var(--panel-border);
}
.modal-tabs :slotted(.modal-tab) {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  padding: 8px 12px 7px;
  cursor: pointer;
}
.modal-tabs :slotted(.modal-tab:hover) {
  color: var(--text);
}
.modal-tabs :slotted(.modal-tab.active) {
  color: var(--text);
  border-bottom-color: var(--accent);
}
.modal.sized {
  overflow: hidden;
}
.modal-body.flush {
  padding: 0;
  gap: 0;
}
.modal-body.fill {
  flex: 1;
}
.modal-body.no-scroll {
  overflow: hidden;
}
</style>
