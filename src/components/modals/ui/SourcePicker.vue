<script setup>
// The cloud / mesh a tool dialog acts on: a labelled <select> over `items`, bound to
// the `id` of composables/useSourcePick.js (which keeps it on a valid item).
//   variant 'field'  (default) a SettingsField — label, select, optional hint
//           'inline' Build Mesh's one-line "Source  <pick>" row: the select when there
//                    is a choice, the single item as plain text when there is not
// `optionLabel` words each item (see useSourcePick.js for the shared ones).
import SettingsField from './SettingsField.vue'
import { cloudOptionLabel } from '../../../composables/useSourcePick.js'

defineProps({
  id: { type: String, required: true },
  label: { type: String, default: 'Source' },
  hint: { type: String, default: '' },
  items: { type: Array, default: () => [] },
  optionLabel: { type: Function, default: cloudOptionLabel },
  variant: { type: String, default: 'field' },
})
const model = defineModel({ default: null })
</script>

<template>
  <div v-if="variant === 'inline'" class="source-row">
    <label class="field-label" :for="id">{{ label }}</label>
    <select v-if="items.length > 1" :id="id" v-model="model" class="field-select source-select">
      <option v-for="it in items" :key="it.id" :value="it.id">{{ optionLabel(it) }}</option>
    </select>
    <span v-else-if="items.length" class="field-hint source-value">{{ optionLabel(items[0]) }}</span>
  </div>
  <SettingsField v-else :label="label" :label-for="id" :hint="hint">
    <select :id="id" v-model="model" class="field-select">
      <option v-for="it in items" :key="it.id" :value="it.id">{{ optionLabel(it) }}</option>
    </select>
  </SettingsField>
</template>

<style scoped src="./modal.css"></style>
<style scoped>
/* Inline: a statement or a short pick, not a settings field — label and value on one line. */
.source-row { display: flex; align-items: baseline; gap: 8px; }
.source-value { color: var(--text); }
.source-select { flex: 1; min-width: 0; }
</style>
