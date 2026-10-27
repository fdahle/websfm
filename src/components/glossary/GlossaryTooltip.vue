<script setup>
import { ref, watch, nextTick, onMounted } from 'vue'

// One hover help popup. Two phases:
//  1. filling  — a progress ring sweeps the border over `ringMs`. Leaving the
//     anchor during this phase cancels it.
//  2. pinned   — the ring is full; the popup becomes interactive (pointer
//     events on) so the user can hover cross-links (opening a popup on top),
//     click them, or click "Read more".
// useHelpStack owns the phase/close logic and HelpPopupStack renders one of
// these per level; this component only positions itself, animates the ring,
// and relays pointer events on its body.
const props = defineProps({
  anchor: { type: Object, required: true }, // DOM element to position against
  level: { type: Number, default: 0 }, // stack depth: deeper popups sit on top
  title: { type: String, default: '' },
  summaryHtml: { type: String, default: '' }, // rendered (auto-linked) summary
  pinned: { type: Boolean, default: false },
  ringMs: { type: Number, default: 700 },
})
const emit = defineEmits(['read-more', 'body-over', 'body-out', 'body-click'])

const WIDTH = 268
const GAP = 8
const rootEl = ref(null)
const style = ref({})

// Below the anchor, or above it when there's no room below; clamped to the
// viewport. Re-run when the body changes height (the renderer loads lazily).
function place() {
  const rect = props.anchor.getBoundingClientRect()
  const height = rootEl.value?.offsetHeight ?? 0
  const left = Math.max(GAP, Math.min(rect.left, window.innerWidth - WIDTH - 20))
  let top = rect.bottom + GAP
  if (top + height > window.innerHeight - GAP && rect.top - GAP - height >= GAP) {
    top = rect.top - GAP - height
  }
  style.value = { left: `${left}px`, top: `${top}px`, zIndex: 500 + props.level }
}
onMounted(place)
watch(
  () => props.summaryHtml,
  () => nextTick(place),
)
</script>

<template>
  <div ref="rootEl" class="glossary-tooltip" :class="{ pinned }" :style="style" data-modal-exempt>
    <svg class="ring" :style="{ '--ring-ms': ringMs + 'ms' }" preserveAspectRatio="none">
      <rect class="ring-track" x="1" y="1" rx="6" />
      <rect class="ring-fill" x="1" y="1" rx="6" pathLength="1" />
    </svg>
    <div class="tt-title">{{ title }}</div>
    <div
      class="tt-summary"
      @mouseover="emit('body-over', $event)"
      @mouseout="emit('body-out', $event)"
      @click="emit('body-click', $event)"
      v-html="summaryHtml"
    ></div>
    <button class="tt-more" @click="emit('read-more')">Read more →</button>
  </div>
</template>

<style scoped>
.glossary-tooltip {
  position: fixed;
  z-index: 500;
  width: 268px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 9px 11px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  pointer-events: none; /* transparent to the mouse until pinned */
}
.glossary-tooltip.pinned {
  pointer-events: auto;
}

/* Border progress ring: an SVG overlay whose stroke sweeps once over ringMs.
   pathLength="1" normalises the perimeter so the dash math is size-agnostic. */
.ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}
.ring rect {
  width: calc(100% - 2px);
  height: calc(100% - 2px);
  fill: none;
}
.ring-track {
  stroke: transparent;
}
.ring-fill {
  stroke: var(--accent);
  stroke-width: 2;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: ring-sweep var(--ring-ms) linear forwards;
}
.glossary-tooltip.pinned .ring-fill {
  stroke-dashoffset: 0;
  animation: none;
}
@keyframes ring-sweep {
  from {
    stroke-dashoffset: 1;
  }
  to {
    stroke-dashoffset: 0;
  }
}

.tt-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}
.tt-summary {
  font-size: 11.5px;
  color: var(--text-dim);
  line-height: 1.45;
}
.tt-summary :deep(p) {
  margin: 0;
}
.tt-summary :deep(p + p) {
  margin-top: 5px;
}
.tt-summary :deep(ul),
.tt-summary :deep(ol) {
  margin: 5px 0;
  padding-left: 17px;
}
.tt-summary :deep(a.glossary-link),
.tt-summary :deep(a.guide-link) {
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline dotted;
}
.tt-more {
  margin-top: 7px;
  background: none;
  border: none;
  padding: 0;
  color: var(--accent);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.glossary-tooltip:not(.pinned) .tt-more {
  opacity: 0.6;
}
.tt-more:hover {
  text-decoration: underline;
}
</style>
