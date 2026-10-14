<script setup lang="ts">
import { ref } from 'vue'
import ModalShell from './ui/ModalShell.vue'

// Generic confirmation dialog for destructive/irreversible actions. Driven by the
// caller: pass a title/message, listen for confirm/cancel. Cancel takes the initial
// focus (utils/modalFocus.js honours `autofocus`) — the safe default for a
// destructive action, checked by tests/browser/hardening.spec.js — so Enter on open
// cancels; Enter activates whichever button is focused. Esc, the backdrop and ×
// cancel. `danger` styles the confirm button red. `dontAsk` adds a "Don't ask
// again" checkbox; its state rides along on `confirm` (cancelling never stores it).
defineProps({
  title: { type: String, default: 'Are you sure?' },
  message: { type: String, default: '' },
  confirmLabel: { type: String, default: 'Confirm' },
  cancelLabel: { type: String, default: 'Cancel' },
  danger: { type: Boolean, default: false },
  dontAsk: { type: Boolean, default: false },
})
const emit = defineEmits(['confirm', 'cancel'])
const dontAskAgain = ref(false)
</script>

<template>
  <!-- `confirm-overlay` lands on the shell's root overlay (attribute fallthrough). -->
  <ModalShell class="confirm-overlay" :title="title" width="380px" @close="emit('cancel')">
    <p class="message">{{ message }}</p>
    <label v-if="dontAsk" class="dont-ask">
      <input v-model="dontAskAgain" type="checkbox" />
      Don't ask again
    </label>

    <template #footer>
      <button class="btn" autofocus @click="emit('cancel')">{{ cancelLabel }}</button>
      <button class="btn" :class="danger ? 'btn-danger' : 'btn-primary'" @click="emit('confirm', dontAskAgain)">
        {{ confirmLabel }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped>
/* Above the project picker (z 300), which asks through this dialog too; the
   shell's own overlay is z 200. Two classes outrank the shell's `.overlay`. */
.overlay.confirm-overlay { z-index: 350; }
.message { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text); }
.dont-ask {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--text-dim); cursor: pointer;
}
.btn-danger { background: #c0453a; border-color: #c0453a; color: #fff; }
.btn-danger:hover { opacity: 0.88; }
</style>
