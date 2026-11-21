<script setup>
// The status-bar marker of Debug ▸ Flags: shown while any internal tuning value is
// changed (stores/tuningOverrides.js), so a result is never judged without knowing it;
// a click opens the dialog.
import { storeToRefs } from 'pinia'
import { flagCount } from '../../stores/tuningOverrides.js'
import { useModalsStore } from '../../stores/useModalsStore.js'
import { useI18n } from '../../composables/useI18n.js'

const { t } = useI18n()
const { flagsOpen } = storeToRefs(useModalsStore())
</script>

<template>
  <button v-if="flagCount" type="button" class="flags-marker" :title="t('flags.marker.tip')" @click="flagsOpen = true">
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      aria-hidden="true"
    >
      <path d="M6 21V3.5" />
      <path d="M6 4h11.5l-2.5 4 2.5 4H6" />
    </svg>
    <span>{{ t('flags.marker.label', { n: flagCount }) }}</span>
  </button>
</template>

<style scoped>
.flags-marker {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid rgba(230, 160, 30, 0.6);
  background: rgba(230, 160, 30, 0.16);
  color: var(--text);
  font: inherit;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}
.flags-marker:hover {
  background: rgba(230, 160, 30, 0.3);
}
</style>
