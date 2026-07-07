<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  images:     { type: Array,  required: true },
  gcps:       { type: Array,  default: () => [] },
  sensors:    { type: Array,  default: () => [] },
  poses:      { type: Array,  default: () => [] },
  // Point clouds: [{ id, name, kind, createdAt, cameras: Map, points: [] }]
  clouds:     { type: Array,  default: () => [] },
  selectedCloudId: { type: String, default: null },
  // Raster products (recomputable): DEM / orthophoto, or null when not built.
  dem:        { type: Object, default: null },
  ortho:      { type: Object, default: null },
  reconStatus: { type: String, default: 'idle' }, // 'idle'|'running'|'done'|'error'
  // Pairwise-match summary: { total, verified, running, error }
  matchStats: { type: Object, default: () => ({ total: 0, verified: 0, running: 0, error: 0 }) },
  // (sensorId) => number of images using that sensor
  sensorImageCount: { type: Function, default: () => 0 },
  selectedId: { type: String, default: null },
  // UUIDs registered in the sparse model; `hasSparse` gates whether "not in this
  // set" means unaligned (vs. reconstruction simply not having run yet).
  alignedUuids: { type: Object, default: () => new Set() },
  hasSparse:    { type: Boolean, default: false },
})

const emit = defineEmits([
  'add-images', 'import-file', 'remove-image', 'remove-gcp',
  'remove-sensor', 'merge-sensors', 'assign-sensor', 'remove-pose',
  'select', 'open', 'show-info', 'delete-keypoints', 'zoom-to-image',
  'select-cloud', 'remove-cloud', 'rename-cloud', 'reconstruct',
  'open-matches', 'open-product', 'zoom-to-cloud',
])

// Whole-sidebar drag-and-drop (counter avoids false dragleave on children)
const isDragging = ref(false)
let dragCounter = 0

function onDragEnter(e) {
  e.preventDefault()
  dragCounter++
  isDragging.value = true
}

function onDragLeave() {
  if (--dragCounter === 0) isDragging.value = false
}

function onDrop(e) {
  e.preventDefault()
  dragCounter = 0
  isDragging.value = false
  const all = [...e.dataTransfer.files]
  const images = all.filter((f) => f.type.startsWith('image/'))
  if (images.length) emit('add-images', images)
  // Route the first non-image file (e.g. a .csv/.txt list of GCPs or camera
  // positions) to the importer, which classifies it and opens the right modal.
  const other = all.find((f) => !f.type.startsWith('image/'))
  if (other) emit('import-file', other)
}

// Collapsible sections
const open = ref({ images: true, gcps: true, sensors: false, matches: true, clouds: true, products: true })

function toggle(key) {
  open.value[key] = !open.value[key]
}

// ── Products (DEM / orthophoto) ────────────────────────────────────────────────
// One row per built raster; opening (double-click) shows it in a tab like an image.
const productRows = computed(() => {
  const rows = []
  if (props.dem) rows.push({ kind: 'dem', name: 'DEM', product: props.dem })
  if (props.ortho) rows.push({ kind: 'ortho', name: 'Orthophoto', product: props.ortho })
  return rows
})

const productExpanded = ref({})
function toggleProductExpand(kind) {
  if (productExpanded.value[kind]) delete productExpanded.value[kind]
  else productExpanded.value[kind] = true
}

const productUnit = (p) => (p?.unit === 'm' ? 'm' : 'units')
const productCrs = (p) => (p?.crs === 'local' || !p?.crs ? 'Local' : p.crs)

// Matches summary is a single expandable row (no per-pair list — pairs are O(N²)
// and live in the dedicated modal). This just toggles the inline stats card.
const matchesExpanded = ref(false)

// ── Point cloud rows ──────────────────────────────────────────────────────────
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

function fmtCreated(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
}

// ── Point cloud context menu ──────────────────────────────────────────────────
const cloudCtx = ref(null) // { x, y, cloud }

function onCloudRightClick(e, cloud) {
  e.preventDefault()
  ctxMenu.value = null
  sensorCtx.value = null
  const menuW = 180, menuH = 156
  cloudCtx.value = {
    x: Math.min(e.clientX, window.innerWidth - menuW),
    y: Math.min(e.clientY, window.innerHeight - menuH),
    cloud,
  }
}

function ctxZoomCloud()    { emit('zoom-to-cloud', cloudCtx.value.cloud.id); closeMenus() }
function ctxRenameCloud()  { startRename(cloudCtx.value.cloud); closeMenus() }
function ctxRebuildCloud() { emit('reconstruct'); closeMenus() }
function ctxRemoveCloud()  { emit('remove-cloud', cloudCtx.value.cloud.id); closeMenus() }

// Per-sensor expand state
const sensorExpanded = ref({})

function toggleSensorExpand(id) {
  if (sensorExpanded.value[id]) delete sensorExpanded.value[id]
  else sensorExpanded.value[id] = true
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

// True once a sparse model exists but this image wasn't registered into it — the
// reconstruction couldn't place its camera. Meaningless before reconstruction runs.
function isUnaligned(img) {
  return props.hasSparse && !props.alignedUuids.has(img.uuid)
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

// Per-image expand state
const expanded = ref({})

function toggleExpand(id) {
  if (expanded.value[id]) delete expanded.value[id]
  else expanded.value[id] = true
}

// Per-GCP expand state
const gcpExpanded = ref({})

function toggleGcpExpand(id) {
  if (gcpExpanded.value[id]) delete gcpExpanded.value[id]
  else gcpExpanded.value[id] = true
}

// Compact coordinate formatting (projected metres vs. lat/lon degrees).
function fmtCoord(v) {
  if (v == null || Number.isNaN(v)) return '—'
  return Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(6)
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

// ── Image context menu ──────────────────────────────────────────────────────────
const ctxMenu = ref(null) // { x, y, img }

// The set of images the context menu should act on:
// multi if right-clicking within an existing multi-selection, else just the one image.
const ctxTargets = computed(() => {
  if (!ctxMenu.value) return []
  const { img } = ctxMenu.value
  if (localSelected.value.length > 1 && localSelected.value.includes(img.id))
    return props.images.filter((i) => localSelected.value.includes(i.id))
  return [img]
})

const ctxIsMulti    = computed(() => ctxTargets.value.length > 1)
const ctxHasKp      = computed(() => ctxTargets.value.some((i) => i.kpStatus === 'done'))
// Can we point at this image on the map? True if it has a pose or an EXIF GPS fix.
const ctxHasPosition = computed(() => {
  const img = ctxMenu.value?.img
  return !!img && (!!poseFor(img) || (img.meta?.gpsLat != null && img.meta?.gpsLon != null))
})

function onRightClick(e, img) {
  e.preventDefault()
  sensorCtx.value = null
  cloudCtx.value = null
  // Right-clicking outside the current selection collapses to that single image
  if (!localSelected.value.includes(img.id)) {
    localSelected.value = [img.id]
    anchor.value = img.id
    suppressWatch = true
    emit('select', img.id)
  }
  const menuW = 200, menuH = 248
  ctxMenu.value = {
    x: Math.min(e.clientX, window.innerWidth - menuW),
    y: Math.min(e.clientY, window.innerHeight - menuH),
    img,
  }
}

function ctxOpen()     { emit('open', ctxMenu.value.img.id); closeMenus() }
function ctxInfo()     { emit('show-info', ctxMenu.value.img.id); closeMenus() }
function ctxZoom()     { emit('zoom-to-image', ctxMenu.value.img.id); closeMenus() }
function ctxDeleteKp() {
  ctxTargets.value.forEach((img) => {
    if (img.kpStatus === 'done') emit('delete-keypoints', img.id)
  })
  closeMenus()
}
function ctxRemove() {
  // Emit the whole target set at once so the parent can confirm a batch delete
  // with a single prompt.
  emit('remove-image', ctxTargets.value.map((img) => img.id))
  closeMenus()
}
function ctxAssignSensor(sensorId) {
  ctxTargets.value.forEach((img) => emit('assign-sensor', { imageId: img.id, sensorId }))
  closeMenus()
}

// ── Sensor context menu ───────────────────────────────────────────────────────────
const sensorCtx = ref(null) // { x, y, sensor }

// Other sensors a right-clicked sensor can be merged into.
const mergeTargets = computed(() =>
  sensorCtx.value ? props.sensors.filter((s) => s.id !== sensorCtx.value.sensor.id) : []
)

function onSensorRightClick(e, sensor) {
  e.preventDefault()
  ctxMenu.value = null
  cloudCtx.value = null
  const menuW = 200, menuH = 160
  sensorCtx.value = {
    x: Math.min(e.clientX, window.innerWidth - menuW),
    y: Math.min(e.clientY, window.innerHeight - menuH),
    sensor,
  }
}

function ctxRemoveSensor() { emit('remove-sensor', sensorCtx.value.sensor.id); closeMenus() }
function ctxMergeSensor(targetId) {
  emit('merge-sensors', { target: targetId, source: sensorCtx.value.sensor.id })
  closeMenus()
}

function closeMenus() {
  ctxMenu.value = null
  sensorCtx.value = null
  cloudCtx.value = null
}

onMounted(() => document.addEventListener('click', closeMenus))
onBeforeUnmount(() => document.removeEventListener('click', closeMenus))
</script>

<template>
  <aside
    class="sidebar"
    :class="{ dragging: isDragging }"
    @dragover.prevent
    @dragenter="onDragEnter"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Drop overlay -->
    <div v-if="isDragging" class="drop-overlay">Drop images or a GCP file</div>

    <!-- Images -->
    <div class="section">
      <button class="section-hd" @click="toggle('images')">
        <span class="chevron">{{ open.images ? '▾' : '▸' }}</span>
        <span class="section-name">Images</span>
        <span v-if="images.length" class="badge">{{ images.length }}</span>
      </button>
      <ul v-if="open.images" class="item-list">
        <template v-for="img in images" :key="img.id">
          <li
            class="list-item"
            :class="{ selected: localSelected.includes(img.id), unaligned: isUnaligned(img) }"
            :title="isUnaligned(img) ? `${img.name} — not aligned (no camera in the sparse model)` : img.name"
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
            <span v-if="img.kpStatus === 'running'" class="status-dot running"></span>
            <span v-else-if="img.kpStatus === 'error'" class="status-dot error"></span>
            <span class="item-name">{{ img.name }}</span>
            <span v-if="isUnaligned(img)" class="unaligned-tag" title="Not aligned — no camera in the sparse model">⚠</span>
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
            <div v-if="hasSparse" class="detail-row">
              <span class="detail-label">Registered</span>
              <span class="detail-value" :class="{ 'detail-error': isUnaligned(img) }">{{ isUnaligned(img) ? 'no' : 'yes' }}</span>
            </div>
          </li>
        </template>
        <li v-if="!images.length" class="empty">No images — drop here to add</li>
      </ul>
    </div>

    <!-- Sensors (shared camera intrinsics) -->
    <div class="section">
      <button class="section-hd" @click="toggle('sensors')">
        <span class="chevron">{{ open.sensors ? '▾' : '▸' }}</span>
        <span class="section-name">Sensors</span>
        <span v-if="sensors.length" class="badge">{{ sensors.length }}</span>
      </button>
      <ul v-if="open.sensors" class="item-list">
        <template v-for="sensor in sensors" :key="sensor.id">
          <li
            class="list-item"
            :title="sensor.label"
            @click="toggleSensorExpand(sensor.id)"
            @contextmenu="onSensorRightClick($event, sensor)"
          >
            <button
              class="expand-btn"
              :class="{ open: sensorExpanded[sensor.id] }"
              @click.stop="toggleSensorExpand(sensor.id)"
              :title="sensorExpanded[sensor.id] ? 'Collapse' : 'Expand'"
            ></button>
            <span class="item-name">{{ sensor.label }}</span>
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
    </div>

    <!-- Matches (pairwise feature correspondences; the full list lives in a modal) -->
    <div class="section">
      <button class="section-hd" @click="toggle('matches')">
        <span class="chevron">{{ open.matches ? '▾' : '▸' }}</span>
        <span class="section-name">Matches</span>
        <span v-if="matchStats.running" class="status-dot running"></span>
        <span v-else-if="matchStats.verified" class="badge">{{ matchStats.verified }}</span>
      </button>
      <ul v-if="open.matches" class="item-list">
        <template v-if="matchStats.total">
          <li
            class="list-item"
            title="Double-click to open the match list"
            @click="matchesExpanded = !matchesExpanded"
            @dblclick="emit('open-matches')"
          >
            <button
              class="expand-btn"
              :class="{ open: matchesExpanded }"
              @click.stop="matchesExpanded = !matchesExpanded"
              :title="matchesExpanded ? 'Collapse' : 'Expand'"
            ></button>
            <span class="item-name">Verified pairs</span>
            <span class="obs-badge" :title="`${matchStats.verified} of ${matchStats.total} pair(s)`">{{ matchStats.verified }}</span>
          </li>
          <li v-if="matchesExpanded" class="img-details">
            <div class="detail-row">
              <span class="detail-label">Verified</span>
              <span class="detail-value">{{ matchStats.verified.toLocaleString() }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Total pairs</span>
              <span class="detail-value">{{ matchStats.total.toLocaleString() }}</span>
            </div>
            <div v-if="matchStats.used != null" class="detail-row">
              <span class="detail-label">Used in model</span>
              <span class="detail-value">{{ matchStats.used.toLocaleString() }}</span>
            </div>
            <div v-if="matchStats.disabled" class="detail-row">
              <span class="detail-label">Excluded</span>
              <span class="detail-value">{{ matchStats.disabled.toLocaleString() }}</span>
            </div>
            <div v-if="matchStats.error" class="detail-row">
              <span class="detail-label">Failed</span>
              <span class="detail-value detail-error">{{ matchStats.error }}</span>
            </div>
            <button class="link-btn matches-view" @click.stop="emit('open-matches')">View match list</button>
          </li>
        </template>
        <li v-else-if="matchStats.running" class="empty">Matching…</li>
        <li v-else class="empty">No matches — run matching</li>
      </ul>
    </div>

    <!-- Ground Control Points -->
    <div class="section">
      <button class="section-hd" @click="toggle('gcps')">
        <span class="chevron">{{ open.gcps ? '▾' : '▸' }}</span>
        <span class="section-name">Ground Control Points</span>
        <span v-if="gcps.length" class="badge">{{ gcps.length }}</span>
      </button>
      <ul v-if="open.gcps" class="item-list">
        <template v-for="gcp in gcps" :key="gcp.id">
          <li
            class="list-item"
            :title="gcp.name"
            @click="toggleGcpExpand(gcp.id)"
          >
            <button
              class="expand-btn"
              :class="{ open: gcpExpanded[gcp.id] }"
              @click.stop="toggleGcpExpand(gcp.id)"
              :title="gcpExpanded[gcp.id] ? 'Collapse' : 'Expand'"
            ></button>
            <span class="item-name">{{ gcp.name }}</span>
            <span v-if="gcp.observations?.length" class="obs-badge" :title="`${gcp.observations.length} observation(s)`">
              {{ gcp.observations.length }}
            </span>
          </li>
          <li v-if="gcpExpanded[gcp.id]" class="img-details">
            <div class="detail-row">
              <span class="detail-label">X</span>
              <span class="detail-value">{{ fmtCoord(gcp.x) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Y</span>
              <span class="detail-value">{{ fmtCoord(gcp.y) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Z</span>
              <span class="detail-value">
                <template v-if="gcp.z != null">{{ fmtCoord(gcp.z) }}</template>
                <span v-else class="detail-dim">—</span>
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Observations</span>
              <span class="detail-value">{{ gcp.observations?.length || 0 }}</span>
            </div>
            <button class="gcp-remove" @click.stop="emit('remove-gcp', gcp.id)">Remove</button>
          </li>
        </template>
        <li v-if="!gcps.length" class="empty">No GCPs — import a control-point file</li>
      </ul>
    </div>

    <!-- Point clouds (sparse / dense models: camera poses + 3D points) -->
    <div class="section">
      <button class="section-hd" @click="toggle('clouds')">
        <span class="chevron">{{ open.clouds ? '▾' : '▸' }}</span>
        <span class="section-name">Point Clouds</span>
        <span v-if="reconStatus === 'running'" class="status-dot running"></span>
        <span v-else-if="reconStatus === 'error'" class="status-dot error"></span>
        <span v-else-if="clouds.length" class="badge">{{ clouds.length }}</span>
      </button>
      <ul v-if="open.clouds" class="item-list">
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
    </div>

    <!-- Products (rasters: DEM + orthophoto) -->
    <div class="section">
      <button class="section-hd" @click="toggle('products')">
        <span class="chevron">{{ open.products ? '▾' : '▸' }}</span>
        <span class="section-name">Products</span>
        <span v-if="productRows.length" class="badge">{{ productRows.length }}</span>
      </button>
      <ul v-if="open.products" class="item-list">
        <template v-for="row in productRows" :key="row.kind">
          <li
            class="list-item"
            :title="`${row.name} — double-click to open`"
            @dblclick="emit('open-product', row.kind)"
          >
            <button
              class="expand-btn"
              :class="{ open: productExpanded[row.kind] }"
              @click.stop="toggleProductExpand(row.kind)"
              :title="productExpanded[row.kind] ? 'Collapse' : 'Expand'"
            ></button>
            <span class="item-name">{{ row.name }}</span>
            <span class="obs-badge" :title="`${row.product.width}×${row.product.height} px`">
              {{ row.product.width }}×{{ row.product.height }}
            </span>
          </li>
          <li v-if="productExpanded[row.kind]" class="img-details">
            <div class="detail-row">
              <span class="detail-label">Frame</span>
              <span class="detail-value">{{ productCrs(dem || row.product) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Size</span>
              <span class="detail-value">{{ row.product.width }} × {{ row.product.height }} px</span>
            </div>
            <template v-if="row.kind === 'dem'">
              <div class="detail-row">
                <span class="detail-label">GSD</span>
                <span class="detail-value">{{ row.product.gsd?.toPrecision(3) }} {{ productUnit(row.product) }}/px</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Elevation</span>
                <span class="detail-value">{{ row.product.zMin?.toPrecision(4) }}–{{ row.product.zMax?.toPrecision(4) }}</span>
              </div>
            </template>
            <div v-else-if="row.product.covered != null" class="detail-row">
              <span class="detail-label">Coverage</span>
              <span class="detail-value">{{ Math.round(100 * row.product.covered / (row.product.width * row.product.height)) }}%</span>
            </div>
            <button class="link-btn products-open" @click.stop="emit('open-product', row.kind)">Open in tab</button>
          </li>
        </template>
        <li v-if="!productRows.length" class="empty">No products — build a DEM or orthophoto</li>
      </ul>
    </div>

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
        <template v-if="sensors.length">
          <div class="ctx-sep"></div>
          <div class="ctx-sub-wrap">
            <button class="ctx-item ctx-has-sub">Assign sensor<span class="ctx-arrow">▸</span></button>
            <div class="ctx-submenu">
              <button class="ctx-item" @click="ctxAssignSensor(null)">None</button>
              <div class="ctx-sep"></div>
              <button v-for="s in sensors" :key="s.id" class="ctx-item" @click="ctxAssignSensor(s.id)">{{ s.label }}</button>
            </div>
          </div>
        </template>
        <template v-if="ctxHasKp">
          <div class="ctx-sep"></div>
          <button class="ctx-item" @click="ctxDeleteKp">Delete keypoints</button>
        </template>
        <div class="ctx-sep"></div>
        <button class="ctx-item danger" @click="ctxRemove">Remove</button>
      </div>
    </Teleport>

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
  </aside>
</template>

<style scoped>
.sidebar {
  width: 220px;
  flex-shrink: 0;
  height: 100%;
  background: var(--panel);
  border-right: 1px solid var(--panel-border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  position: relative;
}

/* Drop overlay */
.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: none;
  background: rgba(14, 99, 156, 0.12);
  border: 2px dashed var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
}

/* Sections */
.section {
  border-bottom: 1px solid var(--panel-border);
}

.section-hd {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  color: var(--text-dim);
  font: inherit;
}

.section-hd:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.chevron {
  font-size: 10px;
  width: 10px;
  flex-shrink: 0;
}

.section-name {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  flex: 1;
}

.badge {
  font-size: 11px;
  color: var(--text-dim);
  background: var(--hover-bg);
  padding: 1px 6px;
  border-radius: 8px;
}

.placeholder {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--text-dim);
  font-style: italic;
}

/* Image list */
.item-list {
  list-style: none;
  padding: 2px 0 6px;
  user-select: none;
}

.list-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 12px;
  cursor: pointer;
  font-size: 12px;
  height: 24px;
}

.list-item:hover {
  background: var(--hover-bg);
}

.list-item.selected {
  background: rgba(14, 99, 156, 0.25);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.error   { background: #e55; }
.status-dot.running { background: #fa0; animation: pulse 0.9s ease-in-out infinite; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.35; }
}

.item-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}

/* Image not registered into the sparse model — dim it and flag with a warning tag. */
.list-item.unaligned .item-name { color: var(--text-dim); opacity: 0.65; }

.unaligned-tag {
  flex-shrink: 0;
  font-size: 11px;
  color: #d4900a;
  line-height: 1;
}

/* Inline rename field (point cloud rows) */
.rename-input {
  flex: 1;
  min-width: 0;
  padding: 1px 4px;
  background: var(--panel);
  border: 1px solid var(--accent);
  border-radius: 3px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
}

.rename-input:focus { outline: none; }

.empty {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-dim);
  font-style: italic;
}

/* Inline "run reconstruction" action in the empty Point Clouds state */
.link-btn {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-style: italic;
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
}

/* "View match list" action inside the Matches detail card */
.matches-view {
  display: block;
  margin: 6px 0 2px;
  font-size: 11px;
}

/* "Open in tab" action inside a Product detail card */
.products-open {
  display: block;
  margin: 6px 0 2px;
  font-size: 11px;
}

/* Per-image expand toggle */
.expand-btn {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
}

.expand-btn::before {
  content: '';
  display: block;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 5px 0 5px 8px;
  border-color: transparent transparent transparent currentColor;
  transition: transform 0.15s;
}

.expand-btn:hover { color: var(--text); }
.expand-btn.open::before { transform: rotate(90deg); }

/* Image detail panel — white card with dotted left connector */
.img-details {
  background: #fff;
  border-left: 1.5px dotted #bbb;
  margin: 0 8px 4px 19px;
  border-radius: 0 4px 4px 0;
  padding: 4px 8px 4px 10px;
}

.detail-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  line-height: 1.8;
}

.detail-label { color: #777; }

.detail-value {
  color: #222;
  font-variant-numeric: tabular-nums;
}

.detail-dim   { color: #aaa; }
.detail-error { color: #c33; }

/* GCP observation count pill */
.obs-badge {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-dim);
  background: var(--hover-bg);
  padding: 0 6px;
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
}

/* GCP remove button (inside the detail panel) */
.gcp-remove {
  display: block;
  margin: 6px 0 2px;
  padding: 3px 8px;
  background: none;
  border: 1px solid #ddd;
  border-radius: 4px;
  color: #c33;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.gcp-remove:hover {
  background: rgba(220, 80, 80, 0.1);
  border-color: #c33;
}

/* Context menu */
.ctx-menu {
  position: fixed;
  z-index: 300;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 4px;
  min-width: 165px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}

.ctx-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.ctx-item:hover {
  background: var(--hover-bg);
}

.ctx-item.danger       { color: #e55; }
.ctx-item.danger:hover { background: rgba(220, 80, 80, 0.12); }

.ctx-disabled {
  opacity: 0.35;
  cursor: default;
  pointer-events: none;
}

.ctx-sep {
  height: 1px;
  background: var(--panel-border);
  margin: 4px 0;
}

/* Submenu (hover-reveal) */
.ctx-sub-wrap { position: relative; }

.ctx-has-sub { display: flex; align-items: center; justify-content: space-between; }
.ctx-arrow { color: var(--text-dim); font-size: 10px; margin-left: 10px; }

.ctx-submenu {
  position: absolute;
  left: 100%;
  top: -4px;
  margin-left: 2px;
  display: none;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 4px;
  min-width: 150px;
  max-height: 280px;
  overflow-y: auto;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}

.ctx-sub-wrap:hover > .ctx-submenu { display: block; }
.ctx-sub-wrap:hover > .ctx-has-sub { background: var(--hover-bg); }
</style>
