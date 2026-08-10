<script setup>
import ModalShell from './ui/ModalShell.vue'
defineEmits(['close', 'files', 'folder'])
</script>

<template>
  <ModalShell title="Open SfM Project" @close="$emit('close')">
    <p class="hint">Choose a project ZIP or one or more loose files, or select a complete workspace folder.</p>
    <div class="choices">
      <button class="choice" type="button" @click="$emit('files')"><strong>Files or ZIP</strong><span>database.db, sparse model, JSON, or NVM</span></button>
      <button class="choice" type="button" @click="$emit('folder')"><strong>Workspace folder</strong><span>database, images/, and sparse/ together</span></button>
    </div>
    <template #footer><button class="btn" @click="$emit('close')">Cancel</button></template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.hint { color:var(--text-muted); font-size:13px; margin-top:0; }
.choices { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.choice { text-align:left; padding:16px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text); cursor:pointer; display:flex; flex-direction:column; gap:5px; }
.choice:hover { border-color:var(--accent); }.choice span { color:var(--text-muted); font-size:12px; }
</style>
