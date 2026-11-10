<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsField from '../ui/SettingsField.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import WarnBox from '../ui/WarnBox.vue'
import FieldHelp from '../../guide/FieldHelp.vue'

// Import ▸ Project into this project (composables/useProjectMerge.js): another project's
// photos, features, matches, sensors, GCP marks and camera positions join this one, and
// its model either stays behind or is merged into this one (core/sfm/modelMerge.js). A
// colleague's .websfm file is opened first (Open existing ▸ Project file…), which makes
// it a project in this list. Two settings, so no numbered steps.
const props = defineProps({
  // The other projects: [{ id, name, folderName? }].
  projects: { type: Array, default: () => [] },
  // Whether this project has a model to merge into.
  hasModel: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'run'])

const sourceId = ref(props.projects[0]?.id ?? null)
const label = (p) => `${p.name}${p.folderName ? ` · folder ${p.folderName}` : ''}`
const source = computed(() => props.projects.find((p) => p.id === sourceId.value) ?? null)
const model = ref('merge')
const align = ref('auto')
const alignReason = computed(() =>
  model.value !== 'merge'
    ? 'Its model stays behind'
    : !props.hasModel
      ? 'This project has no model yet: the other one comes in as it is'
      : null,
)
</script>

<template>
  <ModalShell title="Import Project" @close="emit('close')">
    <WarnBox v-if="!projects.length">
      There is no other project to import. Open a project file first (Open existing ▸ Project file…); it becomes a
      project you can choose here.
    </WarnBox>
    <template v-else>
      <SettingsGroup title="Source">
        <SourcePicker
          id="imp-proj-src"
          v-model="sourceId"
          label="Project"
          :items="projects"
          :option-label="label"
          hint="Left untouched; its photos are copied into this project."
        />
      </SettingsGroup>
      <p class="field-hint">
        Its photos come with their features and the matches between them, its sensors (one with the same calibration as
        one here joins it), GCP and marker marks (joined by name; positions already here stay) and imported camera
        positions. A photo both projects hold is kept once. Its depth maps and products stay behind.
      </p>
      <SettingsGroup title="Model">
        <SettingsField label-for="imp-proj-model">
          <template #label><FieldHelp op="import-project" param="model">Its model</FieldHelp></template>
          <select id="imp-proj-model" v-model="model" class="field-select">
            <option value="merge">{{ hasModel ? 'Merge into this model' : 'Bring in as this model' }}</option>
            <option value="leave">Leave behind</option>
          </select>
        </SettingsField>
        <SettingsField label-for="imp-proj-align">
          <template #label><FieldHelp op="import-project" param="align">Place it by</FieldHelp></template>
          <select
            id="imp-proj-align"
            v-model="align"
            class="field-select"
            :disabled="!!alignReason"
            :title="alignReason"
          >
            <option value="auto">Auto</option>
            <option value="photos">Photos in both</option>
            <option value="gcps">GCPs and markers</option>
            <option value="georef">Georeference</option>
          </select>
        </SettingsField>
        <p v-if="model === 'leave'" class="field-hint">
          To join the photos to this model, run Match Features with <strong>Match only new pairs</strong>, then Sparse
          Reconstruction ▸ <strong>Add to the model</strong>. The two blocks must overlap for that.
        </p>
      </SettingsGroup>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button
        class="btn btn-primary"
        :disabled="!source"
        :title="source ? null : 'Choose a project to import'"
        @click="emit('run', sourceId, { model, align })"
      >
        Import
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
