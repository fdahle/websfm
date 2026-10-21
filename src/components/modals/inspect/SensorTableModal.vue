<script setup>
import SensorTable from '../../controls/SensorTable.vue'
import ModalShell from '../ui/ModalShell.vue'

defineProps({
  sensors: { type: Array, required: true },
  images:  { type: Array, default: () => [] },
  cameras: { type: Map,   default: () => new Map() },
})

const emit = defineEmits(['close', 'update', 'apply-film-format', 'remove', 'toggle-fixed', 'set-fiducial-marks', 'detect-fiducials', 'calibrate-fiducials'])
</script>

<template>
  <ModalShell title="Sensors" aria-label="Sensor Table" width="min(94vw, 1040px)" height="80vh" flush @close="emit('close')">
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
  </ModalShell>
</template>

<style scoped>
/* The table is absolutely positioned inside the (filling) body. */
:deep(.modal-body) { position: relative; }
</style>
