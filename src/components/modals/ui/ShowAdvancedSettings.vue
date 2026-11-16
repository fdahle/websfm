<script setup>
import { useStepLayout } from '../../../composables/useStepLayout.js'
import { t } from '../../../composables/useI18n.js'

// The footer's "Show advanced settings" (dev/planning/plan-dialog-layout.md): the
// advanced fields of every open step, remembered as Settings ▸ Display ▸ Expand
// advanced settings. A closed step stays closed.
const layout = useStepLayout()
</script>

<template>
  <label v-if="layout" class="show-advanced">
    <input
      type="checkbox"
      class="checkbox"
      :checked="layout.showAdvanced.value"
      @change="(e) => layout.setShowAdvanced(e.target.checked)"
    />
    {{ t('common.showAdvanced') }}
  </label>
</template>

<style scoped>
.show-advanced {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
}
</style>
