<script setup>
// A row of headline stat tiles — the "here's the number that matters" strip above
// the DataTable in the Evaluate views (step 0 of PLAN-eval-views).
//
// tiles: [{ label, value, unit?, hint?, tone?: 'ok'|'warn'|'bad' }]. `value` is
// rendered as-is (pre-formatted string or number; use '—' for missing). `tone`
// colours the value; `hint` is a small caption under the label.
// A tile's value, unit, label and hint: a string or a message (core/i18n).
import { tx } from '../../../composables/useI18n.js'
defineProps({
  tiles: { type: Array, default: () => [] },
})
</script>

<template>
  <div class="tiles">
    <div v-for="(t, i) in tiles" :key="i" class="tile" :class="t.tone ? `tone-${t.tone}` : ''">
      <div class="tile-value">
        {{ tx(t.value) }}<span v-if="t.unit" class="tile-unit">{{ tx(t.unit) }}</span>
      </div>
      <div class="tile-label">{{ tx(t.label) }}</div>
      <div v-if="t.hint" class="tile-hint">{{ tx(t.hint) }}</div>
    </div>
  </div>
</template>

<style scoped src="./modal.css"></style>
