<script setup>
// A row of mutually-exclusive option buttons (WS5), harvested from the repeated
// detector-row/detector-btn pattern. v-model binds the selected option id.
//   options: [{ id, label, disabled? }]   // a disabled option can't be selected
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
      :disabled="o.disabled"
      @click="!o.disabled && $emit('update:modelValue', o.id)"
    >{{ o.label }}</button>
  </div>
</template>

<style scoped src="./modal.css"></style>
