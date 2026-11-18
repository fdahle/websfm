<script setup>
import { computed, watch } from 'vue'
import {
  updateReady,
  updateActive,
  updateStale,
  updateRequested,
  reloadIntoUpdate,
  postponeUpdate,
  setUpdateBusy,
} from '../../composables/useAppUpdate.js'

// "A new version is available": shown once a newly deployed service worker is
// installed and waiting. Reloading is disabled while work is in flight (the same
// condition that guards closing the tab), so an update never cuts a run short.
// When another tab already switched to the new version, this tab reloads by itself
// once its work has finished (composables/useAppUpdate.js), and says so.
const props = defineProps({
  busy: { type: Boolean, default: false },
  // What holds the tab (App.vue workInFlightReason): 'run' | 'opening' | 'images' |
  // 'rasters' | 'saving' | 'saveFailed', or ''.
  busyReason: { type: String, default: '' },
})

// The tab's busy state drives the deferred reload, so report it even while hidden.
watch(
  () => props.busy,
  (busy) => setUpdateBusy(busy),
  { immediate: true },
)

// "… once <this>", for the reason the tab is busy.
const WAIT_FOR = {
  run: 'the current run has finished',
  opening: 'the project has opened',
  images: 'the images are imported',
  rasters: 'the rasters are imported',
  saving: 'the project is saved',
  saveFailed: 'the failed save is resolved (see the console)',
}
const waitFor = computed(() => WAIT_FOR[props.busyReason] ?? 'the current task has finished')

const detail = computed(() => {
  if (updateStale.value)
    return props.busy
      ? `Part of this tab could not be loaded because it is on an old version: it reloads once ${waitFor.value}.`
      : 'Part of this tab could not be loaded because it is on an old version: reload to switch to the new one.'
  // Reload was pressed here: the new version is taking over this tab.
  if (updateRequested.value && updateActive.value)
    return props.busy ? `Switching to it once ${waitFor.value}.` : 'Switching to it…'
  if (updateActive.value) return `It is already active in another tab, so this tab reloads once ${waitFor.value}.`
  if (updateRequested.value) return 'Switching to it…'
  return props.busy ? `You can reload once ${waitFor.value}.` : 'Reload to switch to it.'
})
</script>

<template>
  <!-- Teleported to <body> and exempt from the modal focus trap (utils/modalFocus.js):
       inside .app it would sit under modal overlays, the start-up project dialog
       among them, and could not be clicked. -->
  <Teleport to="body">
    <div v-if="updateReady" class="update-prompt" role="status" data-modal-exempt>
      <div class="up-text">
        <span class="up-title">A new version of WebSfM is available</span>
        <span class="up-detail">{{ detail }}</span>
      </div>
      <div class="up-actions">
        <button v-if="!updateActive" class="up-later" @click="postponeUpdate">Later</button>
        <button
          class="up-reload"
          :disabled="busy"
          :title="busy ? `You can reload once ${waitFor}` : null"
          @click="reloadIntoUpdate"
        >
          Reload
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.update-prompt {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 3900; /* just below toasts */
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
.up-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 200px;
  min-width: 0;
}
.up-title {
  font-weight: 600;
}
.up-detail {
  color: var(--text-dim);
}
.up-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.update-prompt button {
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
.up-later {
  background: none;
  border: 1px solid var(--panel-border);
  color: var(--text);
}
.up-later:hover {
  background: var(--hover-bg);
}
.up-reload {
  background: var(--accent);
  border: 1px solid var(--accent);
  color: #fff;
}
.up-reload:hover:not(:disabled) {
  background: var(--accent-hover);
}
.up-reload:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
