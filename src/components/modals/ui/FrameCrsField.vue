<script setup>
// The "Coordinate frame" field of Build DEM / Build Orthophoto: Local or the project
// CRS (`v-model`: 'local' | 'project'), the reason the project option is off, and —
// for a geographic project CRS — the one-click projected CRS suggestion.
//
// It keeps the value consistent with what the project can do:
//   - the project frame can't be chosen without a georeference, so when that becomes
//     unavailable (or the field mounts while it is) a 'project' pick falls back to
//     'local' rather than sitting selected on a disabled option and silently running
//     local;
//   - applying the suggested CRS says the user wants a georeferenced product, so once
//     the fit becomes possible the frame flips to the project CRS (only after that click).
// `realWorld` words what the fit buys in the hint ('heights' for a DEM).
import { ref, watch } from 'vue'
import SettingsField from './SettingsField.vue'
import CrsSuggestion from './CrsSuggestion.vue'
import GlossaryTerm from '../../glossary/GlossaryTerm.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { t } from '../../../composables/useI18n.js'

const props = defineProps({
  id: { type: String, required: true },
  canGeoreference: { type: Boolean, default: false },
  hasScale: { type: Boolean, default: false },
  projectCrs: { type: String, default: null },
  // Why the project-CRS option is off ('geographic' | 'evidence' | null) and, for a
  // geographic CRS, the projected one the camera positions suggest (store getters).
  georeferenceBlocker: { type: String, default: null },
  crsSuggestion: { type: Object, default: null },
  realWorld: { type: String, default: 'coordinates' },
  // Guide operation whose `crs` section explains this field; without one the label
  // explains the concept (CRS) instead.
  helpOp: { type: String, default: null },
})
const crs = defineModel({ type: String, default: 'local' })
const emit = defineEmits(['apply-crs-suggestion'])

// After the option's name, and the same as its tooltip (dialog.frame.blocked…).
const BLOCKERS = ['geographic', 'evidence']
const blockedReason = (b) => (BLOCKERS.includes(b) ? t(`dialog.frame.blocked.${b}`) : '')
const blockedTitle = (b) => t(`dialog.frame.blockedTitle.${BLOCKERS.includes(b) ? b : 'other'}`)

const appliedCrsSuggestion = ref(false)
function applyCrsSuggestion(suggestion) {
  appliedCrsSuggestion.value = true
  emit('apply-crs-suggestion', suggestion)
}
watch(
  () => props.canGeoreference,
  (can) => {
    if (can && appliedCrsSuggestion.value) crs.value = 'project'
    else if (!can && crs.value === 'project') crs.value = 'local'
  },
  { immediate: true },
)
</script>

<template>
  <SettingsField
    :label-for="id"
    :hint="hasScale ? t('dialog.frame.hintScaled') : t('dialog.frame.hint', { what: realWorld })"
  >
    <template #label>
      <FieldHelp v-if="helpOp" :op="helpOp" param="crs">{{ t('dialog.frame.label') }}</FieldHelp>
      <GlossaryTerm v-else id="coordinate-reference-system">{{ t('dialog.frame.label') }}</GlossaryTerm>
    </template>
    <select :id="id" v-model="crs" class="field-input field-select">
      <option value="local">{{ hasScale ? t('dialog.frame.localScaled') : t('dialog.frame.local') }}</option>
      <option
        value="project"
        :disabled="!canGeoreference"
        :title="canGeoreference ? null : blockedTitle(georeferenceBlocker)"
      >
        {{ projectCrs || t('dialog.frame.project') }}{{ canGeoreference ? '' : blockedReason(georeferenceBlocker) }}
      </option>
    </select>
    <CrsSuggestion
      v-if="georeferenceBlocker === 'geographic'"
      :suggestion="crsSuggestion"
      :current-crs="projectCrs || 'EPSG:4326'"
      @apply="applyCrsSuggestion"
    />
  </SettingsField>
</template>

<style scoped src="./modal.css"></style>
<style scoped>
/* The frame select reads better full-width (as both dialogs style their selects). */
.field-select {
  width: 100%;
}
</style>
