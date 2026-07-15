<script setup>
// Shared modal chrome (WS5): overlay + centered panel + header (title/close) + scrollable
// body slot + footer slot. Preserves the two behaviours every modal relied on: click on
// the backdrop closes (@click.self), and Escape closes (@keydown.esc). useModalEscape
// still works unchanged — it drives the store flags that mount/unmount this shell.
defineProps({
  title: { type: String, required: true },
  ariaLabel: { type: String, default: '' },
})
const emit = defineEmits(['close'])
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" :aria-label="ariaLabel || title">
      <div class="modal-header">
        <span class="modal-title">{{ title }}</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
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
