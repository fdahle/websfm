<script setup>
// A row of selectable option cards — SegmentedControl's richer sibling, for a setting
// whose options are easier to recognise than to read (each card can carry a small
// example picture via the `visual` slot) or that need a one-line blurb.
//
// Presentational: v-model binds the selected option id, exactly like SegmentedControl.
// Unlike PresetCards this sets ONE setting, so there is no "· modified" state — the
// selected card simply is the current value.
//   options: [{ id, label, blurb?, disabled?, reason? }]
// `reason` says why a disabled card cannot be chosen (its tooltip; CONTRIBUTING ▸
// Disabled controls say why).
// An option's label, blurb and reason: a string or a message (core/i18n).
import { tx } from '../../../composables/useI18n.js'
defineProps({
  modelValue: { type: [String, Number, Boolean], default: null },
  options: { type: Array, required: true },
})
defineEmits(['update:modelValue'])
</script>

<template>
  <div class="choice-cards" role="radiogroup">
    <button
      v-for="o in options"
      :key="o.id"
      type="button"
      role="radio"
      class="choice-card"
      :class="{ active: modelValue === o.id }"
      :aria-checked="modelValue === o.id"
      :data-id="o.id"
      :disabled="o.disabled"
      :title="o.disabled ? tx(o.reason) || null : null"
      @click="!o.disabled && $emit('update:modelValue', o.id)"
    >
      <span v-if="$slots.visual" class="choice-card-visual"><slot name="visual" :option="o" /></span>
      <span class="choice-card-label">{{ tx(o.label) }}</span>
      <span v-if="o.blurb" class="choice-card-blurb">{{ tx(o.blurb) }}</span>
    </button>
  </div>
</template>

<style scoped src="./modal.css"></style>
