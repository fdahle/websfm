<script setup>
import GcpTable from '../../controls/GcpTable.vue'
import ModalShell from '../ui/ModalShell.vue'

defineProps({
  gcps: { type: Array, required: true },
  crs: { type: String, default: null },
  report: { type: Array, default: () => [] },
  selectedGcpId: { type: String, default: null },
  hasReferenceDem: { type: Boolean, default: false },
  sceneType: { type: String, default: null },
  awaitingGeoreference: { type: Boolean, default: false },
})

const emit = defineEmits([
  'close',
  'remove',
  'update-accuracy',
  'update-observation-accuracy',
  'update-name',
  'update-position',
  'update-role',
  'update-vertical-datum',
  'update-accuracy-preset',
  'convert-heights',
  'georeference',
  'refresh-report',
  'select',
  'add',
  'fill-z',
  'check-z',
])
</script>

<template>
  <ModalShell
    title="Control &amp; Markers"
    aria-label="Control and Markers Table"
    width="min(90vw, 900px)"
    height="80vh"
    flush
    @close="emit('close')"
  >
    <template #actions>
      <button class="modal-refresh" title="Refresh accuracy report" @click="emit('refresh-report')">⟳</button>
    </template>
    <GcpTable
      :gcps="gcps"
      :crs="crs"
      :report="report"
      :selected-gcp-id="selectedGcpId"
      :has-reference-dem="hasReferenceDem"
      :scene-type="sceneType"
      :awaiting-georeference="awaitingGeoreference"
      @georeference="emit('georeference')"
      @fill-z="emit('fill-z')"
      @check-z="emit('check-z')"
      @remove="emit('remove', $event)"
      @update-accuracy="emit('update-accuracy', $event)"
      @update-observation-accuracy="emit('update-observation-accuracy', $event)"
      @update-name="emit('update-name', $event)"
      @update-position="emit('update-position', $event)"
      @update-role="emit('update-role', $event)"
      @update-vertical-datum="emit('update-vertical-datum', $event)"
      @update-accuracy-preset="emit('update-accuracy-preset', $event)"
      @convert-heights="emit('convert-heights', $event)"
      @select="emit('select', $event)"
      @add="emit('add', $event)"
    />
  </ModalShell>
</template>

<style scoped>
/* The table is absolutely positioned inside the (filling) body. */
:deep(.modal-body) {
  position: relative;
}

.modal-refresh {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 4px;
}
.modal-refresh:hover {
  background: var(--hover-bg);
  color: var(--text);
}
</style>
