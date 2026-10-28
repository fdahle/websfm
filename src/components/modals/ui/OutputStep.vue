<script setup>
import { computed } from 'vue'
import SettingsStep from './SettingsStep.vue'
import SettingsField from './SettingsField.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { outputEffect } from '../../../core/stepEffects/output.js'

// The last step of a build dialog (Dense Cloud, Mesh, DEM, Orthophoto): add the new
// product beside the others as the main one, or replace the main one. `plan` is the
// store's outputPlan(kind); the effect line is core/stepEffects/output.js.
const props = defineProps({
  step: { type: [Number, String], required: true },
  // The guide article whose `replaceMain` section explains it.
  op: { type: String, required: true },
  // The product, lower case ("DEM", "dense cloud").
  noun: { type: String, required: true },
  plan: { type: Object, default: null },
  defaultValue: { type: Boolean, default: false },
})
const replace = defineModel({ type: Boolean, default: false })
const result = computed(() => outputEffect(replace.value, props.plan, props.noun))
</script>

<template>
  <SettingsStep :step="step" title="Output" :effect="result.effect" :inactive="result.inactive">
    <SettingsField
      :hint="`Off: older ${noun}s stay, and the new one becomes the main one (the input of the next step). On: the new one takes the main one's place and name.`"
    >
      <template #label>
        <FieldHelp :op="op" param="replaceMain" :value="replace" :default-value="defaultValue"
          >Replace the main {{ noun }}</FieldHelp
        >
      </template>
      <label class="checkbox-row"><input v-model="replace" type="checkbox" class="checkbox" /> Enabled</label>
    </SettingsField>
  </SettingsStep>
</template>

<style scoped src="./modal.css"></style>
