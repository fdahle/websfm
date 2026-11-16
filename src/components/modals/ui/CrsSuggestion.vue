<script setup>
import { computed } from 'vue'
import { formatLatLon } from '../../../core/crsSuggest.js'
import { t } from '../../../composables/useI18n.js'

// A quiet line under a CRS control while the project CRS is geographic: why a
// georeferenced product is impossible in degrees, plus a one-click projected CRS
// derived from the camera positions (core/crsSuggest.js, via the reconstruction
// store's `crsSuggestion`). Clicking is the only mutation — the parent applies it
// through App's handleSetCrs, which reprojects every spatial record and logs it.
// `context`: 'product' (DEM / ortho frame picker) or 'settings' (Project Settings).
const props = defineProps({
  suggestion: { type: Object, default: null },
  currentCrs: { type: String, required: true },
  context: { type: String, default: 'product' },
})
const emit = defineEmits(['apply'])

const fromLine = computed(() =>
  props.suggestion
    ? t('dialog.crs.from', {
        count: props.suggestion.count,
        where: formatLatLon(props.suggestion.lat, props.suggestion.lon),
      })
    : '',
)
</script>

<template>
  <div class="crs-suggestion">
    <span class="reason">
      <template v-if="context === 'product'">
        {{ t('dialog.crs.inDegrees', { crs: currentCrs }) }}
        {{ suggestion ? '' : t('dialog.crs.chooseProjected') }}
      </template>
      <template v-else> {{ t('dialog.crs.productsNeedProjected') }} </template>
    </span>
    <template v-if="suggestion">
      <button type="button" class="link-btn" @click="emit('apply', suggestion)">
        {{ t('dialog.crs.use', { code: suggestion.code, name: suggestion.name }) }}
      </button>
      <span class="reason">{{ fromLine }}</span>
    </template>
  </div>
</template>

<style scoped>
.crs-suggestion {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.reason {
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-dim);
}
.link-btn {
  background: none;
  border: none;
  color: var(--accent);
  font: inherit;
  font-size: 11px;
  padding: 0;
  cursor: pointer;
  text-align: left;
}
.link-btn:hover {
  text-decoration: underline;
}
</style>
