<script setup>
import { ref, nextTick } from 'vue'
import { useContextMenu } from '../../../composables/useContextMenu.js'

defineProps({
  open:            { type: Boolean, default: true },
  clouds:          { type: Array, default: () => [] },
  selectedCloudId: { type: String, default: null },
  reconStatus:     { type: String, default: 'idle' }, // 'idle'|'running'|'done'|'error'
})
const emit = defineEmits(['toggle', 'select-cloud', 'remove-cloud', 'rename-cloud', 'reconstruct', 'zoom-to-cloud'])

const cloudExpanded = ref({})
function toggleCloudExpand(id) {
  if (cloudExpanded.value[id]) delete cloudExpanded.value[id]
  else cloudExpanded.value[id] = true
}

const cloudKindLabel = (kind) => (kind === 'dense' ? 'Dense' : 'Sparse')

// Tie-points = sparse points carrying at least one view-track. (Dense clouds have
// no tracks, so this is only shown for sparse clouds.)
function tiePointCount(cloud) {
  return cloud.points.reduce((n, p) => n + (p.views?.size > 0 ? 1 : 0), 0)
}

function fmtCreated(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
}

// Inline rename. Only one cloud edits at a time. The input lives inside the cloud
// v-for, so a plain `ref="…"` would collect into an *array* (leaving `.focus()`
// a silent no-op — the field never focuses and never blurs, so the row appears
// stuck in rename mode). A function ref captures the single live element instead.
const editingCloudId = ref(null)
const editingName = ref('')
const renameInput = ref(null)

function setRenameInput(el) {
  if (el) renameInput.value = el
}

function startRename(cloud) {
  editingCloudId.value = cloud.id
  editingName.value = cloud.name
  nextTick(() => { renameInput.value?.focus(); renameInput.value?.select() })
}

function commitRename() {
  if (editingCloudId.value == null) return
  emit('rename-cloud', { id: editingCloudId.value, name: editingName.value })
  editingCloudId.value = null
}

function cancelRename() {
  editingCloudId.value = null
}

// Point cloud context menu (right-click). { x, y, cloud }
const { menu: cloudCtx, open: openCloudCtx, close: closeMenu } = useContextMenu()
function onCloudRightClick(e, cloud) {
  openCloudCtx(e, { cloud }, { w: 180, h: 156 })
}
function ctxZoomCloud()    { emit('zoom-to-cloud', cloudCtx.value.cloud.id); closeMenu() }
function ctxRenameCloud()  { startRename(cloudCtx.value.cloud); closeMenu() }
function ctxRebuildCloud() { emit('reconstruct'); closeMenu() }
function ctxRemoveCloud()  { emit('remove-cloud', cloudCtx.value.cloud.id); closeMenu() }
</script>

<template>
  <div class="section">
    <button class="section-hd" @click="emit('toggle')">
      <span class="chevron">{{ open ? '▾' : '▸' }}</span>
      <span class="section-name">Point Clouds</span>
      <span v-if="reconStatus === 'running'" class="status-dot running"></span>
      <span v-else-if="reconStatus === 'error'" class="status-dot error"></span>
      <span v-else-if="clouds.length" class="badge">{{ clouds.length }}</span>
    </button>
    <ul v-if="open" class="item-list">
      <template v-for="cloud in clouds" :key="cloud.id">
        <li
          class="list-item"
          :class="{ selected: cloud.id === selectedCloudId }"
          :title="cloud.name"
          @click="emit('select-cloud', cloud.id)"
          @contextmenu="onCloudRightClick($event, cloud)"
        >
          <button
            class="expand-btn"
            :class="{ open: cloudExpanded[cloud.id] }"
            @click.stop="toggleCloudExpand(cloud.id)"
            :title="cloudExpanded[cloud.id] ? 'Collapse' : 'Expand'"
          ></button>
          <input
            v-if="editingCloudId === cloud.id"
            :ref="setRenameInput"
            v-model="editingName"
            class="rename-input"
            @click.stop
            @dblclick.stop
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename"
          />
          <span v-else class="item-name">{{ cloud.name }}</span>
          <span class="obs-badge" :title="`${cloud.cameras.size} camera(s)`">{{ cloud.cameras.size }}</span>
        </li>
        <li v-if="cloudExpanded[cloud.id]" class="img-details" @contextmenu.stop>
          <div class="detail-row">
            <span class="detail-label">Type</span>
            <span class="detail-value">{{ cloudKindLabel(cloud.kind) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Cameras</span>
            <span class="detail-value">{{ cloud.cameras.size }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Points</span>
            <span class="detail-value">{{ cloud.points.length.toLocaleString() }}</span>
          </div>
          <div v-if="cloud.kind === 'sparse'" class="detail-row">
            <span class="detail-label">Tie-points</span>
            <span class="detail-value">{{ tiePointCount(cloud).toLocaleString() }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Created</span>
            <span class="detail-value">{{ fmtCreated(cloud.createdAt) }}</span>
          </div>
        </li>
      </template>
      <li v-if="reconStatus === 'running' && !clouds.length" class="empty">Reconstructing…</li>
      <li v-else-if="!clouds.length" class="empty">No point clouds yet</li>
    </ul>

    <!-- Point cloud context menu -->
    <Teleport to="body">
      <div
        v-if="cloudCtx"
        class="ctx-menu"
        :style="{ left: cloudCtx.x + 'px', top: cloudCtx.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item" @click="ctxZoomCloud">Zoom to</button>
        <button class="ctx-item" @click="ctxRenameCloud">Rename</button>
        <button class="ctx-item" @click="ctxRebuildCloud">Rebuild sparse cloud</button>
        <div class="ctx-sep"></div>
        <button class="ctx-item danger" @click="ctxRemoveCloud">Remove</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
