<script setup>
import { computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
// Import ▸ COLMAP, Other SfM and Metashape: where the files are. COLMAP and Other SfM
// lead to InteropImportModal, Metashape to MetashapeImportModal; each shows what the
// files hold and asks what of it to import. Emits `choose` with the choice's id.
const props = defineProps({ kind: { type: String, default: 'colmap' } })
defineEmits(['close', 'choose'])
const SOURCES = {
  colmap: {
    title: 'Import from COLMAP',
    hint: 'Choose a project ZIP or loose files, or a whole COLMAP workspace folder.',
    choices: [
      {
        id: 'files',
        title: 'Files or ZIP',
        text: 'database.db, cameras / images / points3D (.txt or .bin), or a ZIP of them',
      },
      { id: 'folder', title: 'Folder', text: 'database, images/ and sparse/ together' },
    ],
  },
  other: {
    title: 'Import from another SfM tool',
    hint: 'Bundler needs its bundle.out and the list.txt that names the images: pick both, or their folder.',
    choices: [
      {
        id: 'files',
        title: 'Files or ZIP',
        text: 'Bundler bundle.out + list.txt, VisualSFM .nvm, OpenMVG sfm_data.json, OpenSfM reconstruction.json, transforms.json',
      },
      { id: 'folder', title: 'Folder', text: 'a Bundler output folder (bundle/bundle.out and list.txt)' },
    ],
  },
  metashape: {
    title: 'Import from Metashape',
    hint: 'A project brings its tie points (keypoints, matches, the sparse model) and mesh as well; load the photos first.',
    choices: [
      { id: 'xml', title: 'Cameras or markers XML', text: 'File ▸ Export ▸ Export Cameras or Export Markers' },
      { id: 'psz', title: 'Project file', text: 'a .psz, the project in one file' },
      { id: 'folder', title: 'Project folder', text: 'the folder that holds the .psx and its .files folder' },
    ],
  },
}
const source = computed(() => SOURCES[props.kind] ?? SOURCES.colmap)
</script>

<template>
  <ModalShell :title="source.title" @close="$emit('close')">
    <p class="hint">{{ source.hint }}</p>
    <div class="choices" :style="{ gridTemplateColumns: `repeat(${source.choices.length}, 1fr)` }">
      <button v-for="c in source.choices" :key="c.id" class="choice" type="button" @click="$emit('choose', c.id)">
        <strong>{{ c.title }}</strong
        ><span>{{ c.text }}</span>
      </button>
    </div>
    <template #footer><button class="btn" @click="$emit('close')">Cancel</button></template>
  </ModalShell>
</template>
<style scoped src="../ui/modal.css"></style>
<style scoped>
.hint {
  color: var(--text-dim);
  font-size: 13px;
  margin-top: 0;
}
.choices {
  display: grid;
  gap: 12px;
}
.choice {
  text-align: left;
  padding: 16px;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.choice:hover {
  border-color: var(--accent);
}
.choice span {
  color: var(--text-dim);
  font-size: 12px;
}
</style>
