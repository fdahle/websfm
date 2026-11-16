<script setup>
// A single labelled setting (WS5): label (+ optional glossary/help affordance in the
// `label` slot) · control (default slot) · optional unit · optional hint. The control is
// wrapped in an input-row when a unit is present so the unit sits inline after it.
import { tx } from '../../../composables/useI18n.js'
defineProps({
  // Each a string or a message (core/i18n).
  label: { type: [String, Object], default: '' },
  hint: { type: [String, Object], default: '' },
  unit: { type: [String, Object], default: '' },
  labelFor: { type: String, default: '' },
})
</script>

<template>
  <div class="field">
    <label v-if="label || $slots.label" class="field-label" :for="labelFor">
      <slot name="label">{{ tx(label) }}</slot>
    </label>
    <div v-if="unit" class="input-row">
      <slot />
      <span class="field-unit">{{ tx(unit) }}</span>
    </div>
    <slot v-else />
    <span v-if="hint || $slots.hint" class="field-hint"
      ><slot name="hint">{{ tx(hint) }}</slot></span
    >
  </div>
</template>

<style scoped src="./modal.css"></style>
