<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import WarnBox from '../ui/WarnBox.vue'

// Import ▸ Project into this project (composables/useProjectMerge.js): another project's
// photos, features, matches, sensors, GCP marks and camera positions join this one. A
// colleague's .websfm file is opened first (Open existing ▸ Project file…), which makes
// it a project in this list. One choice and no settings, so no numbered steps.
const props = defineProps({
  // The other projects: [{ id, name, folderName? }].
  projects: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'run'])

const sourceId = ref(props.projects[0]?.id ?? null)
const label = (p) => `${p.name}${p.folderName ? ` · folder ${p.folderName}` : ''}`
const source = computed(() => props.projects.find((p) => p.id === sourceId.value) ?? null)
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
        positions. A photo both projects hold is kept once. Its model and products stay behind. To join the photos to
        this model, run Match Features with <strong>Match only new pairs</strong>, then Sparse Reconstruction ▸
        <strong>Add to the model</strong>.
      </p>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source" @click="emit('run', sourceId)">Import</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
