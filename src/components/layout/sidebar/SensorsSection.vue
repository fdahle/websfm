<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useSensorsStore } from '../../../stores/useSensorsStore.js'
import { DISTORTION_MODELS, distortionOf } from '../../../core/sfm/distortion.js'
import { useContextMenu } from '../../../composables/useContextMenu.js'
import { useExpandedSet } from '../../../composables/useExpandedSet.js'
import { useI18n } from '../../../composables/useI18n.js'
import ContextMenu from './ContextMenu.vue'
import { useSidebar } from './sidebarContext.js'

defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['toggle'])
// sidebar.sensorImageCount(sensorId) → number of images using that sensor;
// sidebar.incompleteSensorIds — Set of sensor ids with no usable calibration,
// flagged with a ⚠; sidebar.selectSensorImages(sensorId) selects its images in Images.
const sidebar = useSidebar()
const { sensors } = storeToRefs(useSensorsStore())
const { t } = useI18n()

// Per-sensor expand state
const { isExpanded, toggle: toggleSensorExpand } = useExpandedSet()

function fmtFocal(s) {
  return s.focal == null
    ? t('sidebar.sensors.none')
    : t('sidebar.sensors.focalValue', { v: s.focal, unit: s.focalUnit || 'px' })
}
function fmtDims(s) {
  return s.width && s.height
    ? t('sidebar.sensors.dimensionsValue', { w: s.width, h: s.height })
    : t('sidebar.sensors.none')
}
// The lens model when it changes anything (a fisheye always does), else null.
const lensLabel = (s) =>
  distortionOf(s)
    ? (DISTORTION_MODELS.find((m) => m.id === s.distortionModel) ?? DISTORTION_MODELS.find((m) => m.id === 'brown'))
        ?.label
    : null

// The tooltip of a group that may hold photos of more than one camera
// (core/sensors/splitSuggestions.js, via sidebar.sensorSplits).
function splitHint(x) {
  const why = [
    ...(x.formats.length ? [{ key: 'sidebar.sensors.splitFormats', params: { n: x.formats.length } }] : []),
    ...x.misfits.map((m) => ({ key: 'sidebar.sensors.splitMisfit', params: { roll: m.roll } })),
  ]
  return t('sidebar.sensors.split', { n: x.groups.length, why })
}
function countTitle(id) {
  const n = sidebar.sensorImageCount(id)
  return n ? t('sidebar.sensors.count', { n }) : t('sidebar.sensors.countNone')
}

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
      <span class="section-name">{{ t('sidebar.sensors.title') }}</span>
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
            :title="isExpanded(sensor.id) ? t('sidebar.sensors.collapse') : t('sidebar.sensors.expand')"
          ></button>
          <span class="item-name">{{ sensor.label }}</span>
          <span
            v-if="sidebar.incompleteSensorIds.has(sensor.id)"
            class="unaligned-tag"
            :title="t('sidebar.sensors.incomplete')"
            >⚠</span
          >
          <span
            v-if="sidebar.sensorSplits.has(sensor.id)"
            class="unaligned-tag"
            :title="splitHint(sidebar.sensorSplits.get(sensor.id))"
            >⑂</span
          >
          <button
            class="obs-badge count-btn"
            :disabled="!sidebar.sensorImageCount(sensor.id)"
            :title="countTitle(sensor.id)"
            @click.stop="sidebar.selectSensorImages(sensor.id)"
            @dblclick.stop
          >
            {{ sidebar.sensorImageCount(sensor.id) }}
          </button>
        </li>
        <li v-if="isExpanded(sensor.id)" class="img-details" @contextmenu.stop>
          <div class="detail-row">
            <span class="detail-label">{{ t('sidebar.sensors.source') }}</span>
            <span class="detail-value">{{
              sensor.source === 'exif' ? t('sidebar.sensors.sourceExif') : t('sidebar.sensors.sourceImported')
            }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('sidebar.sensors.dimensions') }}</span>
            <span class="detail-value">{{ fmtDims(sensor) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('sidebar.sensors.focal') }}</span>
            <span class="detail-value">{{ fmtFocal(sensor) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('sidebar.sensors.principal') }}</span>
            <span class="detail-value" :class="{ 'detail-dim': sensor.cx == null }">{{
              sensor.cx != null
                ? t('sidebar.sensors.principalValue', { x: sensor.cx, y: sensor.cy })
                : t('sidebar.sensors.none')
            }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('sidebar.sensors.lens') }}</span>
            <span class="detail-value" :class="{ 'detail-dim': !lensLabel(sensor) }">{{
              lensLabel(sensor) ?? t('sidebar.sensors.none')
            }}</span>
          </div>
        </li>
      </template>
      <li v-if="!sensors.length" class="empty">{{ t('sidebar.sensors.empty') }}</li>
    </ul>

    <!-- Sensor context menu -->
    <ContextMenu :menu="sensorCtx">
      <button class="ctx-item" @click="fromMenu((s) => sidebar.showProductInfo({ sensorId: s.id }))">
        {{ t('sidebar.sensors.menu.info') }}
      </button>
      <button
        class="ctx-item"
        :class="{ 'ctx-disabled': !sidebar.sensorImageCount(sensorCtx?.sensor.id) }"
        :disabled="!sidebar.sensorImageCount(sensorCtx?.sensor.id)"
        :title="sidebar.sensorImageCount(sensorCtx?.sensor.id) ? null : t('sidebar.sensors.countNone')"
        @click="fromMenu((s) => sidebar.selectSensorImages(s.id))"
      >
        {{ t('sidebar.sensors.menu.selectImages') }}
      </button>
      <button class="ctx-item" @click="fromMenu((s) => sidebar.splitSensor(s.id))">
        {{ t('sidebar.sensors.menu.split') }}
      </button>
      <div class="ctx-sep"></div>
      <div v-if="mergeTargets.length" class="ctx-sub-wrap">
        <button class="ctx-item ctx-has-sub">
          {{ t('sidebar.sensors.menu.mergeInto') }}<span class="ctx-arrow">▸</span>
        </button>
        <div class="ctx-submenu">
          <button
            v-for="m in mergeTargets"
            :key="m.id"
            class="ctx-item"
            @click="fromMenu((s) => sidebar.mergeSensors({ target: m.id, source: s.id }))"
          >
            {{ m.label }}
          </button>
        </div>
      </div>
      <div v-if="mergeTargets.length" class="ctx-sep"></div>
      <button class="ctx-item danger" @click="fromMenu((s) => sidebar.removeSensor(s.id))">
        {{ t('sidebar.sensors.menu.remove') }}
      </button>
    </ContextMenu>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
<style scoped>
/* The image count is a button: it selects the sensor's images in Images. */
.count-btn {
  border: none;
  cursor: pointer;
  font-family: inherit;
}
.count-btn:hover:not(:disabled) {
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.count-btn:disabled {
  cursor: default;
}
</style>
