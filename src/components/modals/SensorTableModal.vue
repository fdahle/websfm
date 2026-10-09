<script setup>
import SensorTable from '../controls/SensorTable.vue'

defineProps({
  sensors: { type: Array, required: true },
  images:  { type: Array, default: () => [] },
  cameras: { type: Map,   default: () => new Map() },
})

const emit = defineEmits(['close', 'update', 'apply-film-format', 'remove', 'toggle-fixed', 'set-fiducial-marks', 'detect-fiducials', 'calibrate-fiducials'])
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Sensor Table">
      <div class="modal-header">
        <span class="modal-title">Sensors</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>
      <div class="modal-body">
        <SensorTable
          :sensors="sensors"
          :images="images"
          :cameras="cameras"
          @update="emit('update', $event)"
          @apply-film-format="emit('apply-film-format', $event)"
          @remove="emit('remove', $event)"
          @toggle-fixed="emit('toggle-fixed', $event)"
          @set-fiducial-marks="emit('set-fiducial-marks', $event)"
          @detect-fiducials="emit('detect-fiducials', $event)"
          @calibrate-fiducials="emit('calibrate-fiducials', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
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
  width: min(94vw, 1040px);
  height: 80vh;
  max-height: 80vh;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--panel-border);
  flex-shrink: 0;
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
  flex: 1;
  overflow: auto;
  min-height: 0;
  position: relative;
}
</style>
