<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { useGuideStore } from '../../stores/useGuideStore.js'
import { useGlossaryStore } from '../../stores/useGlossaryStore.js'
import { getParam, renderGuide } from '../../core/help/guide.js'
import GlossaryTooltip from '../glossary/GlossaryTooltip.vue'

// The per-parameter `?` affordance next to a modal field label. Hovering shows a
// pinnable popup (the shared GlossaryTooltip, ring and all) with the parameter's
// prose; "Read more" opens the Guide modal scrolled to this parameter. Cross-links
// in the prose reach the glossary (help:) or another operation (guide:).
//
// Pass the live default via :default-value so the popup shows the value the code
// actually uses — no retyping in markdown, no drift. Missing entry → renders
// nothing (the field's own one-line hint still stands).
const props = defineProps({
  op: { type: String, required: true },
  param: { type: String, required: true },
  defaultValue: { type: [String, Number, Boolean], default: null },
})

const guide = useGuideStore()
const glossary = useGlossaryStore()
const entry = computed(() => getParam(props.op, props.param))

const bodyHtml = computed(() => {
  if (!entry.value) return ''
  let html = renderGuide(entry.value.body)
  const def = props.defaultValue ?? entry.value.defaultText
  if (def !== null && def !== '') {
    html += `<p class="fh-default">Default: <code>${def}</code></p>`
  }
  return html
})

const RING_MS = 700
const anchorEl = ref(null)
const tooltipRef = ref(null)
const visible = ref(false)
const pinned = ref(false)
let ringTimer = null

// Only one help popup open at a time, shared with glossary terms.
let currentClose = null

function show() {
  if (!entry.value) return
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
function onLeave() { if (!pinned.value) hide() }
function onDocMouseDown(e) {
  if (anchorEl.value?.contains(e.target)) return
  if (tooltipRef.value?.rootEl?.contains(e.target)) return
  hide()
}
function onKeydown(e) { if (e.key === 'Escape') hide() }

function readMore() { hide(); guide.openOp(props.op, props.param) }
function openGlossary(id) { hide(); glossary.openTerm(id) }
function openGuide(id) { hide(); guide.openOp(id) }

onBeforeUnmount(hide)
</script>

<template>
  <span
    v-if="entry"
    ref="anchorEl"
    class="field-help"
    tabindex="0"
    role="button"
    aria-label="Parameter help"
    @mouseenter="show"
    @mouseleave="onLeave"
    @focus="show"
    @blur="onLeave"
  >?
    <Teleport to="body">
      <GlossaryTooltip
        v-if="visible"
        ref="tooltipRef"
        :anchor="anchorEl"
        :title="entry.label"
        :summary-html="bodyHtml"
        :pinned="pinned"
        :ring-ms="RING_MS"
        @read-more="readMore"
        @link="openGlossary"
        @guide-link="openGuide"
        @mouseenter="pinned || show()"
      />
    </Teleport>
  </span>
</template>

<style scoped>
.field-help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 5px;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  cursor: help;
  color: var(--text-dim);
  border: 1px solid var(--text-dim);
  vertical-align: middle;
  user-select: none;
}
.field-help:hover,
.field-help:focus-visible {
  color: var(--accent);
  border-color: var(--accent);
  outline: none;
}
</style>
