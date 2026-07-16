<script setup>
// Collapsible "Advanced" section (WS5), harvested from the DetectFeaturesModal <details>
// pattern. A link-styled toggle reveals its slotted fields. `open` is internal state;
// its initial value is the user's "Expand advanced settings by default" preference
// (Settings ▸ Display, via useUiSettings), unless the caller forces `default-open`.
import { ref } from 'vue'
import { useUiSettings } from '../../../composables/useUiSettings.js'
const props = defineProps({
  label: { type: String, default: 'Advanced' },
  defaultOpen: { type: Boolean, default: false },
})
const { advancedSettingsExpanded } = useUiSettings()
const open = ref(props.defaultOpen || advancedSettingsExpanded.value)
</script>

<template>
  <button class="link-btn" @click="open = !open">
    {{ open ? '▾' : '▸' }} {{ label }}
  </button>
  <template v-if="open"><slot /></template>
</template>

<style scoped src="./modal.css"></style>
