<script setup>
import { ref, computed } from 'vue'
import { useContextMenu } from '../../../composables/useContextMenu.js'

const props = defineProps({
  open:    { type: Boolean, default: false },
  sensors: { type: Array, default: () => [] },
  // (sensorId) => number of images using that sensor
  sensorImageCount: { type: Function, default: () => 0 },
  // Set of sensor ids with no usable calibration — flagged with a ⚠.
  incompleteSensorIds: { type: Object, default: () => new Set() },
})
const emit = defineEmits(['toggle', 'remove-sensor', 'merge-sensors', 'open-sensor'])

// Per-sensor expand state
const sensorExpanded = ref({})
function toggleSensorExpand(id) {
  if (sensorExpanded.value[id]) delete sensorExpanded.value[id]
  else sensorExpanded.value[id] = true
}

const round = (n, d = 1) => (n == null ? null : Number(n.toFixed(d)))
function fmtFocal(s) {
  if (s.focal == null) return '—'
  return `${round(s.focal, 2)} ${s.focalUnit || 'px'}`
}
function fmtDims(s) {
  return s.width && s.height ? `${s.width} × ${s.height}` : '—'
}
const hasDistortion = (s) => [s.k1, s.k2, s.k3, s.p1, s.p2].some((v) => v != null)

// Sensor context menu (right-click). { x, y, sensor }
const { menu: sensorCtx, open: openSensorCtx, close: closeMenu } = useContextMenu()
function onSensorRightClick(e, sensor) {
  openSensorCtx(e, { sensor }, { w: 200, h: 160 })
}
// Other sensors a right-clicked sensor can be merged into.
const mergeTargets = computed(() =>
  sensorCtx.value ? props.sensors.filter((s) => s.id !== sensorCtx.value.sensor.id) : []
)
function ctxRemoveSensor() { emit('remove-sensor', sensorCtx.value.sensor.id); closeMenu() }
function ctxMergeSensor(targetId) {
  emit('merge-sensors', { target: targetId, source: sensorCtx.value.sensor.id })
  closeMenu()
}
</script>

<template>
  <div class="section">
    <button class="section-hd" @click="emit('toggle')">
      <span class="chevron">{{ open ? '▾' : '▸' }}</span>
      <span class="section-name">Sensors</span>
      <span v-if="sensors.length" class="badge">{{ sensors.length }}</span>
    </button>
    <ul v-if="open" class="item-list">
      <template v-for="sensor in sensors" :key="sensor.id">
        <li
          class="list-item"
          :title="sensor.label"
          @click="toggleSensorExpand(sensor.id)"
          @dblclick="emit('open-sensor', sensor.id)"
          @contextmenu="onSensorRightClick($event, sensor)"
        >
          <button
            class="expand-btn"
            :class="{ open: sensorExpanded[sensor.id] }"
            @click.stop="toggleSensorExpand(sensor.id)"
            :title="sensorExpanded[sensor.id] ? 'Collapse' : 'Expand'"
          ></button>
          <span class="item-name">{{ sensor.label }}</span>
          <span
            v-if="incompleteSensorIds.has(sensor.id)"
            class="unaligned-tag"
            title="No usable calibration — intrinsics fall back to a default field-of-view guess, which distorts SfM and depth maps. Set a focal length in the sensor table."
          >⚠</span>
          <span class="obs-badge" :title="`${sensorImageCount(sensor.id)} image(s)`">{{ sensorImageCount(sensor.id) }}</span>
        </li>
        <li v-if="sensorExpanded[sensor.id]" class="img-details" @contextmenu.stop>
          <div class="detail-row">
            <span class="detail-label">Source</span>
            <span class="detail-value">{{ sensor.source === 'exif' ? 'EXIF' : 'imported' }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Dimensions</span>
            <span class="detail-value">{{ fmtDims(sensor) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Focal</span>
            <span class="detail-value">{{ fmtFocal(sensor) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Principal pt</span>
            <span class="detail-value" :class="{ 'detail-dim': sensor.cx == null }">
              <template v-if="sensor.cx != null">{{ round(sensor.cx) }}, {{ round(sensor.cy) }}</template>
              <template v-else>—</template>
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Distortion</span>
            <span class="detail-value" :class="{ 'detail-dim': !hasDistortion(sensor) }">{{ hasDistortion(sensor) ? 'yes' : '—' }}</span>
          </div>
        </li>
      </template>
      <li v-if="!sensors.length" class="empty">No sensors — add images or import a calibration</li>
    </ul>

    <!-- Sensor context menu -->
    <Teleport to="body">
      <div
        v-if="sensorCtx"
        class="ctx-menu"
        :style="{ left: sensorCtx.x + 'px', top: sensorCtx.y + 'px' }"
        @click.stop
      >
        <div v-if="mergeTargets.length" class="ctx-sub-wrap">
          <button class="ctx-item ctx-has-sub">Merge into<span class="ctx-arrow">▸</span></button>
          <div class="ctx-submenu">
            <button v-for="s in mergeTargets" :key="s.id" class="ctx-item" @click="ctxMergeSensor(s.id)">{{ s.label }}</button>
          </div>
        </div>
        <div v-if="mergeTargets.length" class="ctx-sep"></div>
        <button class="ctx-item danger" @click="ctxRemoveSensor">Remove sensor</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
