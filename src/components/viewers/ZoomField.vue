<script setup>
import { nextTick, ref } from 'vue'

// The zoom readout of a viewer's status bar (ViewerImage, ProductViewer): "150%",
// which a click turns into a field to type a zoom into. Enter or leaving the field
// applies it, Esc keeps the old one. Emits `set` with the scale (1 = 100 %); the
// viewer clamps it to its own range and zooms about the view's centre.
const props = defineProps({ scale: { type: Number, required: true } })
const emit = defineEmits(['set'])

const editing = ref(false)
const draft = ref('')
const input = ref(null)

async function startEdit() {
  draft.value = String(Math.round(props.scale * 100))
  editing.value = true
  await nextTick()
  input.value?.select()
}

function commit() {
  if (!editing.value) return
  editing.value = false
  const pct = Number(draft.value.trim().replace(/\s*%$/, '').replace(',', '.'))
  if (Number.isFinite(pct) && pct > 0) emit('set', pct / 100)
}

function onKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault()
    commit()
  } else if (e.key === 'Escape') {
    // Consumed, so App's Escape handler does not act on it too (utils/keyRouting.js).
    e.preventDefault()
    editing.value = false
  }
}
</script>

<template>
  <input
    v-if="editing"
    ref="input"
    v-model="draft"
    class="zoom-input"
    type="text"
    inputmode="decimal"
    aria-label="Zoom (%)"
    @keydown="onKeydown"
    @blur="commit"
  />
  <button v-else type="button" class="zoom-level" title="Zoom — click to type a value" @click="startEdit">
    {{ Math.round(scale * 100) }}%
  </button>
</template>

<style scoped>
.zoom-level {
  background: none;
  border: 1px solid transparent;
  border-radius: 3px;
  color: var(--text-dim);
  font: inherit;
  font-variant-numeric: tabular-nums;
  padding: 0 4px;
  cursor: text;
}
.zoom-level:hover {
  border-color: var(--panel-border);
  color: var(--text);
}
.zoom-input {
  width: 52px;
  background: var(--input-bg, var(--panel));
  border: 1px solid var(--accent);
  border-radius: 3px;
  color: var(--text);
  font: inherit;
  font-variant-numeric: tabular-nums;
  padding: 0 4px;
  text-align: right;
}
</style>
