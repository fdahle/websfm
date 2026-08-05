<script setup>
// Quality-preset cards (WS5, redesign): the hero control of a pipeline modal. Each preset
// is a card — a bold label + a one-line "what you get" blurb — and one is always active.
// Presentational: the parent owns the settings and derives the active id. Clicking a card
// emits `select` with its id; the parent applies that preset's deltas over the base
// defaults. When the user then edits any field the parent detects the deviation and passes
// modelValue='custom', which surfaces as a "· modified" tag next to the last real preset
// plus a reset affordance (there is no "Custom" card to click — nothing to apply).
// A card may also carry `badge` (a short chip — "★" / "Recommended") and `title`
// (hover text carrying the full reasons), which is how a dataset-derived
// recommendation is surfaced: as one more card, or as a mark on an existing one,
// never as a competing banner above the hero. See core/recommendUi.js.
//   presets: [{ id, label, blurb, badge?, title? }]
import { computed } from 'vue'
const props = defineProps({
  modelValue: { type: String, default: 'medium' }, // active preset id, or 'custom'
  presets: { type: Array, required: true },
  // Which real preset the settings deviated FROM (shown in the "· modified" tag + reset).
  // The parent passes the base preset the current custom values were edited from.
  baseId: { type: String, default: 'medium' },
  // Optional one-line note under the cards (e.g. why a card is recommended).
  note: { type: String, default: '' },
})
const emit = defineEmits(['select'])

const isCustom = computed(() => props.modelValue === 'custom')
// When custom, highlight the base card (the one being modified) rather than nothing.
const highlightId = computed(() => (isCustom.value ? props.baseId : props.modelValue))
const baseLabel = computed(
  () => props.presets.find((p) => p.id === props.baseId)?.label ?? props.baseId,
)
</script>

<template>
  <div class="preset-cards">
    <button
      v-for="p in presets"
      :key="p.id"
      type="button"
      class="preset-card"
      :class="{ active: highlightId === p.id, modified: isCustom && p.id === baseId }"
      :title="p.title || null"
      @click="emit('select', p.id)"
    >
      <span class="preset-card-label">
        {{ p.label }}
        <span v-if="p.badge" class="preset-card-badge">{{ p.badge }}</span>
      </span>
      <span v-if="p.blurb" class="preset-card-blurb">{{ p.blurb }}</span>
    </button>
  </div>
  <div v-if="isCustom" class="preset-modified">
    <span>{{ baseLabel }} · modified</span>
    <button type="button" class="link-btn" @click="emit('select', baseId)">Reset</button>
  </div>
  <div v-else-if="note" class="preset-note">{{ note }}</div>
</template>

<style scoped src="./modal.css"></style>
<style scoped>
.preset-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
  gap: 8px;
}
.preset-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 7px;
  padding: 9px 11px;
  cursor: pointer;
  color: var(--text);
  font: inherit;
}
.preset-card:hover { border-color: var(--text-dim); }
.preset-card.active {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.preset-card.modified { box-shadow: none; }
.preset-card-label { display: flex; align-items: center; gap: 5px; font-size: 13px; font-weight: 600; }
.preset-card.active .preset-card-label { color: var(--accent); }
.preset-card-badge {
  flex: 0 0 auto;
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  font-size: 9.5px;
  font-weight: 650;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.preset-note { margin-top: 7px; font-size: 11px; line-height: 1.4; color: var(--text-dim); }
.preset-card-blurb { font-size: 11px; color: var(--text-dim); line-height: 1.35; }
.preset-modified {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
  font-size: 11px;
  color: var(--text-dim);
}
.preset-modified .link-btn { font-size: 11px; }
</style>
