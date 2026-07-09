<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { useGlossaryStore } from '../../stores/useGlossaryStore.js'
import { useGlossarySettings } from '../../composables/useGlossarySettings.js'
import { getGlossaryEntry, renderHelpMarkdown } from '../../core/help/glossary.js'
import GlossaryTooltip from './GlossaryTooltip.vue'

// Inline glossary keyword. Hovering shows a mini popup with a progress ring;
// once the ring fills the popup pins (stays open, becomes clickable). The term
// itself is NOT a click target — the only way into the full modal is the popup's
// "Read more". Missing entries (or the feature disabled in Settings) degrade to
// plain text.
const props = defineProps({ id: { type: String, required: true } })

const glossary = useGlossaryStore()
const { glossaryTermsEnabled } = useGlossarySettings()
const entry = getGlossaryEntry(props.id)
const active = computed(() => glossaryTermsEnabled.value && !!entry)

const RING_MS = 700
const summaryHtml = computed(() =>
  entry ? renderHelpMarkdown(entry.summary || '', { selfId: props.id }) : '')

const anchorEl = ref(null)
const tooltipRef = ref(null)
const visible = ref(false)
const pinned = ref(false)
let ringTimer = null

// Only one term's popup is open at a time.
let currentClose = null

function show() {
  if (!active.value) return
  if (currentClose && currentClose !== hide) currentClose()
  currentClose = hide
  visible.value = true
  pinned.value = false
  clearTimeout(ringTimer)
  ringTimer = setTimeout(pin, RING_MS)
}

function pin() {
  if (!visible.value) return
  pinned.value = true
  document.addEventListener('mousedown', onDocMouseDown, true)
  document.addEventListener('keydown', onKeydown, true)
}

function hide() {
  clearTimeout(ringTimer)
  visible.value = false
  pinned.value = false
  if (currentClose === hide) currentClose = null
  document.removeEventListener('mousedown', onDocMouseDown, true)
  document.removeEventListener('keydown', onKeydown, true)
}

function onMouseEnter() { show() }
function onMouseLeave() {
  // While the ring is still filling, leaving cancels. Once pinned, the popup
  // persists and is dismissed by click-outside / Esc / another term.
  if (!pinned.value) hide()
}

function onDocMouseDown(e) {
  if (anchorEl.value?.contains(e.target)) return
  if (tooltipRef.value?.rootEl?.contains(e.target)) return
  hide()
}
function onKeydown(e) { if (e.key === 'Escape') hide() }

function readMore() {
  hide()
  glossary.openTerm(props.id)
}
function openLinked(id) {
  hide()
  glossary.openTerm(id)
}

onBeforeUnmount(hide)
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
    <Teleport to="body">
      <GlossaryTooltip
        v-if="visible"
        ref="tooltipRef"
        :anchor="anchorEl"
        :title="entry.title"
        :summary-html="summaryHtml"
        :pinned="pinned"
        :ring-ms="RING_MS"
        @read-more="readMore"
        @link="openLinked"
      />
    </Teleport>
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
