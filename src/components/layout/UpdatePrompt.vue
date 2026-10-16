<script setup>
import { updateReady, reloadIntoUpdate, postponeUpdate } from '../../composables/useAppUpdate.js'

// "A new version is available": shown once a newly deployed service worker is
// installed and waiting. Reloading is disabled while work is in flight (the same
// condition that guards closing the tab), so an update never cuts a run short.
defineProps({ busy: { type: Boolean, default: false } })
</script>

<template>
  <!-- Teleported to <body> and exempt from the modal focus trap (utils/modalFocus.js):
       inside .app it would sit under modal overlays, the start-up project dialog
       among them, and could not be clicked. -->
  <Teleport to="body">
  <div v-if="updateReady" class="update-prompt" role="status" data-modal-exempt>
    <div class="up-text">
      <span class="up-title">A new version of websfm is available</span>
      <span class="up-detail">{{ busy ? 'You can reload once the current task has finished.' : 'Reload to switch to it.' }}</span>
    </div>
    <div class="up-actions">
      <button class="up-later" @click="postponeUpdate">Later</button>
      <button class="up-reload" :disabled="busy" @click="reloadIntoUpdate">Reload</button>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.update-prompt {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 3900;              /* just below toasts */
  max-width: 360px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  padding: 10px 12px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  color: var(--text);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  font-size: 12px;
}
.up-text { display: flex; flex-direction: column; gap: 2px; flex: 1 1 200px; min-width: 0; }
.up-title { font-weight: 600; }
.up-detail { color: var(--text-dim); }
.up-actions { display: flex; gap: 6px; margin-left: auto; }
.update-prompt button {
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
.up-later { background: none; border: 1px solid var(--panel-border); color: var(--text); }
.up-later:hover { background: var(--hover-bg); }
.up-reload { background: var(--accent); border: 1px solid var(--accent); color: #fff; }
.up-reload:hover:not(:disabled) { background: var(--accent-hover); }
.up-reload:disabled { opacity: 0.5; cursor: default; }
</style>
