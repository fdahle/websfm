<script setup>
// A named group of fields (WS5, redesign): a small caps heading over a set of related
// SettingsFields, so the modal reads as purpose-grouped sections ("Registration",
// "Optimization", …) rather than a flat divided checklist. Replaces the bare-divider
// SettingsSection for grouped content. Renders the heading then its slotted fields.
import { tx } from '../../../composables/useI18n.js'
defineProps({
  title: { type: [String, Object], required: true }, // a string or a message (core/i18n)
})
</script>

<template>
  <div class="settings-group">
    <div class="settings-group-title">{{ tx(title) }}</div>
    <div class="settings-group-fields"><slot /></div>
  </div>
</template>

<style scoped src="./modal.css"></style>
<style scoped>
.settings-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.settings-group-title {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.settings-group-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
