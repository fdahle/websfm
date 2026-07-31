<script setup>
// A row of selectable option cards — SegmentedControl's richer sibling, for a setting
// whose options are easier to recognise than to read (each card can carry a small
// example picture via the `visual` slot) or that need a one-line blurb.
//
// Presentational: v-model binds the selected option id, exactly like SegmentedControl.
// Unlike PresetCards this sets ONE setting, so there is no "· modified" state — the
// selected card simply is the current value.
//   options: [{ id, label, blurb?, disabled? }]
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
      :disabled="o.disabled"
      @click="!o.disabled && $emit('update:modelValue', o.id)"
    >
      <span v-if="$slots.visual" class="choice-card-visual"><slot name="visual" :option="o" /></span>
      <span class="choice-card-label">{{ o.label }}</span>
      <span v-if="o.blurb" class="choice-card-blurb">{{ o.blurb }}</span>
    </button>
  </div>
</template>

<style scoped src="./modal.css"></style>
