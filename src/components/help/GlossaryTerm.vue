<script setup>
import { ref } from 'vue'
import { useHelpStore } from '../../stores/useHelpStore.js'
import { getHelpEntry } from '../../core/help.js'
import HelpTooltip from './HelpTooltip.vue'

const props = defineProps({ id: { type: String, required: true } })

const helpStore = useHelpStore()
const entry = getHelpEntry(props.id)

const anchorEl = ref(null)
const tooltipVisible = ref(false)
let hoverTimer = null

const HOVER_DELAY_MS = 450

function onMouseEnter() {
  if (!entry) return
  hoverTimer = setTimeout(() => { tooltipVisible.value = true }, HOVER_DELAY_MS)
}
function onMouseLeave() {
  clearTimeout(hoverTimer)
  tooltipVisible.value = false
}
function open() {
  clearTimeout(hoverTimer)
  tooltipVisible.value = false
  if (entry) helpStore.push(props.id)
}
</script>

<template>
  <span
    ref="anchorEl"
    class="glossary-term"
    :class="{ 'glossary-term-missing': !entry }"
    tabindex="0"
    role="button"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
    @click="open"
    @keydown.enter="open"
  >
    <slot />
    <Teleport to="body">
      <HelpTooltip
        v-if="tooltipVisible && entry"
        :anchor="anchorEl"
        :title="entry.title"
        :summary="entry.summary"
      />
    </Teleport>
  </span>
</template>

<style scoped>
.glossary-term {
  border-bottom: 1px dashed var(--text-dim);
  cursor: help;
}
.glossary-term:hover,
.glossary-term:focus-visible {
  color: var(--accent);
  border-color: var(--accent);
  outline: none;
}
/* Missing entries (bad id, or content not yet written) render as plain text
   rather than a broken affordance the user can click into nothing. */
.glossary-term-missing {
  border-bottom: none;
  cursor: inherit;
}
</style>
