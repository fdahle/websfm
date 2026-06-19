<script setup>
defineProps({ theme: String })
const emit = defineEmits(['close', 'set-theme'])
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="modal-header">
        <span class="modal-title">Settings</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>
      <div class="modal-body">
        <div class="setting-row">
          <span class="setting-label">Theme</span>
          <div class="theme-toggle">
            <button :class="{ active: theme === 'dark' }" @click="emit('set-theme', 'dark')">Dark</button>
            <button :class="{ active: theme === 'light' }" @click="emit('set-theme', 'light')">Light</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  width: 360px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--panel-border);
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 4px;
}

.modal-close:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.modal-body {
  padding: 16px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
}

.setting-label {
  font-size: 13px;
  color: var(--text);
}

.theme-toggle {
  display: flex;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  overflow: hidden;
}

.theme-toggle button {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 12px;
  padding: 4px 16px;
  cursor: pointer;
  font: inherit;
}

.theme-toggle button:hover:not(.active) {
  background: var(--hover-bg);
  color: var(--text);
}

.theme-toggle button.active {
  background: var(--accent);
  color: #fff;
}
</style>
