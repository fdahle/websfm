<script setup>
import SettingsField from './SettingsField.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { fileSafe } from '../../../core/exportNames.js'

// The optional File name of an export dialog: empty keeps the default name, shown as
// the placeholder (core/exportNames.js defaultExportName); a typed one names every
// file the export writes. The extension is the format's, added on export.
const model = defineModel({ type: String, default: '' })
defineProps({
  defaultName: { type: String, required: true },
})
</script>

<template>
  <SettingsField
    label-for="export-file-name"
    :hint="
      model && fileSafe(model) !== model.trim()
        ? `Saved as ${fileSafe(model)}; the extension is added.`
        : 'Optional. The extension is added; a world file or .prj beside it takes the same name.'
    "
  >
    <template #label><FieldHelp op="projects-storage" param="fileName">File name</FieldHelp></template>
    <input
      id="export-file-name"
      v-model="model"
      type="text"
      class="field-input"
      :placeholder="defaultName"
      spellcheck="false"
      autocomplete="off"
    />
  </SettingsField>
</template>

<style scoped src="./modal.css"></style>
