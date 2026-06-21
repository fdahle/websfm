<script setup>
defineProps({
  theme: String,
  persistenceEnabled: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'set-theme', 'set-persistence'])
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
          <div class="setting-info">
            <span class="setting-label">Theme</span>
          </div>
          <div class="theme-toggle">
            <button :class="{ active: theme === 'dark' }" @click="emit('set-theme', 'dark')">Dark</button>
            <button :class="{ active: theme === 'light' }" @click="emit('set-theme', 'light')">Light</button>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Persist sessions</span>
            <span class="setting-desc">Save projects and images across browser sessions using OPFS</span>
          </div>
          <label class="toggle">
            <input
              type="checkbox"
              :checked="persistenceEnabled"
              @change="emit('set-persistence', $event.target.checked)"
            />
            <span class="toggle-track"></span>
          </label>
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
  width: 380px;
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
  padding: 8px 0;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
}

.setting-row + .setting-row {
  border-top: 1px solid var(--panel-border);
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.setting-label {
  font-size: 13px;
  color: var(--text);
}

.setting-desc {
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.4;
}

.theme-toggle {
  display: flex;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
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

.toggle {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
  cursor: pointer;
}

.toggle input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}

.toggle-track {
  display: block;
  width: 36px;
  height: 20px;
  background: var(--panel-border);
  border-radius: 10px;
  transition: background 0.15s;
  position: relative;
}

.toggle-track::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}

.toggle input:checked + .toggle-track {
  background: var(--accent);
}

.toggle input:checked + .toggle-track::after {
  transform: translateX(16px);
}
</style>
