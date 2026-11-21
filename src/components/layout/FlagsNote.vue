<script setup>
// The note the Quality Report and the Project Summary show while internal tuning values
// are changed (Debug ▸ Flags, stores/tuningOverrides.js): which ones, and their defaults,
// so a result is not read as one made with the defaults. Names and values are code and
// stay as the console writes them.
import { changedFlags } from '../../stores/tuningOverrides.js'
import { useI18n } from '../../composables/useI18n.js'

const { t } = useI18n()
const item = (c) => t('flags.note.item', { key: c.key, value: JSON.stringify(c.value), def: JSON.stringify(c.def) })
</script>

<template>
  <div v-if="changedFlags.length" class="flags-note" role="note">
    <span>{{ t('flags.note.text', { n: changedFlags.length }) }}</span>
    <code v-for="c in changedFlags" :key="c.key" class="flags-note-item">{{ item(c) }}</code>
  </div>
</template>

<style scoped>
.flags-note {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text);
  background: rgba(230, 160, 30, 0.12);
  border: 1px solid rgba(230, 160, 30, 0.45);
  border-radius: 6px;
  padding: 7px 10px;
}
.flags-note-item {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
}
</style>
