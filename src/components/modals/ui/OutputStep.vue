<script setup>
import { computed } from 'vue'
import SettingsStep from './SettingsStep.vue'
import SettingsField from './SettingsField.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { outputEffect } from '../../../core/stepEffects/output.js'
import { t } from '../../../composables/useI18n.js'

// The last step of a build dialog (Dense Cloud, Mesh, DEM, Orthophoto): add the new
// product beside the others as the main one, or replace the main one. `plan` is the
// store's outputPlan(kind); the effect line is core/stepEffects/output.js.
const props = defineProps({
  step: { type: [Number, String], required: true },
  // The guide article whose `replaceMain` section explains it.
  op: { type: String, required: true },
  // The product: 'dem' | 'ortho' | 'mesh' | 'dense' (each language words it).
  kind: { type: String, required: true },
  plan: { type: Object, default: null },
  defaultValue: { type: Boolean, default: false },
})
const replace = defineModel({ type: Boolean, default: false })
const result = computed(() => outputEffect(replace.value, props.plan, props.kind))
</script>

<template>
  <SettingsStep
    :step="step"
    :title="t('dialog.output.title')"
    :effect="{ short: result.short, long: result.effect }"
    :inactive="result.inactive"
  >
    <SettingsField :hint="t('dialog.output.hint', { kind })">
      <template #label>
        <FieldHelp :op="op" param="replaceMain" :value="replace" :default-value="defaultValue">{{
          t('dialog.output.label', { kind })
        }}</FieldHelp>
      </template>
      <label class="checkbox-row"
        ><input v-model="replace" type="checkbox" class="checkbox" /> {{ t('common.enabled') }}</label
      >
    </SettingsField>
  </SettingsStep>
</template>

<style scoped src="./modal.css"></style>
