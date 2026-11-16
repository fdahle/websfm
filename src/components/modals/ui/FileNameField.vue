<script setup>
import SettingsField from './SettingsField.vue'
import { fileSafe } from '../../../core/exportNames.js'
import { t } from '../../../composables/useI18n.js'

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
    :label="t('dialog.fileName.label')"
    label-for="export-file-name"
    :hint="
      model && fileSafe(model) !== model.trim()
        ? t('dialog.fileName.savedAs', { name: fileSafe(model) })
        : t('dialog.fileName.hint')
    "
  >
    <input
      id="export-file-name"
      v-model="model"
      type="text"
      class="field-input wide"
      :placeholder="defaultName"
      spellcheck="false"
      autocomplete="off"
    />
  </SettingsField>
</template>

<style scoped src="./modal.css"></style>
