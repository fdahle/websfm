<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
// Shared modal chrome (WS5): overlay + centered panel + header (title/close) + scrollable
// body slot + footer slot. Preserves the two behaviours every modal relied on: click on
// the backdrop closes (@click.self), and Escape closes (@keydown.esc). useModalEscape
// still works unchanged — it drives the store flags that mount/unmount this shell.
defineProps({
  title: { type: String, required: true },
  ariaLabel: { type: String, default: '' },
})
const emit = defineEmits(['close'])
const modal = ref(null)
let returnFocus = null

const focusableSelector = [
  'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', 'a[href]', '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusables() {
  return [...(modal.value?.querySelectorAll(focusableSelector) || [])]
    .filter((el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true')
}

function trapFocus(event) {
  if (event.key !== 'Tab') return
  const items = focusables()
  if (!items.length) { event.preventDefault(); modal.value?.focus(); return }
  const first = items[0], last = items[items.length - 1]
  if (event.shiftKey && (document.activeElement === first || !modal.value?.contains(document.activeElement))) {
    event.preventDefault(); last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || !modal.value?.contains(document.activeElement))) {
    event.preventDefault(); first.focus()
  }
}

onMounted(async () => {
  returnFocus = document.activeElement
  await nextTick()
  const initial = modal.value?.querySelector('[autofocus], .modal-body input:not([disabled]), '
    + '.modal-body select:not([disabled]), .modal-body textarea:not([disabled]), '
    + '.modal-footer button:not([disabled])')
  ;(initial || focusables()[0] || modal.value)?.focus()
})

onBeforeUnmount(() => {
  const target = returnFocus
  setTimeout(() => { if (target?.isConnected) target.focus() }, 0)
})
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc.stop="emit('close')" @keydown="trapFocus">
    <div ref="modal" class="modal" role="dialog" aria-modal="true" :aria-label="ariaLabel || title" tabindex="-1">
      <div class="modal-header">
        <span class="modal-title">{{ title }}</span>
        <button class="modal-close" type="button" title="Close" aria-label="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <slot />
      </div>

      <div class="modal-footer">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style scoped src="./modal.css"></style>
