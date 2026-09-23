<script setup>
import { ref, computed, nextTick } from 'vue'
import CloudRows from './CloudRows.vue'
import { useContextMenu } from '../../../composables/useContextMenu.js'

// Evidence you brought in: imported dense/mesh clouds and imported georeferenced
// rasters (reference DEM / orthophoto). The pipeline never overwrites anything
// in here — that's the whole point of the section, and it's the one thing the
// old type-split "Clouds vs Products" taxonomy could not express.
const props = defineProps({
  open:   { type: Boolean, default: true },
  // Imported (imported:true) kind:'dense' | 'mesh' clouds.
  clouds: { type: Array, default: () => [] },
  selectedCloudId: { type: String, default: null },
  // External rasters from useExternalStore (metadata only — the pixel plane is
  // loaded lazily, so a row renders long before any plane is in memory).
  rasters: { type: Array, default: () => [] },
  pendingRasters: { type: Array, default: () => [] },
  openTabIds: { type: Object, default: () => new Set() },
})
const emit = defineEmits([
  'toggle', 'cloud-symbology', 'cloud-visibility', 'select-cloud', 'remove-cloud', 'rename-cloud', 'zoom-to-cloud',
  'open-raster', 'remove-raster', 'rename-raster', 'set-raster-kind', 'style-raster',
  'set-raster-on-map', 'set-raster-opacity', 'convert-to-image',
])

const rasterExpanded = ref({})
function toggleRasterExpand(id) {
  if (rasterExpanded.value[id]) delete rasterExpanded.value[id]
  else rasterExpanded.value[id] = true
}

const kindLabel = (k) => (k === 'dem' ? 'DEM' : 'Ortho')
const num = (v, d = 3) => (Number.isFinite(v) ? v.toPrecision(d) : '—')

// A raster whose vertical datum we could not determine is a standing hazard in
// polar work (ellipsoid-vs-geoid runs tens of metres in Antarctica), so the
// warning lives on the row itself, not only in the report that consumes it.
const datumWarn = (r) => r.kind === 'dem' && (!r.verticalDatum || r.verticalDatum === 'unknown')

// A raster with no preview PNG can't be drawn on the map (the layer renders the
// preview, never the lazily-loaded plane — see useExternalStore.mapRasters), so
// the toggle is hidden rather than offered and silently doing nothing.
const canMap = (r) => !!r.previewDataUrl && !!r.crs && !r.crsUnresolved

const editingRasterId = ref(null)
const editingName = ref('')
const renameInput = ref(null)
function setRenameInput(el) { if (el) renameInput.value = el }
function startRename(raster) {
  editingRasterId.value = raster.id
  editingName.value = raster.name
  nextTick(() => { renameInput.value?.focus(); renameInput.value?.select() })
}
function commitRename() {
  if (editingRasterId.value == null) return
  emit('rename-raster', { id: editingRasterId.value, name: editingName.value })
  editingRasterId.value = null
}
function cancelRename() { editingRasterId.value = null }

const { menu: ctx, open: openCtx, close: closeCtx } = useContextMenu()
function onRasterRightClick(e, raster) {
  openCtx(e, { raster }, { w: 200, h: canMap(raster) ? 248 : 220 })
}

// Tab id per useTabs.openRasterTab — the emit focuses an existing tab either way,
// so only the wording changes.
const ctxOpenLabel = computed(() =>
  props.openTabIds.has(`raster:${ctx.value?.raster?.id}`) ? 'Switch to tab' : 'Open in tab')

function ctxOpen()     { emit('open-raster', ctx.value.raster.id); closeCtx() }
function ctxToggleMap() {
  const r = ctx.value.raster
  emit('set-raster-on-map', { id: r.id, onMap: !r.onMap })
  closeCtx()
}
function ctxFlipKind() {
  const r = ctx.value.raster
  emit('set-raster-kind', { id: r.id, kind: r.kind === 'dem' ? 'ortho' : 'dem' })
  closeCtx()
}
function ctxStyle()    { emit('style-raster', ctx.value.raster.id); closeCtx() }
function ctxRename()   { startRename(ctx.value.raster); closeCtx() }
// The mirror of ImagesSection's "Convert to reference data": the ingest geokey
// sniff called this a raster, but it's really a source photo.
function ctxToImage()  { emit('convert-to-image', ctx.value.raster.id); closeCtx() }
function ctxRemove()   { emit('remove-raster', ctx.value.raster.id); closeCtx() }
</script>

<template>
  <div class="section">
    <button class="section-hd" @click="emit('toggle')">
      <span class="chevron">{{ open ? '▾' : '▸' }}</span>
      <span class="section-name">Reference Data</span>
      <span v-if="clouds.length + rasters.length + pendingRasters.length" class="badge">
        {{ clouds.length + rasters.length + pendingRasters.length }}
      </span>
    </button>
    <ul v-if="open" class="item-list">
      <CloudRows
        :clouds="clouds"
        :selected-cloud-id="selectedCloudId"
        @select-cloud="emit('select-cloud', $event)"
        @cloud-symbology="emit('cloud-symbology', $event)"
        @cloud-visibility="emit('cloud-visibility', $event)"
        @remove-cloud="emit('remove-cloud', $event)"
        @rename-cloud="emit('rename-cloud', $event)"
        @zoom-to-cloud="emit('zoom-to-cloud', $event)"
      />

      <li
        v-for="r in pendingRasters"
        :key="r.id"
        class="list-item loading raster-loading"
        :title="`${r.name} — reading and classifying GeoTIFF`"
        aria-busy="true"
      >
        <span class="raster-spinner" aria-hidden="true"></span>
        <span class="item-name">{{ r.name }}</span>
        <span class="load-tag">Reading…</span>
      </li>

      <template v-for="r in rasters" :key="r.id">
        <li
          class="list-item"
          :title="`${r.name} — double-click to open`"
          @dblclick="emit('open-raster', r.id)"
          @contextmenu="onRasterRightClick($event, r)"
        >
          <button
            class="expand-btn"
            :class="{ open: rasterExpanded[r.id] }"
            @click.stop="toggleRasterExpand(r.id)"
            :title="rasterExpanded[r.id] ? 'Collapse' : 'Expand'"
          ></button>
          <input
            v-if="editingRasterId === r.id"
            :ref="setRenameInput"
            v-model="editingName"
            class="rename-input"
            @click.stop
            @dblclick.stop
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename"
          />
          <span v-else class="item-name">{{ r.name }}</span>
          <!-- On-map indicator: the toggle lives in the right-click menu, so
               without this the state is invisible until you open the menu again. -->
          <span
            v-if="r.onMap"
            class="map-flag"
            title="Shown on the map — right-click to hide"
          >◉</span>
          <span v-if="datumWarn(r)" class="warn-flag" title="Vertical datum unknown — elevations may be offset by tens of metres">⚠</span>
          <span class="obs-badge" :title="`${r.width}×${r.height} px`">{{ kindLabel(r.kind) }}</span>
        </li>
        <li v-if="rasterExpanded[r.id]" class="img-details" @contextmenu.stop>
          <div class="detail-row">
            <span class="detail-label">Type</span>
            <span class="detail-value">{{ kindLabel(r.kind) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">CRS</span>
            <span class="detail-value">{{ r.crs || 'unknown' }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Size</span>
            <span class="detail-value">{{ r.width }} × {{ r.height }} px</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">GSD</span>
            <span class="detail-value">{{ num(Math.abs(r.geoTransform?.scaleX)) }} /px</span>
          </div>
          <template v-if="r.kind === 'dem'">
            <div class="detail-row">
              <span class="detail-label">Elevation</span>
              <span class="detail-value">{{ num(r.zMin, 4) }}–{{ num(r.zMax, 4) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Vertical</span>
              <span class="detail-value" :class="{ warn: datumWarn(r) }">{{ r.verticalDatum || 'unknown' }}</span>
            </div>
            <div v-if="r.verticalAccuracy != null" class="detail-row">
              <span class="detail-label">σ vertical</span>
              <span class="detail-value">{{ num(r.verticalAccuracy, 3) }}</span>
            </div>
          </template>
          <!-- Opacity only matters while the layer is up, and an always-present
               slider that does nothing invites fiddling with it to find out why. -->
          <div v-if="r.onMap" class="detail-row">
            <span class="detail-label">Opacity</span>
            <span class="detail-value opacity-cell">
              <input
                type="range" min="0" max="1" step="0.05"
                :value="r.opacity ?? 1"
                class="opacity-slider"
                @click.stop
                @input="emit('set-raster-opacity', { id: r.id, opacity: Number($event.target.value) })"
              />
              <span class="opacity-pct">{{ Math.round((r.opacity ?? 1) * 100) }}%</span>
            </span>
          </div>
          <button class="link-btn products-open" @click.stop="emit('open-raster', r.id)">
            {{ openTabIds.has(`raster:${r.id}`) ? 'Switch to tab' : 'Open in tab' }}
          </button>
        </li>
      </template>

      <li v-if="!clouds.length && !rasters.length && !pendingRasters.length" class="empty">
        No reference data — drop a GeoTIFF DEM/ortho or a point cloud
      </li>
    </ul>

    <Teleport to="body">
      <div
        v-if="ctx"
        class="ctx-menu"
        :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
        @click.stop
      >
        <!-- Groups: go there → change how it's displayed → change what it is →
             destructive. Same order as the image menu. -->
        <button class="ctx-item" @click="ctxOpen">{{ ctxOpenLabel }}</button>
        <!-- A toggle, not a one-shot "show": which reference layers are up is
             something you adjust continuously while working. -->
        <template v-if="canMap(ctx.raster) || ctx.raster.styleable">
          <div class="ctx-sep"></div>
          <button v-if="canMap(ctx.raster)" class="ctx-item" @click="ctxToggleMap">
            {{ ctx.raster.onMap ? 'Hide from map' : 'Display on map' }}
          </button>
          <!-- Only for rasters band math can actually change: >3 bands or deeper
               than 8-bit. An 8-bit RGB ortho has nothing to choose. -->
          <button v-if="ctx.raster.styleable" class="ctx-item" @click="ctxStyle">
            Style bands…
          </button>
        </template>

        <div class="ctx-sep"></div>
        <!-- The classifier is confident but not infallible (an 8-bit hillshade is
             a DEM by intent and imagery by content). One click beats a
             delete-and-reimport, and it's what makes skipping the modal on a
             high-confidence sniff defensible. -->
        <button class="ctx-item" @click="ctxFlipKind">
          Treat as {{ ctx.raster.kind === 'dem' ? 'orthophoto' : 'DEM' }}
        </button>
        <button
          class="ctx-item"
          title="This is really a source photo — re-import it as an image"
          @click="ctxToImage"
        >Convert to source image</button>
        <button class="ctx-item" @click="ctxRename">Rename</button>

        <div class="ctx-sep"></div>
        <button class="ctx-item danger" @click="ctxRemove">Remove</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
<style scoped>
.warn-flag {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 15px;
  color: var(--warn, #d9a441);
}
.detail-value.warn { color: var(--warn, #d9a441); }

.raster-loading {
  cursor: default;
  pointer-events: none;
  opacity: 0.7;
}

.raster-spinner {
  box-sizing: border-box;
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
  border: 2px solid color-mix(in srgb, var(--text-dim) 30%, transparent);
  border-top-color: var(--text-dim);
  border-radius: 50%;
  animation: raster-spin 0.8s linear infinite;
}

@keyframes raster-spin {
  to { transform: rotate(360deg); }
}

/* On-map indicator — accent-coloured so it reads as "active", not as a warning. */
.map-flag {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 15px;
  color: var(--accent, #4a9eff);
}

.opacity-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.opacity-slider {
  flex: 1;
  min-width: 60px;
  accent-color: var(--accent, #4a9eff);
  cursor: pointer;
}

.opacity-pct {
  flex-shrink: 0;
  min-width: 30px;          /* keeps the row from reflowing as the value changes */
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
