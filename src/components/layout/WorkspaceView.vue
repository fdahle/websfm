<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useExternalStore } from '../../stores/useExternalStore.js'
import { useFootprintsStore } from '../../stores/useFootprintsStore.js'
import { useGcpsStore } from '../../stores/useGcpsStore.js'
import { useImagesStore } from '../../stores/useImagesStore.js'
import { usePosesStore } from '../../stores/usePosesStore.js'
import { useProjectsStore } from '../../stores/useProjectsStore.js'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'
import { useSensorsStore } from '../../stores/useSensorsStore.js'
import { useImageViewSettings } from '../../composables/useImageViewSettings.js'
import { useTabDrag } from '../../composables/useTabDrag.js'
import { useTheme } from '../../composables/useTheme.js'
import { imageResidualVectors } from '../../core/eval/imageStats.js'
import { normalizeOrientation } from '../../core/products/orientation.js'
import { makeCanonicalToScan, makeFrameModelResolver } from '../../core/sfm/displayFrame.js'
import { estimateUpFromCameras } from '../../core/sfm/geometry.js'
import { useAppContext } from '../../appContext.js'
import ViewerImage from '../viewers/ViewerImage.vue'
import ViewerGcp from '../viewers/ViewerGcp.vue'
import RegionToolbox from '../viewers/RegionToolbox.vue'
import OrientToolbox from '../viewers/OrientToolbox.vue'
import AlignPairsToolbox from '../viewers/AlignPairsToolbox.vue'
import { matches } from '../../core/help/shortcuts.js'
const ProductViewer = defineAsyncComponent(() => import('../viewers/ProductViewer.vue'))
const ViewerMap = defineAsyncComponent(() => import('../viewers/ViewerMap.vue'))
const Viewer3D = defineAsyncComponent(() => import('../viewers/Viewer3D.vue'))

// The workspace, lifted out of App.vue: the tab strip and the viewer behind each
// tab — the 3D view with its tool toolboxes, the map, image, GCP and raster
// viewers. App owns the viewer refs (the command dispatch drives the viewers
// through them); this sets them as the viewers mount.
const imagesStore = useImagesStore()
const { images, selectedId } = storeToRefs(imagesStore)
const { imageById, selectImage, updateMask, updateDepth } = imagesStore
const { gcps } = storeToRefs(useGcpsStore())
const { poses } = storeToRefs(usePosesStore())
const { sensors } = storeToRefs(useSensorsStore())
const { footprintPolygons: mapFootprints } = storeToRefs(useFootprintsStore())
const { currentCrs, currentSceneType } = storeToRefs(useProjectsStore())
const reconstructionStore = useReconstructionStore()
const { clouds, sparseCameras, georef } = storeToRefs(reconstructionStore)
const externalStore = useExternalStore()
const { sources: rasterSources } = storeToRefs(externalStore)
const { rasterById, ensureRasterLoaded } = externalStore
const { theme } = useTheme()
const { imageViewPrefs, patchImageView, showKeypointsFor } = useImageViewSettings()
const {
  tabs,
  activeTabId,
  activeTab,
  activateTab,
  moveTab,
  openImageTab,
  closeTab,
  closeAllTabs,
  closeOtherTabs,
  closeTabsToLeft,
  closeTabsToRight,
  viewerRef,
  mapViewerRef,
  imageViewerRefs,
  productViewerRefs,
  handleCommand,
  showCameras,
  showGrid,
  showLegend,
  showFootprints,
  showMapGrid,
  showMapCameras,
  showMapGcps,
  mapLayersPanel,
  selectTool3d,
  turntable3d,
  mapGcpEdit,
  mapLayers,
  probeMapLayersAt,
  mapFrame,
  modelCameras,
  modelMarkers,
  mapMeasureTarget,
  mapNotes,
  alignedUuids,
  hasSparse,
  editableClouds,
  onEditSelection,
  regionEdit,
  regionDraft,
  fitRegionDraft,
  applyRegion,
  removeRegion,
  orientEdit,
  orientDraft,
  orientPicking,
  orientPlanePicks,
  applyOrientation,
  removeOrientation,
  toggleOrientPick,
  orientAutoUp,
  orientCentreOrigin,
  setOrientHeading,
  alignPairs,
  alignReferences,
  applyAlignPairs,
  viewerPickMode,
  onViewerPick,
  viewerMarkers,
  viewerRegionBox,
  viewerRegionStale,
  gcpReport,
  selectedGcpId,
  selectGcp,
  jumpToImage,
  exitGcpEdit,
  setGcpGroundPosition,
  addGcpAtCoord,
  pickGcpFromReference,
  assignGcpObservation,
  addGcpAtObservation,
  activeImageGcps,
  activeImageGcpGuides,
  allGcpsBrief,
  confirmRemoveGcp,
  confirmRemoveGcpObservation,
  sensorForImage,
  fiducialDisplayForImage,
  markDisplayedFiducial,
} = useAppContext()

const setViewer = (el) => {
  viewerRef.value = el
}
const setMapViewer = (el) => {
  mapViewerRef.value = el
}

// The map is a large OpenLayers subtree. Mount it on first use, then retain it so
// pan/zoom/layer state survives subsequent tab switches.
const mapMounted = ref(activeTabId.value === 'map')
watch(activeTabId, (id) => {
  if (id === 'map') mapMounted.value = true
})

// ── Tab drag-reorder + context menu ─────────────────────────────────────────────
const {
  draggedTabId,
  dragOverTabId,
  onTabDragStart,
  onTabDragOver,
  onTabDrop,
  onTabDragEnd,
  tabCtx,
  onTabRightClick,
  closeTabCtx,
  tabCtxHasLeft,
  tabCtxHasRight,
  tabCtxHasOthers,
} = useTabDrag({ tabs, moveTab })

// Per-observation reprojection residual vectors for the active image (WS3 overlay).
// Only computed when the overlay is on and the image is registered — otherwise empty.
const activeImageResiduals = computed(() => {
  if (!imageViewPrefs.value.showResiduals) return []
  const tab = activeTab.value
  if (!tab || tab.type !== 'image') return []
  const img = imageById(tab.imageId)
  const cam = img && reconstructionStore.sparseCameras.get(img.uuid)
  if (!cam) return []
  return imageResidualVectors(
    cam,
    reconstructionStore.mainSparseCloud?.points ?? [],
    img.uuid,
    canonicalToScanFor(img, cam),
  )
})

// The residual overlay draws computed (pinhole-frame) pixels on the RAW image, so it
// has to undo what ingest folded out: the distortion bags and, for a film scan, the
// scan→canonical affine. Returns null when the image needs neither — the common
// EXIF-only digital case, where the overlay is already in the right frame.
function canonicalToScanFor(img, cam) {
  const resolve = makeFrameModelResolver({ summary: reconstructionStore.summary, sensors: sensors.value })
  const { dist, selfCal, fiducial } = resolve(img)
  return makeCanonicalToScan({ K: cam.K, dist, selfCal, fiducial })
}

// Estimated scene "up" from the reconstruction's camera poses — passed to Viewer3D so
// a dense/mesh cloud (which carries no cameras of its own) still frames level, the
// same way COLMAP/Metashape orient the view (see estimateUpFromCameras). Derived from
// the sparse cameras, so it's stable across sparse↔dense↔mesh selections.
// A user orientation (Orient model) defines up; otherwise it is estimated from the cameras.
const viewerSceneUp = computed(() =>
  reconstructionStore.orientationState.active
    ? normalizeOrientation(reconstructionStore.orientation).up
    : estimateUpFromCameras(sparseCameras.value, { aerial: currentSceneType.value === 'aerial' }),
)

// Queue layer changes while the 3D tab is hidden. Each cloud has its own GPU
// object; selection no longer replaces the other visible layers.
// While a sparse reconstruction runs, the scene is its model so far (liveSparse),
// alone: the clouds from before are in another frame, and are replaced at the end.
const sceneClouds = computed(() => {
  const live = reconstructionStore.liveSparse
  if (live) {
    return [
      {
        id: 'live-sparse',
        name: 'Reconstructing…',
        kind: 'sparse',
        cameras: live.cameras,
        points: live.points,
        count: live.points.count,
      },
    ]
  }
  return clouds.value.map((c) => ({ ...c }))
})
let scenePending = true
function flushScene() {
  if (!scenePending || !viewerRef.value) return
  scenePending = false
  viewerRef.value.setCloudLayers(sceneClouds.value, { follow: !!reconstructionStore.liveSparse })
}
watch(sceneClouds, () => {
  scenePending = true
  if (activeTabId.value === 'viewer') flushScene()
})
watch(viewerRef, () => {
  scenePending = true
  if (activeTabId.value === 'viewer') flushScene()
})
// The live view stays usable during the run (ProgressModal's spotlight), for looking
// only: a tool left open would put its toolbox, and its Delete or Export, within reach.
watch(
  () => !!reconstructionStore.liveSparse,
  (live) => {
    if (!live) return
    viewerRef.value?.exitTools?.()
    regionEdit.value = false
    orientEdit.value = false
    orientPicking.value = null
    alignPairs.value = null
  },
)
watch(activeTabId, (id) => {
  if (id === 'viewer') flushScene()
})

// The tab menu answers Escape and outside clicks before anything else sees them.
// Capture phase: the viewers below (3D selection, measuring) also listen on window
// and mount before this, so a bubbling listener would let them clear a selection
// on the same press that only meant to close the menu.
function onKeydown(e) {
  if (matches(e, 'app.escape') && tabCtx.value) {
    closeTabCtx()
    e.preventDefault()
    e.stopImmediatePropagation()
  }
}
function onDocumentClick() {
  if (tabCtx.value) closeTabCtx()
}
onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  document.addEventListener('click', onDocumentClick)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('click', onDocumentClick)
})
</script>

<template>
  <main class="main">
    <div class="tabstrip">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{
          'active': tab.id === activeTabId,
          'dragging': tab.id === draggedTabId,
          'drag-over': tab.id === dragOverTabId && tab.id !== draggedTabId,
        }"
        :draggable="tab.closable"
        @click="activateTab(tab.id)"
        @contextmenu="onTabRightClick($event, tab)"
        @dragstart="onTabDragStart($event, tab)"
        @dragover="onTabDragOver($event, tab)"
        @drop="onTabDrop(tab)"
        @dragend="onTabDragEnd"
      >
        <span class="tab-title">{{ tab.title }}</span>
        <span v-if="tab.closable" class="tab-close" title="Close" @click.stop="closeTab(tab.id)">×</span>
      </button>
    </div>

    <div class="content">
      <Viewer3D
        :ref="setViewer"
        data-run-spotlight
        v-show="activeTabId === 'viewer'"
        :theme="theme"
        :images="images"
        :show-cameras="showCameras"
        :show-grid="showGrid"
        :show-legend="showLegend"
        :scene-up="viewerSceneUp"
        :frame-signature="reconstructionStore.currentFrameSignature"
        @command="handleCommand"
        @edit-selection="onEditSelection"
        @select-tool="
          (t) => {
            selectTool3d = t
          }
        "
        @turntable="
          (on) => {
            turntable3d = on
          }
        "
        :region-box="viewerRegionBox"
        :region-stale="viewerRegionStale"
        :region-edit="regionEdit"
        @region-change="
          (b) => {
            regionDraft = b
          }
        "
        :pick-mode="viewerPickMode"
        :markers="viewerMarkers"
        @pick="onViewerPick"
      >
        <template #toolbox>
          <RegionToolbox
            v-if="regionEdit"
            v-model="regionDraft"
            :saved-state="
              reconstructionStore.regionState.active ? 'active' : reconstructionStore.region ? 'stale' : 'none'
            "
            :can-fit-dense="editableClouds.some((c) => !c.imported)"
            @fit="fitRegionDraft"
            @apply="applyRegion"
            @clear="removeRegion"
            @close="regionEdit = false"
          />
          <OrientToolbox
            v-if="orientEdit"
            :draft="orientDraft"
            :picking="orientPicking"
            :plane-picks="orientPlanePicks.length"
            :saved-state="
              reconstructionStore.orientationState.active
                ? 'active'
                : reconstructionStore.orientation
                  ? 'stale'
                  : 'none'
            "
            :georeferenced="!!georef"
            @pick="toggleOrientPick"
            @auto-up="orientAutoUp"
            @centre-origin="orientCentreOrigin"
            @heading="setOrientHeading"
            @apply="applyOrientation"
            @clear="removeOrientation"
            @close="orientEdit = false"
          />
          <AlignPairsToolbox
            v-if="alignPairs"
            v-model:source-id="alignPairs.sourceId"
            v-model:reference-id="alignPairs.referenceId"
            v-model:allow-scale="alignPairs.allowScale"
            :clouds="editableClouds"
            :references="alignReferences"
            :pairs="alignPairs.pairs"
            @undo="alignPairs.pairs = alignPairs.pairs.slice(0, -1)"
            @clear="alignPairs.pairs = []"
            @apply="applyAlignPairs"
            @close="alignPairs = null"
          />
        </template>
      </Viewer3D>
      <ViewerMap
        v-if="mapMounted"
        :ref="setMapViewer"
        v-show="activeTabId === 'map'"
        v-model:gcp-edit="mapGcpEdit"
        :images="images"
        :gcps="gcps"
        :footprints="mapFootprints"
        :poses="poses"
        :selected-id="selectedId"
        :selected-gcp-id="selectedGcpId"
        :aligned-uuids="alignedUuids"
        :has-sparse="hasSparse"
        :crs="currentCrs"
        :show-footprints="showFootprints"
        :show-grid="showMapGrid"
        :show-cameras="showMapCameras"
        :show-gcps="showMapGcps"
        :show-layers-panel="mapLayersPanel"
        :layers="mapLayers"
        :probe-raster="probeMapLayersAt"
        :model-frame="mapFrame"
        :model-cameras="modelCameras"
        :model-markers="modelMarkers"
        :measure-target="mapMeasureTarget"
        :notes="mapNotes"
        :load-raster="ensureRasterLoaded"
        @select="selectImage"
        @open-image="(id) => openImageTab(id)"
        @command="handleCommand"
        @select-gcp="selectGcp"
        @set-gcp-position="setGcpGroundPosition"
        @add-gcp-at="addGcpAtCoord"
        @delete-gcp="confirmRemoveGcp"
      />
      <template v-for="tab in tabs" :key="tab.id">
        <ViewerImage
          v-if="tab.type === 'image' && imageById(tab.imageId)"
          v-show="activeTabId === tab.id"
          :ref="
            (el) => {
              if (el) imageViewerRefs[tab.imageId] = el
              else delete imageViewerRefs[tab.imageId]
            }
          "
          :image="imageById(tab.imageId)"
          :show-keypoints="showKeypointsFor(imageById(tab.imageId))"
          :show-mask="imageViewPrefs.showMask"
          :show-depth="imageViewPrefs.showDepth"
          :show-gcps="imageViewPrefs.showGcps"
          :gcps="activeTabId === tab.id ? activeImageGcps : []"
          :gcp-guides="activeTabId === tab.id ? activeImageGcpGuides : []"
          :show-residuals="imageViewPrefs.showResiduals"
          :residuals="activeTabId === tab.id ? activeImageResiduals : []"
          :all-gcps="allGcpsBrief"
          :selected-gcp-id="selectedGcpId"
          :mask-edit="imageViewPrefs.maskEdit"
          :gcp-edit="imageViewPrefs.gcpEdit"
          :scene-type="currentSceneType"
          @exit-mask-edit="patchImageView({ maskEdit: false })"
          @exit-gcp-edit="exitGcpEdit"
          @update-mask="(blob, persist) => updateMask(tab.imageId, blob, persist)"
          @update-depth="(blob) => updateDepth(tab.imageId, blob)"
          :is-film="sensorForImage(tab.imageId)?.kind === 'film'"
          :show-fiducials="imageViewPrefs.showFiducials"
          :fiducial-marks="fiducialDisplayForImage(tab.imageId).marks"
          :fiducial-obs="fiducialDisplayForImage(tab.imageId).obs"
          :fiducial-transform="fiducialDisplayForImage(tab.imageId).transform"
          @mark-gcp="(pt) => assignGcpObservation(tab.imageId, imageById(tab.imageId)?.name, pt)"
          @add-gcp="(pt) => addGcpAtObservation(tab.imageId, imageById(tab.imageId)?.name, pt)"
          @select-gcp="selectGcp"
          @delete-gcp="confirmRemoveGcp"
          @mark-fiducial="(event) => markDisplayedFiducial(tab.imageId, event)"
        />
        <ViewerGcp
          v-else-if="tab.type === 'gcp'"
          v-show="activeTabId === tab.id"
          :gcp="gcps.find((g) => g.id === tab.gcpId) ?? null"
          :images="images"
          :report="gcpReport.find((r) => r.gcpId === tab.gcpId) ?? null"
          @jump-to-image="jumpToImage"
          @remove-observation="confirmRemoveGcpObservation"
        />
        <ProductViewer
          v-else-if="tab.type === 'product'"
          v-show="activeTabId === tab.id"
          :ref="
            (el) => {
              if (el) productViewerRefs[tab.id] = el
              else delete productViewerRefs[tab.id]
            }
          "
          :kind="tab.productKind"
          :product="reconstructionStore.productById(tab.productId)"
          :frame-status="reconstructionStore.productFrameStatus(reconstructionStore.productById(tab.productId))"
          @command="handleCommand"
        />
        <!-- Same viewer, imported raster instead of a computed product. -->
        <ProductViewer
          v-else-if="tab.type === 'raster'"
          v-show="activeTabId === tab.id"
          :ref="
            (el) => {
              if (el) productViewerRefs[tab.id] = el
              else delete productViewerRefs[tab.id]
            }
          "
          :kind="rasterById(tab.rasterId)?.kind ?? 'dem'"
          :product="rasterById(tab.rasterId)"
          :source="rasterSources.get(tab.rasterId) ?? null"
          :selected-gcp="gcps.find((g) => g.id === selectedGcpId) ?? null"
          @command="handleCommand"
          @pick-gcp="(pick) => pickGcpFromReference(tab.rasterId, pick)"
        />
      </template>
    </div>
  </main>

  <!-- Tab context menu (closable tabs only) -->
  <Teleport to="body">
    <div v-if="tabCtx" class="tab-ctx-menu" :style="{ left: tabCtx.x + 'px', top: tabCtx.y + 'px' }" @click.stop>
      <button
        class="tab-ctx-item"
        @click="
          () => {
            closeTab(tabCtx.id)
            closeTabCtx()
          }
        "
      >
        Close
      </button>
      <button
        class="tab-ctx-item"
        :disabled="!tabCtxHasOthers"
        @click="
          () => {
            closeOtherTabs(tabCtx.id)
            closeTabCtx()
          }
        "
      >
        Close others
      </button>
      <button
        class="tab-ctx-item"
        :disabled="!tabCtxHasLeft"
        @click="
          () => {
            closeTabsToLeft(tabCtx.id)
            closeTabCtx()
          }
        "
      >
        Close to the left
      </button>
      <button
        class="tab-ctx-item"
        :disabled="!tabCtxHasRight"
        @click="
          () => {
            closeTabsToRight(tabCtx.id)
            closeTabCtx()
          }
        "
      >
        Close to the right
      </button>
      <div class="tab-ctx-sep" />
      <button
        class="tab-ctx-item"
        @click="
          () => {
            closeAllTabs()
            closeTabCtx()
          }
        "
      >
        Close all
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.tabstrip {
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  gap: 1px;
  background: var(--bg);
  border-bottom: 1px solid var(--panel-border);
  overflow-x: auto;
}
.tab {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 200px;
  padding: 8px 12px;
  background: var(--panel);
  border: none;
  border-right: 1px solid var(--panel-border);
  color: var(--text-dim);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.tab:hover {
  color: var(--text);
}
.tab.active {
  background: var(--bg);
  color: var(--text);
  box-shadow: inset 0 2px 0 var(--accent);
}
.tab.dragging {
  opacity: 0.45;
}
/* Drop indicator: accent bar on the leading edge of the hovered tab. */
.tab.drag-over {
  box-shadow: inset 3px 0 0 var(--accent);
}
.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab-close {
  font-size: 15px;
  line-height: 1;
  border-radius: 3px;
  padding: 0 3px;
  color: var(--text-dim);
}
.tab-close:hover {
  background: var(--hover-bg);
  color: var(--text);
}
.content {
  flex: 1;
  position: relative;
  min-height: 0;
}
/* Tab context menu */
.tab-ctx-menu {
  position: fixed;
  z-index: 300;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 4px;
  min-width: 140px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.tab-ctx-item {
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
.tab-ctx-item:hover:not(:disabled) {
  background: var(--hover-bg);
}
.tab-ctx-item:disabled {
  opacity: 0.35;
  cursor: default;
}
.tab-ctx-sep {
  height: 1px;
  background: var(--panel-border);
  margin: 4px 0;
}
</style>
