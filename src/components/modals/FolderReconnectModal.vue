<script setup>
// A folder-backed project can only be read once the browser has granted this
// site read/write access to that directory — and `requestPermission` is rejected
// unless it comes from a user gesture. So the reconnect is a BUTTON, never an
// automatic retry: this dialog exists to supply that gesture.
//
// Chromium remembers the grant for sites the user returns to, so in practice
// this appears rarely — mostly after a long absence, or when the folder moved.
import ModalShell from './ui/ModalShell.vue'
import WarnBox from './ui/WarnBox.vue'

defineProps({
  projectName: { type: String, default: 'this project' },
  folderName: { type: String, default: '' },
  // 'prompt' | 'denied' → reconnect is possible; 'repick' → the handle is gone.
  mode: { type: String, default: 'prompt' },
  error: { type: String, default: '' },
})
const emit = defineEmits(['connect', 'repick', 'cancel'])
</script>

<template>
  <ModalShell
    :title="mode === 'repick' ? 'Find project folder' : 'Reconnect project folder'"
    @close="emit('cancel')"
  >
    <p class="message">
      <strong>{{ projectName }}</strong> keeps its files in a folder on this computer<template v-if="folderName">
        (<code>{{ folderName }}</code>)</template>.
      <template v-if="mode === 'repick'">
        websfm can no longer reach it — the folder may have been moved, renamed or removed.
      </template>
      <template v-else>
        Your browser needs your permission before websfm can read it again.
      </template>
    </p>

    <WarnBox v-if="error">{{ error }}</WarnBox>

    <template #footer>
      <button class="btn" @click="emit('cancel')">Cancel</button>
      <button class="btn" @click="emit('repick')">Choose folder…</button>
      <button v-if="mode !== 'repick'" class="btn btn-primary" @click="emit('connect')">
        Connect
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.message {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
code {
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--hover-bg);
}
</style>
