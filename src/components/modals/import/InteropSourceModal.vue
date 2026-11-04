<script setup>
import { computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
// Import ▸ COLMAP and Import ▸ Other SfM: where the files are. Both lead to the same
// dialog (InteropImportModal), which shows what the files hold and asks what to import.
const props = defineProps({ kind: { type: String, default: 'colmap' } })
defineEmits(['close', 'files', 'folder'])
const TEXT = {
  colmap: {
    title: 'Import from COLMAP',
    hint: 'Choose a project ZIP or loose files, or a whole COLMAP workspace folder.',
    files: 'database.db, cameras / images / points3D (.txt or .bin), or a ZIP of them',
    folder: 'database, images/ and sparse/ together',
  },
  other: {
    title: 'Import from another SfM tool',
    hint: 'Bundler needs its bundle.out and the list.txt that names the images: pick both, or their folder.',
    files:
      'Bundler bundle.out + list.txt, VisualSFM .nvm, OpenMVG sfm_data.json, OpenSfM reconstruction.json, transforms.json',
    folder: 'a Bundler output folder (bundle/bundle.out and list.txt)',
  },
}
const text = computed(() => TEXT[props.kind] ?? TEXT.colmap)
</script>

<template>
  <ModalShell :title="text.title" @close="$emit('close')">
    <p class="hint">{{ text.hint }}</p>
    <div class="choices">
      <button class="choice" type="button" @click="$emit('files')">
        <strong>Files or ZIP</strong><span>{{ text.files }}</span>
      </button>
      <button class="choice" type="button" @click="$emit('folder')">
        <strong>Folder</strong><span>{{ text.folder }}</span>
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
  grid-template-columns: 1fr 1fr;
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
