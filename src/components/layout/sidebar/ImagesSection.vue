<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { useSensorsStore } from '../../../stores/useSensorsStore.js'
import { usePosesStore } from '../../../stores/usePosesStore.js'
import { useContextMenu } from '../../../composables/useContextMenu.js'
import { useExpandedSet } from '../../../composables/useExpandedSet.js'
import { useInlineRename } from '../../../composables/useInlineRename.js'
import { isTiff } from '../../../utils/tiff.js'
import { groupImageSections } from '../../../utils/imageGroups.js'
import { useVirtualList } from '../../../composables/useVirtualList.js'
import ContextMenu from './ContextMenu.vue'
import { useSidebar } from './sidebarContext.js'

defineProps({
  open: { type: Boolean, default: true },
})
const emit = defineEmits(['toggle'])
// sidebar.alignedUuids: UUIDs registered in the sparse model; sidebar.hasSparse
// gates whether "not in this set" means unaligned (vs. reconstruction simply not
// having run yet). sidebar.imageGroup takes
// { op: 'create', id, imageIds } | { op: 'rename', id, name } | { op: 'remove', id }
// | { op: 'assign', imageIds, groupId|null } | { op: 'collapse', id, collapsed }
// | { op: 'move', id, delta }
const sidebar = useSidebar()
// imageGroups: user-named display folders (utils/imageGroups.js); membership is img.groupId.
const { images, imageGroups, selectedId } = storeToRefs(useImagesStore())
const { sensors } = storeToRefs(useSensorsStore())
const { poses } = storeToRefs(usePosesStore())

// ── Groups ───────────────────────────────────────────────────────────────────
// With no groups the list is flat, exactly as before groups existed. Once one
// exists, every image sits under a header — its group, or "Ungrouped" last. The
// list renders from `rows`: headers and image rows interleaved, with a
// collapsed group contributing only its header. `groupKey` names a section
// (a group id, or UNGROUPED); it is the drop-target identity.
const UNGROUPED = '__ungrouped__'
const ungroupedCollapsed = ref(false)
const sections = computed(() => groupImageSections(images.value, imageGroups.value))
// An expanded image contributes a third row kind, its 'details' card, right after
// it — so every element the list renders is one entry here (the virtual list's unit).
const rows = computed(() => {
  const out = []
  const pushImage = (img, groupKey) => {
    out.push({ kind: 'image', key: img.id, img, groupKey })
    if (isExpanded(img.id)) out.push({ kind: 'details', key: `details:${img.id}`, img, groupKey })
  }
  if (!imageGroups.value.length) {
    for (const img of images.value) pushImage(img, undefined)
    return out
  }
  for (const { group, images } of sections.value) {
    const groupKey = group?.id ?? UNGROUPED
    const collapsed = group ? group.collapsed : ungroupedCollapsed.value
    out.push({ kind: 'group', key: `group:${groupKey}`, groupKey, group, count: images.length, collapsed })
    if (!collapsed) for (const img of images) pushImage(img, groupKey)
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
  else sidebar.imageGroup({ op: 'collapse', id: groupKey, collapsed })
}
function toggleGroup(row) {
  setCollapsed(row.groupKey, !row.collapsed)
}

// Inline group rename (same interaction as an image rename).
const {
  editingId: editingGroupId,
  editingName: editingGroupName,
  setInput: setGroupRenameInput,
  start: beginGroupRename,
  commit: commitGroupRename,
  cancel: cancelGroupRename,
} = useInlineRename((id, name) => sidebar.imageGroup({ op: 'rename', id, name }))
function startGroupRename(id) {
  const group = imageGroups.value.find((g) => g.id === id)
  if (!group) return
  // In a long (virtualised) list the header may be outside the rendered window:
  // reveal it first, then start editing (which focuses on the next tick).
  nextTick(() => {
    revealRow(`group:${id}`)
    beginGroupRename(id, group.name)
  })
}

// Drag image rows onto a group header (or any row of that group) to move them.
// A private MIME type keeps this apart from file drops: the sidebar's file
// drop-zone ignores drags that carry no Files, and a header only accepts ours.
const DRAG_TYPE = 'application/x-websfm-image-ids'
const dropTarget = ref(null)
function onRowDragStart(e, img) {
  const ids = selectedSet.value.has(img.id) ? visibleIds.value.filter((id) => selectedSet.value.has(id)) : [img.id]
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids))
  e.dataTransfer.effectAllowed = 'move'
}
function isImageDrag(e) {
  return !!e.dataTransfer?.types?.includes(DRAG_TYPE)
}
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
  try {
    imageIds = JSON.parse(e.dataTransfer.getData(DRAG_TYPE))
  } catch {
    return
  }
  sidebar.imageGroup({ op: 'assign', imageIds, groupId: groupKey === UNGROUPED ? null : groupKey })
}

// Group header context menu. { x, y, row }
const { menu: groupCtx, open: openGroupCtx, close: closeGroupMenu } = useContextMenu()
const groupCtxIndex = computed(() =>
  groupCtx.value?.row.group ? imageGroups.value.findIndex((g) => g.id === groupCtx.value.row.groupKey) : -1,
)
// Run a group menu item against the header it was opened on, then close.
function fromGroupMenu(fn) {
  const { row } = groupCtx.value
  closeGroupMenu()
  fn(row)
}
function groupCtxSelect() {
  const { row } = groupCtx.value
  const ids = membersOf(row.groupKey).map((i) => i.id)
  if (row.collapsed) setCollapsed(row.groupKey, false)
  localSelected.value = ids
  anchor.value = ids[0] ?? null
  closeGroupMenu()
}
function groupCtxCollapseAll(collapsed) {
  for (const g of imageGroups.value) if (g.collapsed !== collapsed) setCollapsed(g.id, collapsed)
  ungroupedCollapsed.value = collapsed
  closeGroupMenu()
}

// Images added instantly, but metadata (EXIF + dimensions) extracts async per
// file — for a 444-image drop that's a visible lag. Surface the progress so the
// (disabled) pipeline buttons aren't the only signal something is still running.
const metaPending = computed(() => images.value.filter((i) => i.loading).length)
const metaDone = computed(() => images.value.length - metaPending.value)

// Per-image expand state
const { isExpanded, toggle: toggleExpand } = useExpandedSet()

// Pose record (exterior orientation) for an image, if any. Indexed once per pose
// list: a scan of every pose per row was O(images × poses).
const poseByImageId = computed(() => {
  const m = new Map()
  for (const p of poses.value) if (p.imageId != null && !m.has(p.imageId)) m.set(p.imageId, p)
  return m
})
const sensorById = computed(() => new Map(sensors.value.map((s) => [s.id, s])))
function poseFor(img) {
  return poseByImageId.value.get(img.id) || null
}
// Pose status shown on the image row: an imported pose, an EXIF GPS prior, or none.
function poseStatus(img) {
  if (poseFor(img)) return 'imported'
  if (img.meta?.gpsLat != null && img.meta?.gpsLon != null) return 'GPS'
  return '—'
}
// Label of the sensor an image is bound to.
function sensorLabel(img) {
  return sensorById.value.get(img.sensorId)?.label || '—'
}
// Film sensor (F4) an image belongs to, or null — gates the fiducial-marks flag.
function filmSensor(img) {
  const s = sensorById.value.get(img.sensorId)
  return s?.kind === 'film' ? s : null
}
// Marks placed on this image (F4). <3 ⇒ interior orientation incomplete.
function fiducialCount(img) {
  return img.fiducialDetections?.length || 0
}
// True once a sparse model exists but this image wasn't registered into it — the
// reconstruction couldn't place its camera. Meaningless before reconstruction runs.
function isUnaligned(img) {
  return sidebar.hasSparse && !sidebar.alignedUuids.has(img.uuid)
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
// Membership test for rendering: `includes` per row was O(rows × selection).
const selectedSet = computed(() => new Set(localSelected.value))
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
    localSelected.value = selectedSet.value.has(img.id)
      ? localSelected.value.filter((id) => id !== img.id)
      : [...localSelected.value, img.id]
    anchor.value = img.id
  } else {
    localSelected.value = [img.id]
    anchor.value = img.id
  }
  sidebar.selectImage(img.id)
}

watch(selectedId, (newId) => {
  if (suppressWatch) {
    suppressWatch = false
    return
  }
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
  if (localSelected.value.length > 1 && selectedSet.value.has(img.id))
    return images.value.filter((i) => selectedSet.value.has(i.id))
  return [img]
})
const ctxIsMulti = computed(() => ctxTargets.value.length > 1)
const ctxHasKp = computed(() => ctxTargets.value.some((i) => i.kpStatus === 'done'))
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
const ctxIsTiff = computed(
  () => !ctxIsMulti.value && isTiff(ctxMenu.value?.img?.sourceName ?? ctxMenu.value?.img?.name),
)

// Inline rename. Multi-selection deliberately cannot be renamed as one action;
// the context menu leaves Rename disabled until it targets a single image.
const {
  editingId: editingImageId,
  editingName,
  setInput: setRenameInput,
  start: startRename,
  commit: commitRename,
  cancel: cancelRename,
} = useInlineRename((id, name) => sidebar.renameImage({ id, name }))

function onRightClick(e, img) {
  // Right-clicking outside the current selection collapses to that single image
  if (!selectedSet.value.has(img.id)) {
    localSelected.value = [img.id]
    anchor.value = img.id
    suppressWatch = true
    sidebar.selectImage(img.id)
  }
  openImageCtx(e, { img })
}

// The action is the same either way (openImageTab focuses an existing tab), but
// the label should tell you which one you'll get. Tab id per useTabs.openImageTab.
const ctxOpenLabel = computed(() =>
  sidebar.openTabIds.has(`img:${ctxMenu.value?.img?.id}`) ? 'Switch to tab' : 'Open in tab',
)

// Run a menu item against the image it was opened on, then close.
function fromMenu(fn) {
  const { img } = ctxMenu.value
  closeMenu()
  fn(img)
}
function ctxDeleteKp() {
  // Pass the whole target set at once so App confirms a batch with a single
  // prompt (matches the remove-image path).
  const ids = ctxTargets.value.filter((img) => img.kpStatus === 'done').map((img) => img.id)
  if (ids.length) sidebar.deleteKeypoints(ids)
  closeMenu()
}
// Grouping acts on the whole target set, like remove/delete-keypoints.
const ctxMoveTargets = computed(() =>
  imageGroups.value.filter((g) => ctxTargets.value.some((img) => img.groupId !== g.id)),
)
const ctxInGroup = computed(() =>
  ctxTargets.value.some((img) => img.groupId != null && imageGroups.value.some((g) => g.id === img.groupId)),
)
function ctxNewGroup() {
  const id = crypto.randomUUID()
  sidebar.imageGroup({ op: 'create', id, imageIds: ctxTargets.value.map((img) => img.id) })
  closeMenu()
  nextTick(() => startGroupRename(id))
}
function ctxMoveTo(groupId) {
  sidebar.imageGroup({ op: 'assign', imageIds: ctxTargets.value.map((img) => img.id), groupId })
  closeMenu()
}
function ctxUngroup() {
  sidebar.imageGroup({ op: 'assign', imageIds: ctxTargets.value.map((img) => img.id), groupId: null })
  closeMenu()
}
function ctxRemove() {
  // Pass the whole target set at once so App can confirm a batch delete
  // with a single prompt.
  sidebar.removeImage(ctxTargets.value.map((img) => img.id))
  closeMenu()
}

// ── Virtual scrolling (TODO ▸ SC-8) ──
// Thousands of images: only the rows inside the sidebar's scroll viewport are in the
// DOM. Heights are fixed by CSS, so the spacers need no measuring: an image row or a
// group header is ROW_PX; a details card is its 4 + 4 px padding, DETAIL_ROW_PX per
// line (how many lines depends on the image) and its 4 px bottom margin. Declared
// last: its watchers read `rows` (and through it everything above) immediately.
const ROW_PX = 24
const DETAIL_ROW_PX = 20
function detailLines(img) {
  return 4 + (filmSensor(img) ? 1 : 0) + (sidebar.hasSparse ? 1 : 0)
}
function rowHeight(row) {
  return row.kind === 'details' ? 8 + DETAIL_ROW_PX * detailLines(row.img) + 4 : ROW_PX
}
const {
  listRef: listEl,
  visibleItems: visibleRows,
  padTop,
  padBottom,
  scrollToIndex,
} = useVirtualList({ items: () => rows.value, heightOf: rowHeight, threshold: 150 })
// Scroll a row into the rendered window (a rename on a header that is off-screen).
function revealRow(key) {
  const i = rows.value.findIndex((r) => r.key === key)
  if (i >= 0) scrollToIndex(i)
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
        <div class="meta-progress-fill" :style="{ width: (metaDone / images.length) * 100 + '%' }"></div>
      </div>
      <span class="meta-progress-label">Reading metadata… {{ metaDone }}/{{ images.length }}</span>
    </div>
    <ul v-if="open" ref="listEl" class="item-list" @dragleave="onListDragLeave" @dragend="dropTarget = null">
      <li v-if="padTop" class="v-spacer" aria-hidden="true" :style="{ height: padTop + 'px' }"></li>
      <template v-for="row in visibleRows" :key="row.key">
        <li
          v-if="row.kind === 'group'"
          class="group-hd"
          :class="{ 'drop-target': dropTarget === row.groupKey, 'group-ungrouped': !row.group }"
          :title="
            row.group ? `${row.group.name} — ${row.count} image${row.count !== 1 ? 's' : ''}` : 'Images in no group'
          "
          @click="toggleGroup(row)"
          @contextmenu="openGroupCtx($event, { row })"
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
            @keydown.esc.prevent.stop="cancelGroupRename"
            @blur="commitGroupRename"
          />
          <span v-else class="group-name">{{ row.group ? row.group.name : 'Ungrouped' }}</span>
          <span class="group-count">{{ row.count }}</span>
        </li>
        <li
          v-else-if="row.kind === 'image'"
          class="list-item"
          :class="{
            'selected': selectedSet.has(row.img.id),
            'unaligned': isUnaligned(row.img),
            'loading': row.img.previewPending,
            'failed': row.img.previewFailed,
            'in-group': row.groupKey,
            'drop-target': row.groupKey && dropTarget === row.groupKey,
          }"
          :title="rowTitle(row.img)"
          :draggable="imageGroups.length > 0 && editingImageId !== row.img.id"
          @click="handleItemClick($event, row.img)"
          @dblclick="sidebar.openImage(row.img.id)"
          @contextmenu="onRightClick($event, row.img)"
          @dragstart="onRowDragStart($event, row.img)"
          @dragover="onDragOver($event, row.groupKey)"
          @drop="onDrop($event, row.groupKey)"
        >
          <button
            class="expand-btn"
            :class="{ open: isExpanded(row.img.id) }"
            @click.stop="toggleExpand(row.img.id)"
            :title="isExpanded(row.img.id) ? 'Collapse' : 'Expand'"
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
            @keydown.esc.prevent.stop="cancelRename"
            @blur="commitRename"
          />
          <span v-else class="item-name">{{ row.img.name }}</span>
          <span v-if="row.img.previewPending" class="load-tag" title="Decoding image…">decoding…</span>
          <span v-else-if="row.img.previewFailed" class="unaligned-tag failed-tag" :title="failReason(row.img)">⚠</span>
          <span
            v-else-if="isUnaligned(row.img)"
            class="unaligned-tag"
            title="Not aligned — no camera in the sparse model"
            >⚠</span
          >
        </li>
        <li v-else class="img-details" :class="{ 'in-group': row.groupKey }" @contextmenu.stop>
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
            <span class="detail-value" :class="{ 'detail-dim': !row.img.sensorId }" :title="sensorLabel(row.img)">{{
              sensorLabel(row.img)
            }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Pose</span>
            <span class="detail-value" :class="{ 'detail-dim': poseStatus(row.img) === '—' }">{{
              poseStatus(row.img)
            }}</span>
          </div>
          <div v-if="filmSensor(row.img)" class="detail-row">
            <span class="detail-label">Fiducials</span>
            <span
              class="detail-value"
              :class="{ 'detail-error': fiducialCount(row.img) < 3 }"
              :title="fiducialCount(row.img) < 3 ? 'Interior orientation incomplete — mark ≥3 fiducials' : ''"
              >{{ fiducialCount(row.img) }}{{ fiducialCount(row.img) < 3 ? ' (incomplete)' : '' }}</span
            >
          </div>
          <div v-if="sidebar.hasSparse" class="detail-row">
            <span class="detail-label">Registered</span>
            <span class="detail-value" :class="{ 'detail-error': isUnaligned(row.img) }">{{
              isUnaligned(row.img) ? 'no' : 'yes'
            }}</span>
          </div>
        </li>
      </template>
      <li v-if="padBottom" class="v-spacer" aria-hidden="true" :style="{ height: padBottom + 'px' }"></li>
      <li v-if="!images.length" class="empty">No images — drop here to add</li>
    </ul>

    <!-- Image context menu -->
    <ContextMenu :menu="ctxMenu">
      <template #default>
        <!-- Groups, in the order every sidebar menu uses: go there → inspect →
             change what it is → destructive. -->
        <button
          class="ctx-item"
          :class="{ 'ctx-disabled': ctxIsMulti }"
          :disabled="ctxIsMulti"
          @click="fromMenu((img) => sidebar.openImage(img.id))"
        >
          {{ ctxOpenLabel }}
        </button>
        <button
          class="ctx-item"
          :class="{ 'ctx-disabled': ctxIsMulti || !ctxHasPosition }"
          :disabled="ctxIsMulti || !ctxHasPosition"
          @click="fromMenu((img) => sidebar.zoomToImage(img.id))"
        >
          Locate on map
        </button>
        <div class="ctx-sep"></div>
        <button
          class="ctx-item"
          :class="{ 'ctx-disabled': ctxIsMulti }"
          :disabled="ctxIsMulti"
          @click="fromMenu((img) => sidebar.showInfo(img.id))"
        >
          Show information
        </button>
        <button
          class="ctx-item"
          :class="{ 'ctx-disabled': ctxIsMulti }"
          :disabled="ctxIsMulti"
          @click="fromMenu((img) => sidebar.downloadImage(img.id))"
        >
          Download original
        </button>
        <button
          class="ctx-item"
          :class="{ 'ctx-disabled': ctxIsMulti }"
          :disabled="ctxIsMulti"
          @click="fromMenu((img) => startRename(img.id, img.name))"
        >
          Rename
        </button>
        <div class="ctx-sep"></div>
        <button class="ctx-item" @click="ctxNewGroup">
          {{ ctxIsMulti ? 'New group from selection' : 'New group with this image' }}
        </button>
        <div v-if="ctxMoveTargets.length" class="ctx-sub-wrap">
          <button class="ctx-item ctx-has-sub">Move to group<span class="ctx-arrow">▸</span></button>
          <div class="ctx-submenu">
            <button v-for="g in ctxMoveTargets" :key="g.id" class="ctx-item" @click="ctxMoveTo(g.id)">
              {{ g.name }}
            </button>
          </div>
        </div>
        <button v-if="ctxInGroup" class="ctx-item" @click="ctxUngroup">Remove from group</button>
        <template v-if="ctxIsTiff">
          <div class="ctx-sep"></div>
          <button
            class="ctx-item"
            title="Re-import this GeoTIFF as an imported DEM / orthophoto"
            @click="fromMenu((img) => sidebar.convertImageToRaster(img.id))"
          >
            Convert to reference data
          </button>
        </template>
        <div class="ctx-sep"></div>
        <button v-if="ctxHasKp" class="ctx-item danger" @click="ctxDeleteKp">Delete keypoints</button>
        <button class="ctx-item danger" @click="ctxRemove">{{ ctxIsMulti ? 'Remove images' : 'Remove image' }}</button>
      </template>
    </ContextMenu>

    <!-- Group header context menu -->
    <ContextMenu :menu="groupCtx">
      <template #default="{ menu }">
        <button
          class="ctx-item"
          :class="{ 'ctx-disabled': !menu.row.count }"
          :disabled="!menu.row.count"
          @click="groupCtxSelect"
        >
          Select images
        </button>
        <template v-if="menu.row.group">
          <button class="ctx-item" @click="fromGroupMenu((row) => startGroupRename(row.groupKey))">Rename</button>
          <button
            class="ctx-item"
            :class="{ 'ctx-disabled': groupCtxIndex <= 0 }"
            :disabled="groupCtxIndex <= 0"
            @click="fromGroupMenu((row) => sidebar.imageGroup({ op: 'move', id: row.groupKey, delta: -1 }))"
          >
            Move up
          </button>
          <button
            class="ctx-item"
            :class="{ 'ctx-disabled': groupCtxIndex >= imageGroups.length - 1 }"
            :disabled="groupCtxIndex >= imageGroups.length - 1"
            @click="fromGroupMenu((row) => sidebar.imageGroup({ op: 'move', id: row.groupKey, delta: 1 }))"
          >
            Move down
          </button>
        </template>
        <div class="ctx-sep"></div>
        <button class="ctx-item" @click="groupCtxCollapseAll(true)">Collapse all</button>
        <button class="ctx-item" @click="groupCtxCollapseAll(false)">Expand all</button>
        <template v-if="menu.row.group">
          <div class="ctx-sep"></div>
          <button
            class="ctx-item"
            title="The images stay in the project, ungrouped"
            @click="fromGroupMenu((row) => sidebar.imageGroup({ op: 'remove', id: row.groupKey }))"
          >
            Remove group
          </button>
        </template>
      </template>
    </ContextMenu>
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
.group-hd:hover {
  background: var(--hover-bg);
}
.group-hd.group-ungrouped .group-name {
  color: var(--text-dim);
  font-style: italic;
  font-weight: 400;
}
.group-chevron {
  width: 10px;
  font-size: 10px;
  color: var(--text-dim);
  flex-shrink: 0;
}
.group-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.group-count {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-dim);
  flex-shrink: 0;
}
.list-item.in-group {
  padding-left: 24px;
}
/* Fixed line height: the virtual list computes a details card's height from it
   (ImagesSection DETAIL_ROW_PX) instead of measuring. */
.img-details .detail-row {
  height: 20px;
  line-height: 20px;
  gap: 8px;
}
.img-details .detail-label {
  flex-shrink: 0;
}
.img-details .detail-value {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.v-spacer {
  list-style: none;
  pointer-events: none;
}
.img-details.in-group {
  margin-left: 31px;
}
.drop-target {
  background: rgba(14, 99, 156, 0.18);
}
.group-hd.drop-target {
  box-shadow: inset 0 0 0 1px var(--accent);
}
</style>
