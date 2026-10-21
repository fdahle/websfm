<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useSensorsStore } from '../../../stores/useSensorsStore.js'
import { DISTORTION_MODELS, distortionOf } from '../../../core/sfm/distortion.js'
import { useContextMenu } from '../../../composables/useContextMenu.js'
import { useExpandedSet } from '../../../composables/useExpandedSet.js'
import ContextMenu from './ContextMenu.vue'
import { useSidebar } from './sidebarContext.js'
import { pluralize } from '../../../core/textFormat.js'

defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['toggle'])
// sidebar.sensorImageCount(sensorId) → number of images using that sensor;
// sidebar.incompleteSensorIds — Set of sensor ids with no usable calibration,
// flagged with a ⚠.
const sidebar = useSidebar()
const { sensors } = storeToRefs(useSensorsStore())

// Per-sensor expand state
const { isExpanded, toggle: toggleSensorExpand } = useExpandedSet()

const round = (n, d = 1) => (n == null ? null : Number(n.toFixed(d)))
function fmtFocal(s) {
  if (s.focal == null) return '—'
  return `${round(s.focal, 2)} ${s.focalUnit || 'px'}`
}
function fmtDims(s) {
  return s.width && s.height ? `${s.width} × ${s.height}` : '—'
}
// The lens model when it changes anything (a fisheye always does), else null.
const lensLabel = (s) =>
  distortionOf(s) ? (DISTORTION_MODELS.find((m) => m.id === s.distortionModel)?.label ?? 'Brown') : null

// Sensor context menu (right-click). { x, y, sensor }
const { menu: sensorCtx, open: openSensorCtx, close: closeMenu } = useContextMenu()
// Other sensors a right-clicked sensor can be merged into.
const mergeTargets = computed(() =>
  sensorCtx.value ? sensors.value.filter((s) => s.id !== sensorCtx.value.sensor.id) : [],
)
// Run a menu item against the sensor it was opened on, then close.
function fromMenu(fn) {
  const sensor = sensorCtx.value.sensor
  closeMenu()
  fn(sensor)
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
          @dblclick="sidebar.openSensor(sensor.id)"
          @contextmenu="openSensorCtx($event, { sensor })"
        >
          <button
            class="expand-btn"
            :class="{ open: isExpanded(sensor.id) }"
            @click.stop="toggleSensorExpand(sensor.id)"
            :title="isExpanded(sensor.id) ? 'Collapse' : 'Expand'"
          ></button>
          <span class="item-name">{{ sensor.label }}</span>
          <span
            v-if="sidebar.incompleteSensorIds.has(sensor.id)"
            class="unaligned-tag"
            title="No usable calibration — intrinsics fall back to a default field-of-view guess, which distorts SfM and depth maps. Set a focal length in the sensor table."
            >⚠</span
          >
          <span class="obs-badge" :title="`${pluralize(sidebar.sensorImageCount(sensor.id), 'image')}`">{{
            sidebar.sensorImageCount(sensor.id)
          }}</span>
        </li>
        <li v-if="isExpanded(sensor.id)" class="img-details" @contextmenu.stop>
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
            <span class="detail-label">Lens</span>
            <span class="detail-value" :class="{ 'detail-dim': !lensLabel(sensor) }">{{
              lensLabel(sensor) ?? '—'
            }}</span>
          </div>
        </li>
      </template>
      <li v-if="!sensors.length" class="empty">No sensors — add images or import a calibration</li>
    </ul>

    <!-- Sensor context menu -->
    <ContextMenu :menu="sensorCtx">
      <div v-if="mergeTargets.length" class="ctx-sub-wrap">
        <button class="ctx-item ctx-has-sub">Merge into<span class="ctx-arrow">▸</span></button>
        <div class="ctx-submenu">
          <button
            v-for="t in mergeTargets"
            :key="t.id"
            class="ctx-item"
            @click="fromMenu((s) => sidebar.mergeSensors({ target: t.id, source: s.id }))"
          >
            {{ t.label }}
          </button>
        </div>
      </div>
      <div v-if="mergeTargets.length" class="ctx-sep"></div>
      <button class="ctx-item danger" @click="fromMenu((s) => sidebar.removeSensor(s.id))">Remove sensor</button>
    </ContextMenu>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
