<script setup>
import { ref } from 'vue'
import CrsPicker from '../controls/CrsPicker.vue'

defineProps({
  canCancel: { type: Boolean, default: true },
})

const emit = defineEmits(['create', 'cancel'])

const name = ref('My Project')
const sceneType = ref('aerial')
const crs = ref('EPSG:4326')

function submit() {
  const n = name.value.trim()
  if (!n) return
  // Object-capture projects have no geographic CRS (scale is set manually).
  const crsValue = sceneType.value === 'object' ? null : crs.value
  emit('create', { name: n, sceneType: sceneType.value, crs: crsValue })
}
</script>

<template>
  <div class="modal-overlay" @click.self="canCancel && emit('cancel')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="New Project">
      <div class="modal-header">
        <span class="modal-title">New Project</span>
        <button v-if="canCancel" class="modal-close" @click="emit('cancel')">×</button>
      </div>

      <div class="modal-body">
        <label class="field-label">Project name</label>
        <input
          v-model="name"
          class="name-input"
          type="text"
          placeholder="My Project"
          maxlength="80"
          autofocus
          @keydown.enter="submit"
        />

        <label class="field-label" style="margin-top: 20px">Scene type</label>
        <div class="scene-cards">
          <button
            class="scene-card"
            :class="{ active: sceneType === 'aerial' }"
            @click="sceneType = 'aerial'"
          >
            <span class="scene-icon">✈</span>
            <span class="scene-name">Aerial survey</span>
            <span class="scene-desc">Drone or aerial imagery with GPS coordinates, geo-referenced output</span>
          </button>
          <button
            class="scene-card"
            :class="{ active: sceneType === 'object' }"
            @click="sceneType = 'object'"
          >
            <span class="scene-icon">◼</span>
            <span class="scene-name">Object capture</span>
            <span class="scene-desc">Objects or scenes without GPS — scale set manually</span>
          </button>
        </div>

        <label class="field-label" style="margin-top: 20px">Coordinate system</label>
        <CrsPicker v-model="crs" :disabled="sceneType === 'object'" />
        <span class="crs-hint">{{
          sceneType === 'object'
            ? 'Object-capture projects have no coordinate system — scale is set manually.'
            : 'Working CRS for the map, GCPs and cameras. You can change it later in Settings.'
        }}</span>
      </div>

      <div class="modal-footer">
        <button v-if="canCancel" class="btn-secondary" @click="emit('cancel')">Cancel</button>
        <button class="btn-primary" :disabled="!name.trim()" @click="submit">Create project</button>
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
  width: 460px;
  max-width: 92vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
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
  display: flex;
  flex-direction: column;
}

.field-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  margin-bottom: 8px;
}

.name-input {
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  padding: 7px 10px;
  width: 100%;
  box-sizing: border-box;
  outline: none;
}

.name-input:focus {
  border-color: var(--accent);
}

.scene-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.scene-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 14px;
  background: var(--bg);
  border: 2px solid var(--panel-border);
  border-radius: 7px;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: var(--text);
  transition: border-color 0.1s;
}

.scene-card:hover {
  border-color: var(--text-dim);
}

.scene-card.active {
  border-color: var(--accent);
  background: rgba(14, 99, 156, 0.1);
}

.scene-icon {
  font-size: 22px;
  line-height: 1;
}

.scene-name {
  font-size: 13px;
  font-weight: 600;
}

.scene-desc {
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.4;
}

.crs-hint {
  display: block;
  margin-top: 7px;
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.4;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--panel-border);
}

.btn-secondary {
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  padding: 6px 14px;
  cursor: pointer;
}

.btn-secondary:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.btn-primary {
  background: var(--accent);
  border: none;
  border-radius: 5px;
  color: #fff;
  font: inherit;
  font-size: 12px;
  padding: 6px 16px;
  cursor: pointer;
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-primary:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
