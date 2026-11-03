<script setup>
import { useStepLayout } from '../../../composables/useStepLayout.js'

// The footer's "Show all settings" (dev/planning/plan-dialog-layout.md): every step drawn
// and open, remembered as Settings ▸ Display ▸ Expand advanced settings.
const layout = useStepLayout()
</script>

<template>
  <label v-if="layout" class="show-all">
    <input
      type="checkbox"
      class="checkbox"
      :checked="layout.showAll.value"
      @change="(e) => layout.setShowAll(e.target.checked)"
    />
    Show all settings
  </label>
</template>

<style scoped>
.show-all {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
}
</style>
