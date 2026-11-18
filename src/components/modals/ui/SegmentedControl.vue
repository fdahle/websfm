<script setup>
// A row of mutually-exclusive option buttons (WS5), harvested from the repeated
// detector-row/detector-btn pattern. v-model binds the selected option id.
//   options: [{ id, label, disabled?, reason? }]   // a disabled option can't be selected;
//   `reason` is its tooltip, saying why (docs/conventions.md ▸ Disabled controls say why)
// An option's label and reason: a string or a message (core/i18n).
import { tx } from '../../../composables/useI18n.js'
defineProps({
  modelValue: { type: [String, Number, Boolean], default: null },
  options: { type: Array, required: true },
})
defineEmits(['update:modelValue'])
</script>

<template>
  <div class="seg-row">
    <button
      v-for="o in options"
      :key="o.id"
      type="button"
      class="seg-btn"
      :class="{ active: modelValue === o.id }"
      :aria-pressed="modelValue === o.id"
      :disabled="o.disabled"
      :title="o.disabled ? tx(o.reason) || null : null"
      @click="!o.disabled && $emit('update:modelValue', o.id)"
    >
      {{ tx(o.label) }}
    </button>
  </div>
</template>

<style scoped src="./modal.css"></style>
