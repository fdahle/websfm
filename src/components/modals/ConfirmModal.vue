<script setup lang="ts">
// Generic confirmation dialog for destructive/irreversible actions. Driven by the
// caller: pass a title/message, listen for confirm/cancel. Enter activates the focused button, Esc
// cancels. `danger` styles the confirm button red.
defineProps({
  title: { type: String, default: 'Are you sure?' },
  message: { type: String, default: '' },
  confirmLabel: { type: String, default: 'Confirm' },
  cancelLabel: { type: String, default: 'Cancel' },
  danger: { type: Boolean, default: false },
})
const emit = defineEmits(['confirm', 'cancel'])
</script>

<template>
  <div class="overlay" @click.self="emit('cancel')" @keydown.esc.stop="emit('cancel')">
    <div class="modal" role="dialog" aria-modal="true" :aria-label="title">
      <div class="modal-header">
        <span class="modal-title">{{ title }}</span>
        <button class="modal-close" title="Close" @click="emit('cancel')">×</button>
      </div>
      <div class="modal-body">
        <p class="message">{{ message }}</p>
      </div>
      <div class="modal-footer">
        <button class="btn" autofocus @click="emit('cancel')">{{ cancelLabel }}</button>
        <button ref="confirmBtn" class="btn" :class="danger ? 'btn-danger' : 'btn-primary'" @click="emit('confirm')">
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 250;
}
.modal {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  width: 380px; max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  display: flex; flex-direction: column;
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--panel-border);
}
.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }
.modal-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 1px 6px; border-radius: 4px;
}
.modal-close:hover { background: var(--hover-bg); color: var(--text); }
.modal-body { padding: 16px; }
.message { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text); }
.modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--panel-border);
}
.btn {
  background: none; border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px;
  padding: 5px 14px; cursor: pointer;
}
.btn:hover { background: var(--hover-bg); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover { opacity: 0.88; }
.btn-danger { background: #c0453a; border-color: #c0453a; color: #fff; }
.btn-danger:hover { opacity: 0.88; }
</style>
