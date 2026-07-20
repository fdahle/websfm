<script setup>
import { toasts, dismissToast } from '../../composables/useToasts.js'

// Renders the useToasts singleton. Mounted once, in App.vue.
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack">
      <TransitionGroup name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="toast"
          :class="t.kind"
          role="status"
          title="Dismiss"
          @click="dismissToast(t.id)"
        >
          <span class="toast-title">{{ t.title }}</span>
          <span v-if="t.detail" class="toast-detail">{{ t.detail }}</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 4000;              /* above modals — a copy can be triggered from one */
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;       /* never blocks the viewport underneath */
}

.toast {
  pointer-events: auto;
  cursor: pointer;
  max-width: 380px;
  padding: 7px 12px;
  border-radius: 6px;
  border: 1px solid;
  background: var(--panel);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toast.success {
  border-color: #3f9e5a;
  background: color-mix(in srgb, #3f9e5a 16%, var(--panel));
}

.toast.error {
  border-color: #c05252;
  background: color-mix(in srgb, #c05252 16%, var(--panel));
}

.toast-title { font-weight: 600; color: var(--text); }

.toast-detail {
  font-family: ui-monospace, 'Cascadia Code', 'Fira Mono', monospace;
  font-size: 11px;
  color: var(--text-dim);
  /* A copied value can be long (a WKT string, a full coordinate triple) — clamp
     it rather than letting the toast grow across the viewport. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toast-enter-active,
.toast-leave-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.toast-enter-from,
.toast-leave-to { opacity: 0; transform: translateY(6px); }
</style>
