<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useContextMenu } from '../../../composables/useContextMenu.js'
import { isTiff } from '../../../utils/tiff.js'
import { groupImageSections } from '../../../utils/imageGroups.js'

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
  openTabIds:   { type: Object, default: () => new Set() },
  // User-named display folders (utils/imageGroups.js); membership is img.groupId.
  imageGroups:  { type: Array, default: () => [] },
})
const emit = defineEmits([
  'toggle', 'select', 'open', 'show-info', 'zoom-to-image',
  'delete-keypoints', 'remove-image', 'rename-image', 'convert-to-raster',
  // { op: 'create', id, imageIds } | { op: 'rename', id, name } | { op: 'remove', id }
  // | { op: 'assign', imageIds, groupId|null } | { op: 'collapse', id, collapsed }
  // | { op: 'move', id, delta }
  'image-group',
])

// ── Groups ───────────────────────────────────────────────────────────────────
// With no groups the list is flat, exactly as before groups existed. Once one
// exists, every image sits under a header — its group, or "Ungrouped" last. The
// list renders from `rows`: headers and image rows interleaved, with a
// collapsed group contributing only its header. `groupKey` names a section
// (a group id, or UNGROUPED); it is the drop-target identity.
const UNGROUPED = '__ungrouped__'
const ungroupedCollapsed = ref(false)
const sections = computed(() => groupImageSections(props.images, props.imageGroups))
const rows = computed(() => {
  if (!props.imageGroups.length) return props.images.map((img) => ({ kind: 'image', key: img.id, img }))
  const out = []
  for (const { group, images } of sections.value) {
    const groupKey = group?.id ?? UNGROUPED
    const collapsed = group ? group.collapsed : ungroupedCollapsed.value
    out.push({ kind: 'group', key: `group:${groupKey}`, groupKey, group, count: images.length, collapsed })
    if (!collapsed) for (const img of images) out.push({ kind: 'image', key: img.id, img, groupKey })
  }
  return out
})
// Image ids in on-screen order — what a shift-click range spans.
const visibleIds = computed(() => rows.value.filter((r) => r.kind === 'image').map((r) => r.img.id))

function membersOf(groupKey) {
  const s = sections.value.find((x) => (x.group?.id ?? UNGROUPED) === groupKey)
  return s ? s.images : []
}

function setCollapsed(groupKey, collapsed) {
  if (groupKey === UNGROUPED) ungroupedCollapsed.value = collapsed
  else emit('image-group', { op: 'collapse', id: groupKey, collapsed })
}
function toggleGroup(row) { setCollapsed(row.groupKey, !row.collapsed) }

// Inline group rename (same interaction as an image rename).
const editingGroupId = ref(null)
const editingGroupName = ref('')
const groupRenameInput = ref(null)
function setGroupRenameInput(el) { if (el) groupRenameInput.value = el }
function startGroupRename(id) {
  const group = props.imageGroups.find((g) => g.id === id)
  if (!group) return
  editingGroupId.value = id
  editingGroupName.value = group.name
  nextTick(() => { groupRenameInput.value?.focus(); groupRenameInput.value?.select() })
}
function commitGroupRename() {
  if (editingGroupId.value == null) return
  emit('image-group', { op: 'rename', id: editingGroupId.value, name: editingGroupName.value })
  editingGroupId.value = null
}
function cancelGroupRename() { editingGroupId.value = null }

// Drag image rows onto a group header (or any row of that group) to move them.
// A private MIME type keeps this apart from file drops: the sidebar's file
// drop-zone ignores drags that carry no Files, and a header only accepts ours.
const DRAG_TYPE = 'application/x-websfm-image-ids'
const dropTarget = ref(null)
function onRowDragStart(e, img) {
  const ids = localSelected.value.includes(img.id)
    ? visibleIds.value.filter((id) => localSelected.value.includes(id))
    : [img.id]
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids))
  e.dataTransfer.effectAllowed = 'move'
}
function isImageDrag(e) { return !!e.dataTransfer?.types?.includes(DRAG_TYPE) }
function onDragOver(e, groupKey) {
  if (!groupKey || !isImageDrag(e)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  dropTarget.value = groupKey
}
function onListDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) dropTarget.value = null
}
function onDrop(e, groupKey) {
  if (!groupKey || !isImageDrag(e)) return
  e.preventDefault()
  e.stopPropagation()
  dropTarget.value = null
  let imageIds = []
  try { imageIds = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) } catch { return }
  emit('image-group', { op: 'assign', imageIds, groupId: groupKey === UNGROUPED ? null : groupKey })
}

// Group header context menu. { x, y, row }
const { menu: groupCtx, open: openGroupCtx, close: closeGroupMenu } = useContextMenu()
const groupCtxIndex = computed(() =>
  groupCtx.value?.row.group ? props.imageGroups.findIndex((g) => g.id === groupCtx.value.row.groupKey) : -1)
function onGroupRightClick(e, row) { openGroupCtx(e, { row }, { w: 200, h: 200 }) }
function groupCtxSelect() {
  const { row } = groupCtx.value
  const ids = membersOf(row.groupKey).map((i) => i.id)
  if (row.collapsed) setCollapsed(row.groupKey, false)
  localSelected.value = ids
  anchor.value = ids[0] ?? null
  closeGroupMenu()
}
function groupCtxRename() { startGroupRename(groupCtx.value.row.groupKey); closeGroupMenu() }
function groupCtxMove(delta) {
  emit('image-group', { op: 'move', id: groupCtx.value.row.groupKey, delta })
  closeGroupMenu()
}
function groupCtxCollapseAll(collapsed) {
  for (const g of props.imageGroups) if (g.collapsed !== collapsed) setCollapsed(g.id, collapsed)
  ungroupedCollapsed.value = collapsed
  closeGroupMenu()
}
function groupCtxRemove() {
  emit('image-group', { op: 'remove', id: groupCtx.value.row.groupKey })
  closeGroupMenu()
}

// Images added instantly, but metadata (EXIF + dimensions) extracts async per
// file — for a 444-image drop that's a visible lag. Surface the progress so the
// (disabled) pipeline buttons aren't the only signal something is still running.
const metaPending = computed(() => props.images.filter((i) => i.loading).length)
const metaDone = computed(() => props.images.length - metaPending.value)

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
// Detection and hand-marking write fiducialDetections; fiducialObs is the
// pre-split field, read only for an image that has not migrated yet.
function fiducialCount(img) {
  return img.fiducialDetections?.length || img.fiducialObs?.length || 0
}
// True once a sparse model exists but this image wasn't registered into it — the
// reconstruction couldn't place its camera. Meaningless before reconstruction runs.
function isUnaligned(img) {
  return props.hasSparse && !props.alignedUuids.has(img.uuid)
}

// Why an image can't be shown. 'source-lost' is the mid-session case: the file
// behind its blob: URL went away and project storage had no usable copy, so it
// will also fail detection / dense / ortho — worth saying, not just "failed".
function failReason(img) {
  return img.previewFailReason === 'source-lost'
    ? 'image file no longer available — re-add the file'
    : 'failed to load (could not decode image)'
}

// Tooltip for the image row, reflecting its load state.
function rowTitle(img) {
  if (img.previewPending) return `${img.name} — decoding…`
  if (img.previewFailed) return `${img.name} — ${failReason(img)}`
  if (isUnaligned(img)) return `${img.name} — not aligned (no camera in the sparse model)`
  return img.name
}

// Multi-select: local array of selected ids + anchor for shift-range
const localSelected = ref([])
const anchor = ref(null)
let suppressWatch = false

function handleItemClick(e, img) {
  suppressWatch = true
  // Ranges follow the on-screen order, which differs from list order once
  // images are grouped; an anchor hidden in a collapsed group starts afresh.
  const ids = visibleIds.value
  if (e.shiftKey && anchor.value !== null && ids.includes(anchor.value)) {
    const ai = ids.indexOf(anchor.value)
    const ci = ids.indexOf(img.id)
    const [from, to] = ai <= ci ? [ai, ci] : [ci, ai]
    localSelected.value = ids.slice(from, to + 1)
  } else if (e.ctrlKey || e.metaKey) {
    localSelected.value = localSelected.value.includes(img.id)
      ? localSelected.value.filter((id) => id !== img.id)
      : [...localSelected.value, img.id]
    anchor.value = img.id
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

// Only a TIFF can carry GeoTIFF geolocation tags, so only a TIFF is worth
// offering to re-route into reference data. The offer is deliberately not
// gated on the tags actually being *present* — the whole point of this action
// is that the ingest-time sniff already said "no" and the user disagrees; the
// import itself is what decides, and it fails loudly if there is no
// geotransform.
const ctxIsTiff = computed(() => !ctxIsMulti.value
  && isTiff(ctxMenu.value?.img?.sourceName ?? ctxMenu.value?.img?.name))

// Inline rename. Multi-selection deliberately cannot be renamed as one action;
// the context menu leaves Rename disabled until it targets a single image.
const editingImageId = ref(null)
const editingName = ref('')
const renameInput = ref(null)
function setRenameInput(el) { if (el) renameInput.value = el }
function startRename(img) {
  editingImageId.value = img.id
  editingName.value = img.name
  nextTick(() => { renameInput.value?.focus(); renameInput.value?.select() })
}
function commitRename() {
  if (editingImageId.value == null) return
  emit('rename-image', { id: editingImageId.value, name: editingName.value })
  editingImageId.value = null
}
function cancelRename() { editingImageId.value = null }

function onRightClick(e, img) {
  // Right-clicking outside the current selection collapses to that single image
  if (!localSelected.value.includes(img.id)) {
    localSelected.value = [img.id]
    anchor.value = img.id
    suppressWatch = true
    emit('select', img.id)
  }
  openImageCtx(e, { img }, { w: 200, h: 290 })
}

// The action is the same either way (openImageTab focuses an existing tab), but
// the label should tell you which one you'll get. Tab id per useTabs.openImageTab.
const ctxOpenLabel = computed(() =>
  props.openTabIds.has(`img:${ctxMenu.value?.img?.id}`) ? 'Switch to tab' : 'Open in tab')

function ctxOpen()     { emit('open', ctxMenu.value.img.id); closeMenu() }
function ctxInfo()     { emit('show-info', ctxMenu.value.img.id); closeMenu() }
function ctxZoom()     { emit('zoom-to-image', ctxMenu.value.img.id); closeMenu() }
function ctxRename()   { startRename(ctxMenu.value.img); closeMenu() }
function ctxDeleteKp() {
  // Emit the whole target set at once so the parent confirms a batch with a single
  // prompt (matches the remove-image path).
  const ids = ctxTargets.value.filter((img) => img.kpStatus === 'done').map((img) => img.id)
  if (ids.length) emit('delete-keypoints', ids)
  closeMenu()
}
// Grouping acts on the whole target set, like remove/delete-keypoints.
const ctxMoveTargets = computed(() => props.imageGroups.filter((g) =>
  ctxTargets.value.some((img) => img.groupId !== g.id)))
const ctxInGroup = computed(() => ctxTargets.value.some((img) =>
  img.groupId != null && props.imageGroups.some((g) => g.id === img.groupId)))
function ctxNewGroup() {
  const id = crypto.randomUUID()
  emit('image-group', { op: 'create', id, imageIds: ctxTargets.value.map((img) => img.id) })
  closeMenu()
  nextTick(() => startGroupRename(id))
}
function ctxMoveTo(groupId) {
  emit('image-group', { op: 'assign', imageIds: ctxTargets.value.map((img) => img.id), groupId })
  closeMenu()
}
function ctxUngroup() {
  emit('image-group', { op: 'assign', imageIds: ctxTargets.value.map((img) => img.id), groupId: null })
  closeMenu()
}
function ctxToRaster() {
  emit('convert-to-raster', ctxMenu.value.img.id)
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
    <div
      v-if="open && metaPending"
      class="meta-progress"
      :title="`Reading image metadata — ${metaDone} of ${images.length} done`"
    >
      <div class="meta-progress-track">
        <div class="meta-progress-fill" :style="{ width: (metaDone / images.length * 100) + '%' }"></div>
      </div>
      <span class="meta-progress-label">Reading metadata… {{ metaDone }}/{{ images.length }}</span>
    </div>
    <ul v-if="open" class="item-list" @dragleave="onListDragLeave" @dragend="dropTarget = null">
      <template v-for="row in rows" :key="row.key">
        <li
          v-if="row.kind === 'group'"
          class="group-hd"
          :class="{ 'drop-target': dropTarget === row.groupKey, 'group-ungrouped': !row.group }"
          :title="row.group ? `${row.group.name} — ${row.count} image${row.count !== 1 ? 's' : ''}` : 'Images in no group'"
          @click="toggleGroup(row)"
          @contextmenu="onGroupRightClick($event, row)"
          @dragover="onDragOver($event, row.groupKey)"
          @drop="onDrop($event, row.groupKey)"
        >
          <span class="group-chevron">{{ row.collapsed ? '▸' : '▾' }}</span>
          <input
            v-if="row.group && editingGroupId === row.groupKey"
            :ref="setGroupRenameInput"
            v-model="editingGroupName"
            class="rename-input"
            @click.stop
            @keydown.enter.prevent="commitGroupRename"
            @keydown.esc.prevent="cancelGroupRename"
            @blur="commitGroupRename"
          />
          <span v-else class="group-name">{{ row.group ? row.group.name : 'Ungrouped' }}</span>
          <span class="group-count">{{ row.count }}</span>
        </li>
        <template v-else>
        <li
          class="list-item"
          :class="{ selected: localSelected.includes(row.img.id), unaligned: isUnaligned(row.img), loading: row.img.previewPending, failed: row.img.previewFailed, 'in-group': row.groupKey, 'drop-target': row.groupKey && dropTarget === row.groupKey }"
          :title="rowTitle(row.img)"
          :draggable="imageGroups.length > 0 && editingImageId !== row.img.id"
          @click="handleItemClick($event, row.img)"
          @dblclick="emit('open', row.img.id)"
          @contextmenu="onRightClick($event, row.img)"
          @dragstart="onRowDragStart($event, row.img)"
          @dragover="onDragOver($event, row.groupKey)"
          @drop="onDrop($event, row.groupKey)"
        >
          <button
            class="expand-btn"
            :class="{ open: expanded[row.img.id] }"
            @click.stop="toggleExpand(row.img.id)"
            :title="expanded[row.img.id] ? 'Collapse' : 'Expand'"
          ></button>
          <span v-if="row.img.previewPending" class="status-dot loading"></span>
          <span v-else-if="row.img.loading" class="status-dot loading" title="Reading metadata…"></span>
          <span v-else-if="row.img.kpStatus === 'running'" class="status-dot running"></span>
          <span v-else-if="row.img.kpStatus === 'error'" class="status-dot error"></span>
          <input
            v-if="editingImageId === row.img.id"
            :ref="setRenameInput"
            v-model="editingName"
            class="rename-input"
            @click.stop
            @dblclick.stop
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename"
          />
          <span v-else class="item-name">{{ row.img.name }}</span>
          <span v-if="row.img.previewPending" class="load-tag" title="Decoding image…">decoding…</span>
          <span v-else-if="row.img.previewFailed" class="unaligned-tag failed-tag" :title="failReason(row.img)">⚠</span>
          <span v-else-if="isUnaligned(row.img)" class="unaligned-tag" title="Not aligned — no camera in the sparse model">⚠</span>
        </li>
        <li v-if="expanded[row.img.id]" :key="`details:${row.img.id}`" class="img-details" :class="{ 'in-group': row.groupKey }" @contextmenu.stop>
          <div class="detail-row">
            <span class="detail-label">Keypoints</span>
            <span class="detail-value">
              <template v-if="row.img.kpStatus === 'done'">
                {{ row.img.kpCount }}
              </template>
              <span v-else-if="row.img.kpStatus === 'running'" class="detail-dim">detecting…</span>
              <span v-else-if="row.img.kpStatus === 'error'" class="detail-error">failed</span>
              <span v-else class="detail-dim">—</span>
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Mask</span>
            <span class="detail-value">
              <span v-if="row.img.mask">yes</span>
              <span v-else class="detail-dim">—</span>
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Sensor</span>
            <span class="detail-value" :class="{ 'detail-dim': !row.img.sensorId }">{{ sensorLabel(row.img) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Pose</span>
            <span class="detail-value" :class="{ 'detail-dim': poseStatus(row.img) === '—' }">{{ poseStatus(row.img) }}</span>
          </div>
          <div v-if="filmSensor(row.img)" class="detail-row">
            <span class="detail-label">Fiducials</span>
            <span
              class="detail-value"
              :class="{ 'detail-error': fiducialCount(row.img) < 3 }"
              :title="fiducialCount(row.img) < 3 ? 'Interior orientation incomplete — mark ≥3 fiducials' : ''"
            >{{ fiducialCount(row.img) }}{{ fiducialCount(row.img) < 3 ? ' (incomplete)' : '' }}</span>
          </div>
          <div v-if="hasSparse" class="detail-row">
            <span class="detail-label">Registered</span>
            <span class="detail-value" :class="{ 'detail-error': isUnaligned(row.img) }">{{ isUnaligned(row.img) ? 'no' : 'yes' }}</span>
          </div>
        </li>
        </template>
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
        <!-- Groups, in the order every sidebar menu uses: go there → inspect →
             change what it is → destructive. -->
        <button class="ctx-item" :class="{ 'ctx-disabled': ctxIsMulti }" :disabled="ctxIsMulti" @click="ctxOpen">{{ ctxOpenLabel }}</button>
        <button class="ctx-item" :class="{ 'ctx-disabled': ctxIsMulti || !ctxHasPosition }" :disabled="ctxIsMulti || !ctxHasPosition" @click="ctxZoom">Zoom to position on map</button>
        <div class="ctx-sep"></div>
        <button class="ctx-item" :class="{ 'ctx-disabled': ctxIsMulti }" :disabled="ctxIsMulti" @click="ctxInfo">Show information</button>
        <button class="ctx-item" :class="{ 'ctx-disabled': ctxIsMulti }" :disabled="ctxIsMulti" @click="ctxRename">Rename</button>
        <div class="ctx-sep"></div>
        <button class="ctx-item" @click="ctxNewGroup">{{ ctxIsMulti ? 'New group from selection' : 'New group with this image' }}</button>
        <div v-if="ctxMoveTargets.length" class="ctx-sub-wrap">
          <button class="ctx-item ctx-has-sub">Move to group<span class="ctx-arrow">▸</span></button>
          <div class="ctx-submenu">
            <button v-for="g in ctxMoveTargets" :key="g.id" class="ctx-item" @click="ctxMoveTo(g.id)">{{ g.name }}</button>
          </div>
        </div>
        <button v-if="ctxInGroup" class="ctx-item" @click="ctxUngroup">Remove from group</button>
        <template v-if="ctxIsTiff">
          <div class="ctx-sep"></div>
          <button
            class="ctx-item"
            title="Re-import this GeoTIFF as an imported DEM / orthophoto"
            @click="ctxToRaster"
          >Convert to reference data</button>
        </template>
        <div class="ctx-sep"></div>
        <button v-if="ctxHasKp" class="ctx-item danger" @click="ctxDeleteKp">Delete keypoints</button>
        <button class="ctx-item danger" @click="ctxRemove">{{ ctxIsMulti ? 'Remove images' : 'Remove image' }}</button>
      </div>
    </Teleport>

    <!-- Group header context menu -->
    <Teleport to="body">
      <div
        v-if="groupCtx"
        class="ctx-menu"
        :style="{ left: groupCtx.x + 'px', top: groupCtx.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item" :class="{ 'ctx-disabled': !groupCtx.row.count }" :disabled="!groupCtx.row.count" @click="groupCtxSelect">Select images</button>
        <template v-if="groupCtx.row.group">
          <button class="ctx-item" @click="groupCtxRename">Rename</button>
          <button class="ctx-item" :class="{ 'ctx-disabled': groupCtxIndex <= 0 }" :disabled="groupCtxIndex <= 0" @click="groupCtxMove(-1)">Move up</button>
          <button class="ctx-item" :class="{ 'ctx-disabled': groupCtxIndex >= imageGroups.length - 1 }" :disabled="groupCtxIndex >= imageGroups.length - 1" @click="groupCtxMove(1)">Move down</button>
        </template>
        <div class="ctx-sep"></div>
        <button class="ctx-item" @click="groupCtxCollapseAll(true)">Collapse all</button>
        <button class="ctx-item" @click="groupCtxCollapseAll(false)">Expand all</button>
        <template v-if="groupCtx.row.group">
          <div class="ctx-sep"></div>
          <button class="ctx-item" title="The images stay in the project, ungrouped" @click="groupCtxRemove">Remove group</button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
<style scoped>
/* Image group headers — lighter than a section header, heavier than a row. */
.group-hd {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 3px 12px 3px 8px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.group-hd:hover { background: var(--hover-bg); }
.group-hd.group-ungrouped .group-name { color: var(--text-dim); font-style: italic; font-weight: 400; }
.group-chevron { width: 10px; font-size: 10px; color: var(--text-dim); flex-shrink: 0; }
.group-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.group-count { font-size: 11px; font-weight: 400; color: var(--text-dim); flex-shrink: 0; }
.list-item.in-group { padding-left: 24px; }
.img-details.in-group { margin-left: 31px; }
.drop-target { background: rgba(14, 99, 156, 0.18); }
.group-hd.drop-target { box-shadow: inset 0 0 0 1px var(--accent); }
</style>
