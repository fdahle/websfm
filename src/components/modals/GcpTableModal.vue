<script setup>
import GcpTable from '../controls/GcpTable.vue'

defineProps({
  gcps:          { type: Array,  required: true },
  crs:           { type: String, default: null },
  report:        { type: Array,  default: () => [] },
  selectedGcpId: { type: String, default: null },
  hasReferenceDem: { type: Boolean, default: false },
})

const emit = defineEmits([
  'close', 'remove', 'update-accuracy', 'update-name', 'update-position',
  'refresh-report', 'select', 'add', 'fill-z', 'check-z',
])
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Ground Control Points Table">
      <div class="modal-header">
        <span class="modal-title">Ground Control Points</span>
        <div class="modal-actions">
          <button class="modal-refresh" title="Refresh accuracy report" @click="emit('refresh-report')">⟳</button>
          <button class="modal-close" title="Close" @click="emit('close')">×</button>
        </div>
      </div>
      <div class="modal-body">
        <GcpTable
          :gcps="gcps"
          :crs="crs"
          :report="report"
          :selected-gcp-id="selectedGcpId"
          :has-reference-dem="hasReferenceDem"
          @fill-z="emit('fill-z')"
          @check-z="emit('check-z')"
          @remove="emit('remove', $event)"
          @update-accuracy="emit('update-accuracy', $event)"
          @update-name="emit('update-name', $event)"
          @update-position="emit('update-position', $event)"
          @select="emit('select', $event)"
          @add="emit('add')"
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
  width: min(90vw, 900px);
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

.modal-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.modal-close,
.modal-refresh {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 4px;
}

.modal-refresh {
  font-size: 16px;
}

.modal-close:hover,
.modal-refresh:hover {
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
