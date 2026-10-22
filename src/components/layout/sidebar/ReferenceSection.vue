<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useExternalStore } from '../../../stores/useExternalStore.js'
import { useFootprintsStore } from '../../../stores/useFootprintsStore.js'
import { vectorSection } from '../../../core/products/vectorLayers.js'
import CloudRows from './CloudRows.vue'
import VectorRows from './VectorRows.vue'
import { useContextMenu } from '../../../composables/useContextMenu.js'
import { useExpandedSet } from '../../../composables/useExpandedSet.js'
import { useInlineRename } from '../../../composables/useInlineRename.js'
import ContextMenu from './ContextMenu.vue'
import { useSidebar } from './sidebarContext.js'

// Evidence you brought in: imported dense/mesh clouds, imported georeferenced
// rasters (reference DEM / orthophoto) and imported polygon files. The pipeline never overwrites anything
// in here — that's the whole point of the section, and it's the one thing the
// old type-split "Clouds vs Products" taxonomy could not express.
const props = defineProps({
  open: { type: Boolean, default: true },
  // Imported (imported:true) kind:'dense' | 'mesh' clouds.
  clouds: { type: Array, default: () => [] },
})
const emit = defineEmits(['toggle'])
const sidebar = useSidebar()
// External rasters (metadata only — the pixel plane is loaded lazily, so a row
// renders long before any plane is in memory).
const { rasters, pendingRasters } = storeToRefs(useExternalStore())
const { sets: vectorSets } = storeToRefs(useFootprintsStore())
const polygonSets = computed(() => vectorSets.value.filter((s) => vectorSection(s) === 'reference'))
const itemCount = computed(
  () => props.clouds.length + rasters.value.length + pendingRasters.value.length + polygonSets.value.length,
)

const { isExpanded: isRasterExpanded, toggle: toggleRasterExpand } = useExpandedSet()

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
// Why a raster cannot go on the map (its map checkbox's tooltip); its own tab still opens.
const mapBlocker = (r) =>
  !r.crs
    ? 'No coordinate system: the map cannot place it (double-click opens it in its own tab)'
    : r.crsUnresolved
      ? `Its coordinate system (${r.crs}) could not be resolved`
      : !r.previewDataUrl
        ? 'No preview image yet'
        : ''

const {
  editingId: editingRasterId,
  editingName,
  setInput: setRenameInput,
  start: startRename,
  commit: commitRename,
  cancel: cancelRename,
} = useInlineRename((id, name) => sidebar.renameRaster({ id, name }))

const { menu: ctx, open: openCtx, close: closeCtx } = useContextMenu()
// Run a menu item against the row it was opened on, then close.
function fromMenu(fn) {
  const raster = ctx.value.raster
  closeCtx()
  fn(raster)
}

// Tab id per useTabs.openRasterTab — openRaster focuses an existing tab either
// way, so only the wording changes.
const ctxOpenLabel = computed(() =>
  sidebar.openTabIds.has(`raster:${ctx.value?.raster?.id}`) ? 'Switch to tab' : 'Open in tab',
)
</script>

<template>
  <div class="section">
    <button class="section-hd" @click="emit('toggle')">
      <span class="chevron">{{ open ? '▾' : '▸' }}</span>
      <span class="section-name">Reference Data</span>
      <span v-if="itemCount" class="badge">{{ itemCount }}</span>
    </button>
    <ul v-if="open" class="item-list">
      <CloudRows :clouds="clouds" />

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
          @dblclick="sidebar.openRaster(r.id)"
          @contextmenu="openCtx($event, { raster: r })"
        >
          <button
            class="expand-btn"
            :class="{ open: isRasterExpanded(r.id) }"
            @click.stop="toggleRasterExpand(r.id)"
            :title="isRasterExpanded(r.id) ? 'Collapse' : 'Expand'"
          ></button>
          <input
            class="map-visibility"
            type="checkbox"
            :checked="!!r.visible"
            :disabled="!canMap(r) && !r.visible"
            :aria-label="`Show ${r.name} on the map`"
            :title="canMap(r) ? 'Shown on the 2D map' : mapBlocker(r)"
            @click.stop
            @change="sidebar.setRasterVisible({ id: r.id, visible: $event.target.checked })"
          />
          <input
            v-if="editingRasterId === r.id"
            :ref="setRenameInput"
            v-model="editingName"
            class="rename-input"
            @click.stop
            @dblclick.stop
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent.stop="cancelRename"
            @blur="commitRename"
          />
          <span v-else class="item-name">{{ r.name }}</span>
          <span
            v-if="datumWarn(r)"
            class="warn-flag"
            title="Vertical datum unknown — elevations may be offset by tens of metres"
            >⚠</span
          >
          <span class="obs-badge" :title="`${r.width}×${r.height} px`">{{ kindLabel(r.kind) }}</span>
        </li>
        <li v-if="isRasterExpanded(r.id)" class="img-details" @contextmenu.stop>
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
          <div v-if="r.horizontalAccuracy != null" class="detail-row">
            <span class="detail-label">σ horizontal</span>
            <span class="detail-value">{{ num(r.horizontalAccuracy, 3) }} m</span>
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
          <div v-if="r.visible" class="detail-row">
            <span class="detail-label">Opacity</span>
            <span class="detail-value opacity-cell">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                :value="r.opacity ?? 1"
                class="opacity-slider"
                @click.stop
                @input="sidebar.setRasterOpacity({ id: r.id, opacity: Number($event.target.value) })"
              />
              <span class="opacity-pct">{{ Math.round((r.opacity ?? 1) * 100) }}%</span>
            </span>
          </div>
          <button class="link-btn products-open" @click.stop="sidebar.openRaster(r.id)">
            {{ sidebar.openTabIds.has(`raster:${r.id}`) ? 'Switch to tab' : 'Open in tab' }}
          </button>
        </li>
      </template>

      <VectorRows :sets="polygonSets" />

      <li v-if="!itemCount" class="empty">
        No reference data — drop a GeoTIFF DEM/ortho, a point cloud or a polygon file
      </li>
    </ul>

    <ContextMenu :menu="ctx">
      <template #default="{ menu }">
        <!-- Groups: get at it / how it's displayed → change what it is →
             destructive. Same order as the Products and cloud menus; the map
             toggle and styling join the first group, so an unstyleable raster
             never leaves "Show on map" alone between two lines. -->
        <button class="ctx-item" @click="fromMenu((r) => sidebar.openRaster(r.id))">{{ ctxOpenLabel }}</button>
        <!-- The file exactly as imported, not a re-encode. -->
        <button class="ctx-item" @click="fromMenu((r) => sidebar.downloadRaster(r.id))">Download original</button>
        <!-- A toggle, not a one-shot "show": which reference layers are up is
             something you adjust continuously while working. -->
        <button
          v-if="canMap(menu.raster)"
          class="ctx-item"
          @click="fromMenu((r) => sidebar.setRasterVisible({ id: r.id, visible: !r.visible }))"
        >
          {{ menu.raster.visible ? 'Hide from map' : 'Show on map' }}
        </button>
        <!-- Only for rasters band math can actually change: >3 bands or deeper
             than 8-bit. An 8-bit RGB ortho has nothing to choose. -->
        <button v-if="menu.raster.styleable" class="ctx-item" @click="fromMenu((r) => sidebar.styleRaster(r.id))">
          Style bands…
        </button>
        <!-- A confident import never asks for these, and Fill Z / GCP picking need them. -->
        <button class="ctx-item" @click="fromMenu((r) => sidebar.rasterAccuracy(r.id))">Accuracy &amp; datum…</button>

        <div class="ctx-sep"></div>
        <!-- The classifier is confident but not infallible (an 8-bit hillshade is
             a DEM by intent and imagery by content). One click beats a
             delete-and-reimport, and it's what makes skipping the modal on a
             high-confidence sniff defensible. -->
        <button
          class="ctx-item"
          @click="fromMenu((r) => sidebar.setRasterKind({ id: r.id, kind: r.kind === 'dem' ? 'ortho' : 'dem' }))"
        >
          Treat as {{ menu.raster.kind === 'dem' ? 'orthophoto' : 'DEM' }}
        </button>
        <!-- The mirror of ImagesSection's "Convert to reference data": the ingest
             geokey sniff called this a raster, but it's really a source photo. -->
        <button
          class="ctx-item"
          title="This is really a source photo — re-import it as an image"
          @click="fromMenu((r) => sidebar.convertRasterToImage(r.id))"
        >
          Convert to source image
        </button>
        <button class="ctx-item" @click="fromMenu((r) => startRename(r.id, r.name))">Rename</button>

        <div class="ctx-sep"></div>
        <button class="ctx-item danger" @click="fromMenu((r) => sidebar.removeRaster(r.id))">Remove</button>
      </template>
    </ContextMenu>
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
.detail-value.warn {
  color: var(--warn, #d9a441);
}

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
  to {
    transform: rotate(360deg);
  }
}
</style>
