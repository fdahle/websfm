<script setup lang="ts">
import { computed, ref } from 'vue'
// Shared modal chrome (WS5): overlay + centered panel + header (title/close) + scrollable
// body slot + footer slot. Clicking the backdrop closes (@click.self) and Escape closes
// (@keydown.esc, stopped here so App's global Escape handler does not also act).
// useModalEscape still works unchanged — it drives the store flags that mount/unmount
// this shell, and catches Escape when focus is outside the dialog.
//
//   width / height  CSS sizes for the panel (default 600px wide, content height);
//                   max 90vw / 90vh always apply. With a height the body fills the
//                   panel (and the panel clips its corners)
//   flush           no body padding or gap — for split panes, tables and graphs
//   scroll          false: the body does not scroll — an inner list does
//   dismissible     false: backdrop, Escape and × do nothing (a blocking dialog)
//   #header         replaces the title text (tabs, a subtitle, a refresh button);
//                   the close button stays
//   #footer         omitted ⇒ no footer bar at all
const props = defineProps({
  title: { type: String, required: true },
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
function close() { if (props.dismissible) emit('close') }
</script>

<template>
  <div class="overlay" @click.self="close" @keydown.esc.stop="close">
    <div ref="modal" class="modal" :class="{ sized: !!height }" :style="panelStyle" role="dialog" aria-modal="true" :aria-label="ariaLabel || title" tabindex="-1">
      <div class="modal-header">
        <slot name="header"><span class="modal-title">{{ title }}</span></slot>
        <button v-if="dismissible" class="modal-close" type="button" title="Close" aria-label="Close" @click="close">×</button>
      </div>

      <div class="modal-body" :class="{ flush, fill: !!height, 'no-scroll': !scroll }">
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
.modal-header { gap: 12px; }
.modal.sized { overflow: hidden; }
.modal-body.flush { padding: 0; gap: 0; }
.modal-body.fill { flex: 1; }
.modal-body.no-scroll { overflow: hidden; }
</style>
