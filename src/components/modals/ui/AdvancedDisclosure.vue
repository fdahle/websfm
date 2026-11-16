<script setup>
// Collapsible "Advanced" section (WS5), harvested from the DetectFeaturesModal <details>
// pattern. A link-styled toggle reveals its slotted fields. `open` is internal state;
// its initial value is the user's "Expand advanced settings by default" preference
// (Settings ▸ Display, via useUiSettings), unless the caller forces `default-open`.
import { t, tx } from '../../../composables/useI18n.js'
import { ref } from 'vue'
import { useUiSettings } from '../../../composables/useUiSettings.js'
const props = defineProps({
  // A string or a message (core/i18n); none reads "Advanced".
  label: { type: [String, Object], default: '' },
  defaultOpen: { type: Boolean, default: false },
})
const { advancedSettingsExpanded } = useUiSettings()
const open = ref(props.defaultOpen || advancedSettingsExpanded.value)
</script>

<template>
  <button class="link-btn" @click="open = !open">{{ open ? '▾' : '▸' }} {{ tx(label) || t('common.advanced') }}</button>
  <template v-if="open"><slot /></template>
</template>

<style scoped src="./modal.css"></style>
