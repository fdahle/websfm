<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { useGlossarySettings } from '../../composables/useGlossarySettings.js'
import { getGlossaryEntry } from '../../core/help/glossary.js'
import { openHelp, leaveHelp, dropHelp, glossarySpec } from '../../composables/useHelpStack.js'

// Inline glossary keyword. Hovering opens the term's popup (see useHelpStack.js)
// with a progress ring; once the ring fills the popup pins (stays open, becomes
// clickable, and its own links open popups on top). The term itself is NOT a
// click target — the only way into the full modal is the popup's "Read more".
// Missing entries (or the feature disabled in Settings) degrade to plain text.
const props = defineProps({ id: { type: String, required: true } })

const { glossaryTermsEnabled } = useGlossarySettings()
const active = computed(() => glossaryTermsEnabled.value && !!getGlossaryEntry(props.id))

const anchorEl = ref(null)

function onMouseEnter() {
  if (active.value) openHelp(0, glossarySpec(props.id, anchorEl.value))
}
function onMouseLeave() {
  leaveHelp(anchorEl.value)
}

onBeforeUnmount(() => dropHelp(anchorEl.value))
</script>

<template>
  <span
    ref="anchorEl"
    class="glossary-term"
    :class="{ 'glossary-term-plain': !active }"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <slot />
  </span>
</template>

<style scoped>
.glossary-term {
  border-bottom: 1px dashed var(--text-dim);
  cursor: help;
}
.glossary-term:hover {
  color: var(--accent);
  border-color: var(--accent);
}
/* Disabled feature or missing entry: render as ordinary text. */
.glossary-term-plain {
  border-bottom: none;
  cursor: inherit;
  color: inherit;
}
</style>
