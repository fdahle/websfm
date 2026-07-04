<script setup>
import { ref, onMounted } from 'vue'

// Purely informational hover popup — no click targets of its own. Opening the
// full entry happens by clicking the GlossaryTerm itself, so there's no mouse
// travel from the term onto the tooltip that could rob it of the hover.
const props = defineProps({
  anchor: { type: Object, required: true }, // DOM element to position below
  title: { type: String, default: '' },
  summary: { type: String, default: '' },
})

const style = ref({})

onMounted(() => {
  const rect = props.anchor.getBoundingClientRect()
  const left = Math.min(rect.left, window.innerWidth - 280)
  style.value = { left: `${Math.max(8, left)}px`, top: `${rect.bottom + 6}px` }
})
</script>

<template>
  <div class="help-tooltip" :style="style">
    <div class="help-tooltip-title">{{ title }}</div>
    <div class="help-tooltip-summary">{{ summary }}</div>
    <div class="help-tooltip-hint">Click to read more</div>
  </div>
</template>

<style scoped>
.help-tooltip {
  position: fixed;
  z-index: 500;
  width: 260px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 8px 10px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  pointer-events: none;
}
.help-tooltip-title { font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
.help-tooltip-summary { font-size: 11.5px; color: var(--text-dim); line-height: 1.4; }
.help-tooltip-hint { font-size: 10.5px; color: var(--accent); margin-top: 6px; }
</style>
