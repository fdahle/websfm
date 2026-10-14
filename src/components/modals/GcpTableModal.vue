<script setup>
import GcpTable from '../controls/GcpTable.vue'
import ModalShell from './ui/ModalShell.vue'

defineProps({
  gcps:          { type: Array,  required: true },
  crs:           { type: String, default: null },
  report:        { type: Array,  default: () => [] },
  selectedGcpId: { type: String, default: null },
  hasReferenceDem: { type: Boolean, default: false },
  sceneType:       { type: String,  default: null },
})

const emit = defineEmits([
  'close', 'remove', 'update-accuracy', 'update-observation-accuracy', 'update-name', 'update-position',
  'update-role', 'update-vertical-datum', 'refresh-report', 'select', 'add', 'fill-z', 'check-z',
])
</script>

<template>
  <ModalShell title="Control &amp; Markers" aria-label="Control and Markers Table" width="min(90vw, 900px)" height="80vh" flush @close="emit('close')">
    <template #header>
      <span class="gcp-title">Control &amp; Markers</span>
      <button class="modal-refresh" title="Refresh accuracy report" @click="emit('refresh-report')">⟳</button>
    </template>
    <GcpTable
      :gcps="gcps"
      :crs="crs"
      :report="report"
      :selected-gcp-id="selectedGcpId"
      :has-reference-dem="hasReferenceDem"
      :scene-type="sceneType"
      @fill-z="emit('fill-z')"
      @check-z="emit('check-z')"
      @remove="emit('remove', $event)"
      @update-accuracy="emit('update-accuracy', $event)"
      @update-observation-accuracy="emit('update-observation-accuracy', $event)"
      @update-name="emit('update-name', $event)"
      @update-position="emit('update-position', $event)"
      @update-role="emit('update-role', $event)"
      @update-vertical-datum="emit('update-vertical-datum', $event)"
      @select="emit('select', $event)"
      @add="emit('add', $event)"
    />
  </ModalShell>
</template>

<style scoped>
/* The table is absolutely positioned inside the (filling) body. */
:deep(.modal-body) { position: relative; }

/* #header replaces the shell's title, so the title look is restated here; it takes
   the free width so the refresh button sits beside the close button. */
.gcp-title { flex: 1; font-size: 14px; font-weight: 600; color: var(--text); }

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
.modal-refresh:hover { background: var(--hover-bg); color: var(--text); }
</style>
