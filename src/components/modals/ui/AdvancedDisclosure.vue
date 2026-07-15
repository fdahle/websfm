<script setup>
// Collapsible "Advanced" section (WS5), harvested from the DetectFeaturesModal <details>
// pattern. A link-styled toggle reveals its slotted fields. `open` is internal state;
// pass `default-open` to start expanded.
import { ref } from 'vue'
const props = defineProps({
  label: { type: String, default: 'Advanced' },
  defaultOpen: { type: Boolean, default: false },
})
const open = ref(props.defaultOpen)
</script>

<template>
  <button class="link-btn" @click="open = !open">
    {{ open ? '▾' : '▸' }} {{ label }}
  </button>
  <template v-if="open"><slot /></template>
</template>

<style scoped src="./modal.css"></style>
