<script setup>
import { ref, computed, watch } from 'vue'
import { useContextMenu } from '../../../composables/useContextMenu.js'

const props = defineProps({
  open:       { type: Boolean, default: true },
  images:     { type: Array, required: true },
  sensors:    { type: Array, default: () => [] },
  poses:      { type: Array, default: () => [] },
  selectedId: { type: String, default: null },
  // UUIDs registered in the sparse model; hasSparse gates whether "not in this
  // set" means unaligned (vs. reconstruction simply not having run yet).
  alignedUuids: { type: Object, default: () => new Set() },
  hasSparse:    { type: Boolean, default: false },
})
const emit = defineEmits([
  'toggle', 'select', 'open', 'show-info', 'zoom-to-image',
  'delete-keypoints', 'remove-image',
])

// Per-image expand state
const expanded = ref({})
function toggleExpand(id) {
  if (expanded.value[id]) delete expanded.value[id]
  else expanded.value[id] = true
}

// Pose record (exterior orientation) for an image, if any.
function poseFor(img) {
  return props.poses.find((p) => p.imageId === img.id) || null
}
// Pose status shown on the image row: an imported pose, an EXIF GPS prior, or none.
function poseStatus(img) {
  if (poseFor(img)) return 'imported'
  if (img.meta?.gpsLat != null && img.meta?.gpsLon != null) return 'GPS'
  return '—'
}
// Label of the sensor an image is bound to.
function sensorLabel(img) {
  return props.sensors.find((s) => s.id === img.sensorId)?.label || '—'
}
// Film sensor (F4) an image belongs to, or null — gates the fiducial-marks flag.
function filmSensor(img) {
  const s = props.sensors.find((x) => x.id === img.sensorId)
  return s?.kind === 'film' ? s : null
}
// Marks placed on this image (F4). <3 ⇒ interior orientation incomplete.
function fiducialCount(img) {
  return img.fiducialObs?.length ?? 0
}
// True once a sparse model exists but this image wasn't registered into it — the
// reconstruction couldn't place its camera. Meaningless before reconstruction runs.
function isUnaligned(img) {
  return props.hasSparse && !props.alignedUuids.has(img.uuid)
}

// Tooltip for the image row, reflecting its load state.
function rowTitle(img) {
  if (img.previewPending) return `${img.name} — decoding…`
  if (img.previewFailed) return `${img.name} — failed to load (could not decode image)`
  if (isUnaligned(img)) return `${img.name} — not aligned (no camera in the sparse model)`
  return img.name
}

// Multi-select: local array of selected ids + anchor for shift-range
const localSelected = ref([])
const anchor = ref(null)
let suppressWatch = false

function handleItemClick(e, img) {
  suppressWatch = true
  if (e.shiftKey && anchor.value !== null) {
    const ids = props.images.map((i) => i.id)
    const ai = ids.indexOf(anchor.value)
    const ci = ids.indexOf(img.id)
    const [from, to] = ai <= ci ? [ai, ci] : [ci, ai]
    localSelected.value = ids.slice(from, to + 1)
  } else {
    localSelected.value = [img.id]
    anchor.value = img.id
  }
  emit('select', img.id)
}

watch(() => props.selectedId, (newId) => {
  if (suppressWatch) { suppressWatch = false; return }
  localSelected.value = newId ? [newId] : []
  anchor.value = newId
})

// Image context menu (right-click). { x, y, img }
const { menu: ctxMenu, open: openImageCtx, close: closeMenu } = useContextMenu()

// The set of images the context menu should act on:
// multi if right-clicking within an existing multi-selection, else just the one image.
const ctxTargets = computed(() => {
  if (!ctxMenu.value) return []
  const { img } = ctxMenu.value
  if (localSelected.value.length > 1 && localSelected.value.includes(img.id))
    return props.images.filter((i) => localSelected.value.includes(i.id))
  return [img]
})
const ctxIsMulti = computed(() => ctxTargets.value.length > 1)
const ctxHasKp   = computed(() => ctxTargets.value.some((i) => i.kpStatus === 'done'))
// Can we point at this image on the map? True if it has a pose or an EXIF GPS fix.
const ctxHasPosition = computed(() => {
  const img = ctxMenu.value?.img
  return !!img && (!!poseFor(img) || (img.meta?.gpsLat != null && img.meta?.gpsLon != null))
})

function onRightClick(e, img) {
  // Right-clicking outside the current selection collapses to that single image
  if (!localSelected.value.includes(img.id)) {
    localSelected.value = [img.id]
    anchor.value = img.id
    suppressWatch = true
    emit('select', img.id)
  }
  openImageCtx(e, { img }, { w: 200, h: 180 })
}

function ctxOpen()     { emit('open', ctxMenu.value.img.id); closeMenu() }
function ctxInfo()     { emit('show-info', ctxMenu.value.img.id); closeMenu() }
function ctxZoom()     { emit('zoom-to-image', ctxMenu.value.img.id); closeMenu() }
function ctxDeleteKp() {
  // Emit the whole target set at once so the parent confirms a batch with a single
  // prompt (matches the remove-image path).
  const ids = ctxTargets.value.filter((img) => img.kpStatus === 'done').map((img) => img.id)
  if (ids.length) emit('delete-keypoints', ids)
  closeMenu()
}
function ctxRemove() {
  // Emit the whole target set at once so the parent can confirm a batch delete
  // with a single prompt.
  emit('remove-image', ctxTargets.value.map((img) => img.id))
  closeMenu()
}
</script>

<template>
  <div class="section">
    <button class="section-hd" @click="emit('toggle')">
      <span class="chevron">{{ open ? '▾' : '▸' }}</span>
      <span class="section-name">Images</span>
      <span v-if="images.length" class="badge">{{ images.length }}</span>
    </button>
    <ul v-if="open" class="item-list">
      <template v-for="img in images" :key="img.id">
        <li
          class="list-item"
          :class="{ selected: localSelected.includes(img.id), unaligned: isUnaligned(img), loading: img.previewPending, failed: img.previewFailed }"
          :title="rowTitle(img)"
          @click="handleItemClick($event, img)"
          @dblclick="emit('open', img.id)"
          @contextmenu="onRightClick($event, img)"
        >
          <button
            class="expand-btn"
            :class="{ open: expanded[img.id] }"
            @click.stop="toggleExpand(img.id)"
            :title="expanded[img.id] ? 'Collapse' : 'Expand'"
          ></button>
          <span v-if="img.previewPending" class="status-dot loading"></span>
          <span v-else-if="img.kpStatus === 'running'" class="status-dot running"></span>
          <span v-else-if="img.kpStatus === 'error'" class="status-dot error"></span>
          <span class="item-name">{{ img.name }}</span>
          <span v-if="img.previewPending" class="load-tag" title="Decoding image…">decoding…</span>
          <span v-else-if="img.previewFailed" class="unaligned-tag failed-tag" title="Failed to load — image could not be decoded">⚠</span>
          <span v-else-if="isUnaligned(img)" class="unaligned-tag" title="Not aligned — no camera in the sparse model">⚠</span>
        </li>
        <li v-if="expanded[img.id]" class="img-details" @contextmenu.stop>
          <div class="detail-row">
            <span class="detail-label">Keypoints</span>
            <span class="detail-value">
              <template v-if="img.kpStatus === 'done'">
                {{ img.kpCount }}
              </template>
              <span v-else-if="img.kpStatus === 'running'" class="detail-dim">detecting…</span>
              <span v-else-if="img.kpStatus === 'error'" class="detail-error">failed</span>
              <span v-else class="detail-dim">—</span>
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Mask</span>
            <span class="detail-value">
              <span v-if="img.mask">yes</span>
              <span v-else class="detail-dim">—</span>
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Sensor</span>
            <span class="detail-value" :class="{ 'detail-dim': !img.sensorId }">{{ sensorLabel(img) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Pose</span>
            <span class="detail-value" :class="{ 'detail-dim': poseStatus(img) === '—' }">{{ poseStatus(img) }}</span>
          </div>
          <div v-if="filmSensor(img)" class="detail-row">
            <span class="detail-label">Fiducials</span>
            <span
              class="detail-value"
              :class="{ 'detail-error': fiducialCount(img) < 3 }"
              :title="fiducialCount(img) < 3 ? 'Interior orientation incomplete — mark ≥3 fiducials' : ''"
            >{{ fiducialCount(img) }}{{ fiducialCount(img) < 3 ? ' (incomplete)' : '' }}</span>
          </div>
          <div v-if="hasSparse" class="detail-row">
            <span class="detail-label">Registered</span>
            <span class="detail-value" :class="{ 'detail-error': isUnaligned(img) }">{{ isUnaligned(img) ? 'no' : 'yes' }}</span>
          </div>
        </li>
      </template>
      <li v-if="!images.length" class="empty">No images — drop here to add</li>
    </ul>

    <!-- Image context menu -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        class="ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item" :class="{ 'ctx-disabled': ctxIsMulti }" :disabled="ctxIsMulti" @click="ctxOpen">Open in tab</button>
        <button class="ctx-item" :class="{ 'ctx-disabled': ctxIsMulti }" :disabled="ctxIsMulti" @click="ctxInfo">Show information</button>
        <button class="ctx-item" :class="{ 'ctx-disabled': ctxIsMulti || !ctxHasPosition }" :disabled="ctxIsMulti || !ctxHasPosition" @click="ctxZoom">Zoom to position on map</button>
        <div class="ctx-sep"></div>
        <button v-if="ctxHasKp" class="ctx-item danger" @click="ctxDeleteKp">Delete keypoints</button>
        <button class="ctx-item danger" @click="ctxRemove">Remove image</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
