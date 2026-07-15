<script setup>
// Quality-preset chips (WS5): Low / Medium / High (+ a Custom indicator). Presentational —
// the parent owns the settings and the active id. Clicking a preset emits `select` with its
// id; the parent applies that preset's deltas over the base defaults. When the user then
// edits any field the parent detects the deviation and sets modelValue to 'custom', which
// lights the Custom chip (not itself clickable — there's nothing to apply).
//   presets: [{ id, label }]  (e.g. [{id:'low',label:'Low'}, …])
defineProps({
  modelValue: { type: String, default: 'medium' }, // active preset id, or 'custom'
  presets: { type: Array, required: true },
})
defineEmits(['select'])
</script>

<template>
  <div class="field">
    <span class="field-label">Quality preset</span>
    <div class="seg-row">
      <button
        v-for="p in presets"
        :key="p.id"
        type="button"
        class="seg-btn"
        :class="{ active: modelValue === p.id }"
        @click="$emit('select', p.id)"
      >{{ p.label }}</button>
      <span class="seg-btn custom" :class="{ active: modelValue === 'custom' }">Custom</span>
    </div>
  </div>
</template>

<style scoped src="./modal.css"></style>
<style scoped>
.custom { cursor: default; }
.custom:hover { background: none; }
.custom.active { background: var(--accent); border-color: var(--accent); color: #fff; }
</style>
