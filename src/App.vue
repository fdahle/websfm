<script setup>
import { pendingPersistence, persistenceFailures, retryPersistence } from './utils/persistence.js'
import { ref, computed, reactive, watch, onMounted, nextTick, defineAsyncComponent } from 'vue'
import { storeToRefs } from 'pinia'
import Ribbon from './components/layout/Ribbon.vue'
import Sidebar from './components/layout/Sidebar.vue'
import WorkspaceView from './components/layout/WorkspaceView.vue'
import { provideSidebar } from './components/layout/sidebar/sidebarContext.js'
import { provideAppContext } from './appContext.js'
import ProjectModals from './components/modals/ProjectModals.vue'
import PipelineModals from './components/modals/PipelineModals.vue'
import DataModals from './components/modals/DataModals.vue'
import ModelDownloadModal from './components/modals/ModelDownloadModal.vue'
import DevConsole from './components/layout/DevConsole.vue'
import BrowserWarning from './components/layout/BrowserWarning.vue'
import MobileWarning from './components/layout/MobileWarning.vue'
import ToastStack from './components/layout/ToastStack.vue'
import UpdatePrompt from './components/layout/UpdatePrompt.vue'

import { useImagesStore } from './stores/useImagesStore.js'
import { useMatchesStore } from './stores/useMatchesStore.js'
import { useTabs } from './composables/useTabs.js'
import { useImageViewSettings } from './composables/useImageViewSettings.js'
import { useProjectsStore } from './stores/useProjectsStore.js'
import { useModalsStore } from './stores/useModalsStore.js'
import { useGlossaryStore } from './stores/useGlossaryStore.js'
import { useGuideStore } from './stores/useGuideStore.js'
import { usePipeline } from './composables/usePipeline.js'
import { useMapProducts } from './composables/useMapProducts.js'
import { useSidebarResize } from './composables/useSidebarResize.js'
import { useImportRouting } from './composables/useImportRouting.js'
import { useExports } from './composables/useExports.js'
import { useConfirmations } from './composables/useConfirmations.js'
import { useProjectLifecycle } from './composables/useProjectLifecycle.js'
import { useModalEscape } from './composables/useModalEscape.js'
import { useGcpEditing } from './composables/useGcpEditing.js'
import { useModelTools } from './composables/useModelTools.js'
import { useFiducialTools } from './composables/useFiducialTools.js'
import { useWorkspaceState } from './composables/useWorkspaceState.js'
import { useWorkflowWiring } from './composables/useWorkflowWiring.js'
import { useRasterTabs } from './composables/useRasterTabs.js'
import { useDialogRuns } from './composables/useDialogRuns.js'
import { useViewState } from './composables/useViewState.js'
import { useCommandDispatch } from './composables/useCommandDispatch.js'
import { useRibbonState } from './composables/useRibbonState.js'
import { useConsoleEnv } from './composables/useConsoleEnv.js'
import { useSidebarActions } from './composables/useSidebarActions.js'
import { useBeforeUnload } from './composables/useBeforeUnload.js'
import { useReconstructionStore } from './stores/useReconstructionStore.js'
import { useExternalStore } from './stores/useExternalStore.js'
import { useGcpsStore } from './stores/useGcpsStore.js'
import { useFootprintsStore } from './stores/useFootprintsStore.js'
import { useSensorsStore } from './stores/useSensorsStore.js'
import { usePosesStore } from './stores/usePosesStore.js'
import './stores/useLogStore.js'   // registers the console as a project-scoped store
import * as opfs from './utils/opfs.js'
import { useSfmInterop } from './composables/useSfmInterop.js'
import HelpPopupStack from './components/glossary/HelpPopupStack.vue'

// These dialogs pull in large reports, Markdown/KaTeX, or diagnostic code and are
// not needed for the initial workspace. Load them on first open instead of putting
// every optional tool in the entry chunk.
const GlossaryModal = defineAsyncComponent(() => import('./components/glossary/GlossaryModal.vue'))
const GuideModal = defineAsyncComponent(() => import('./components/guide/GuideModal.vue'))

// ── Projects ──────────────────────────────────────────────────────────────────
const projectsStore = useProjectsStore()
const {
  persistenceAvailable, projects, currentProjectName, currentSceneType, currentCrs,
} = storeToRefs(projectsStore)
const { setPersistenceAvailable, loadIndex } = projectsStore

// ── Images ────────────────────────────────────────────────────────────────────
const imagesStore = useImagesStore()
const { images, pendingWorkCount: pendingImageWork } = storeToRefs(imagesStore)
const {
  imageById, addImages, detectAll, addFiducialObservations,
} = imagesStore

// ── Matches ───────────────────────────────────────────────────────────────────
// Project-scoped store; restore/clear run through the project-store registry.
const matchesStore = useMatchesStore()
const { matchStore } = storeToRefs(matchesStore)
const { matchAll } = matchesStore

// ── Tabs ──────────────────────────────────────────────────────────────────────
const showMap = computed(() => currentSceneType.value !== 'object')

const {
  tabs, activeTabId,
  activeTab, activeImageTab, activeView, openTabIds,
  activateTab, openImageTab, openProductTab, openGcpTab,
  // Aliased: App.vue wraps this in an `openRasterTab` that also kicks off the
  // lazy plane hydration.
  openRasterTab: openRasterTabRaw, closeTabForRaster,
  closeTab, closeTabForImage, moveTab,
  closeAllTabs, closeOtherTabs, closeTabsToLeft, closeTabsToRight,
  setTabTitle, closeProductTabs, resetToViewer,
} = useTabs(imageById, showMap)
// Image-view overlay + edit toggles: one global, persisted preference shared by every
// image tab (switching images never changes them), not per-tab state.
const { imageViewPrefs, setImageViewPrefs, patchImageView } = useImageViewSettings()

// ── Sidebar resize ──────────────────────────────────────────────────────────────
const { sidebarWidth, startSidebarResize } = useSidebarResize()

// ── Reconstruction ────────────────────────────────────────────────────────────
// Project-scoped store; restore/clear run through the project-store registry.
const reconstructionStore = useReconstructionStore()
const { clouds, selectedCloud, mainSparseCloud, dem, ortho, georef, summary: reconSummary } = storeToRefs(reconstructionStore)
const { reconstruct, importColmapModel, importInteropModel, importCloud, editClouds, textureMesh, computeDepthMaps, densify, generateDem, generateOrtho, generateMesh, effectiveFrameSpec, clearDerived: clearReconstructionDerived } = reconstructionStore

async function clearCurrentProjectDerived() {
  await clearReconstructionDerived()
  // Product tabs would otherwise remain open with a now-null backing raster.
  closeProductTabs()
}

// ── External reference data (imported DEMs / orthophotos) ─────────────────────
// Project-scoped; restore/clear run through the project-store registry. Only the
// index is in memory — pixel planes hydrate on first use (useExternalStore).
const externalStore = useExternalStore()
const {
  pendingWorkCount: pendingRasterWork,
  } = storeToRefs(externalStore)
const { importRaster } = externalStore
// The map's raster layers + status-bar probe: reference rasters and computed
// DEM/ortho alike (CLAUDE.md ▸ useExternalStore, map raster layers).
const {
  mapLayers, probeAt: probeMapLayersAt, mapMode, toggleModelFrame, mapFrame, modelCameras, modelMarkers, mapNotes,
  measureTargets: mapMeasureTargets, measureTargetId: mapMeasureTargetId, setMeasureTarget: setMapMeasureTarget,
  measureTarget: mapMeasureTarget,
} = useMapProducts()

// ── Ground Control Points ───────────────────────────────────────────────────────
const gcpsStore = useGcpsStore()
const { addGcps } = gcpsStore
// Marking, map placement, the accuracy report and the shared selection.
const {
  gcpReport, refreshGcpReport, selectedGcpId, selectGcp, changeGcpRole,
  fillGcpZFromReferenceDem, checkGcpZAgainstReferenceDem, convertGcpHeightsTo,
  assignGcpObservation, addGcpAtObservation, setGcpGroundPosition, addGcpAtCoord, pickGcpFromReference,
  startMarkingPoint, exitGcpEdit, jumpToImage, openGcpView, removeGcpAndCloseTab, removeGcpObservation,
  activeImageGcps, activeImageGcpGuides, allGcpsBrief,
} = useGcpEditing({ activeTab, openImageTab, openGcpTab, closeTab })

// Quality Report hub: open on a given section.
function openQuality(section = 'overview') {
  qualitySection.value = section
  qualityOpen.value = true
}
// From the hub's Image Errors row → open the image AND enable the residual overlay
// (it's a global toggle, so setting it from here is legitimate — WS3).
function openImageWithResiduals(imageId) {
  if (imageId == null) return
  setImageViewPrefs({ ...imageViewPrefs.value, showResiduals: true })
  openImageTab(imageId)
  qualityOpen.value = false
}

// ── Shapefiles (vector polygon layers: computed footprints + imported polygons) ───
const footprintsStore = useFootprintsStore()
const { addFootprints, computeFootprints } = footprintsStore
// ── Sensors (shared intrinsics) ───────────────────────────────────────────────────
// Project-scoped, but restored/cleared manually (must precede images — its EXIF
// auto-grouping watcher reacts to the image list).
const sensorsStore = useSensorsStore()
const { sensors } = storeToRefs(sensorsStore)
const {
  importSensors, importFiducialMarks,
  } = sensorsStore

// ── Camera poses (extrinsics) ─────────────────────────────────────────────────────
const posesStore = usePosesStore()
const { poses } = storeToRefs(posesStore)
const { addPoses } = posesStore

// ── Modals ────────────────────────────────────────────────────────────────────
const {
  projectPickerOpen, newProjectOpen, newProjectCanCancel, poseTableOpen, sensorTableOpen, gcpTableOpen, footprintFromPosesOpen,
  qualityOpen, qualitySection,
  } = storeToRefs(useModalsStore())

const glossaryStore = useGlossaryStore()
const guideStore = useGuideStore()


// Film fiducials: which sensor the Detect / Calibrate dialogs target, and what the
// image view draws and lets the user place.
const {
  fiducialDetectSensor, fiducialDetectImages, fiducialCalibrateSensor, fiducialCalibrateImages, filmSensors,
  sensorForImage, fiducialDisplayForImage, markDisplayedFiducial, openFiducialDetect, openFiducialCalibrate,
} = useFiducialTools()

// ── Pipeline ──────────────────────────────────────────────────────────────────
const {
  progressOpen, progressTitle, progressCurrent, progressTotal, progressLabel,
  progressUnit, progressFraction, progressIndeterminate, progressComplete, progressCancelling,
  cancelRun, runDetect, runMatch, runReconstruct, runComputeDepthMaps, runDensify,
  runGenerateDem, runGenerateOrtho, runGenerateMesh, runEditClouds, runTextureMesh, progress: exportProgress,
} = usePipeline({ images, detectAll, matchAll, reconstruct, computeDepthMaps, densify, generateDem, generateOrtho, generateMesh, editClouds, textureMesh })

// ── Derived state ──────────────────────────────────────────────────────────────
// Everything derived from store state alone (workspace readiness, match summaries,
// counts the dialogs gate on) — the ribbon, the console, workflows and dialogs read it.
const {
  detectedMaxKeypoints, detectedImageCount, footprintCount, posedImageCount, footprintImageCount,
  incompleteSensorIds, sparseReady, cloudReady, denseReady, meshReady, demReady, orthoReady, productReady,
  editableClouds, meshClouds, selected, kpImageCount, imagesLoading, hasSparse, alignedUuids,
  usedKeysOf, matchSummaries, matchNodePositions, matchStats,
} = useWorkspaceState()

// What the ribbon and the console guard on (core/help/commands.js NEED_CHECKS),
// and the image tab's overlay state the ribbon's contextual tab shows.
const { commandState, activeImageViewState } = useRibbonState({
  tabs: { activeTab, activeView },
  workspace: { imagesLoading, selected, kpImageCount, footprintCount, sparseReady, cloudReady, denseReady,
    editableClouds, demReady, meshReady, orthoReady, productReady },
  filmSensors, sensorForImage, activeImageGcps, mapMode, mapMeasureTargets,
})

// Workflows: the runner and the builder's handlers. Interactive blocks open their
// command's dialog through the same dispatch as the ribbon.
const {
  workflowState, workflowRunner, workflowRunning, workflowPause, workflowStatuses, workflowCurrentBlockId,
  addNewWorkflow, onWorkflowUpdate, closeWorkflowBuilder, onWorkflowRun,
} = useWorkflowWiring({
  ready: { kpImageCount, sparseReady, cloudReady, denseReady, meshReady, demReady, orthoReady },
  pipeline: { runDetect, runMatch, runReconstruct, runComputeDepthMaps, runDensify, runGenerateDem, runGenerateOrtho, runGenerateMesh, runEditClouds, runTextureMesh, cancelRun },
  openInteractive: (id, value) => handleCommand(id, value),
})

// ── Viewer refs ───────────────────────────────────────────────────────────────
// Set by WorkspaceView; the command dispatch drives the viewers through them.
const viewerRef = ref(null)
const mapViewerRef = ref(null)

// ── View state ────────────────────────────────────────────────────────────────
// The 3D and map display toggles, the modes the ribbon enters, and what the
// ribbon's View tab shows as on.
const {
  showCameras, showGrid, showLegend, showFootprints, showMapGrid, selectTool3d, mapGcpEdit,
  setPointSize, setCameraScale, setMapBasemap, ribbonViewState,
} = useViewState({ mapMode, mapFrame })

// Tools ▸ Model ▾ (region, orientation) and Point Cloud ▾ ▸ Align by point pairs:
// the 3D view's editing toolboxes and the picks they wait for.
const {
  regionEdit, regionDraft, fitRegionDraft, openRegionTool, applyRegion, removeRegion,
  orientEdit, orientDraft, orientPicking, orientPlanePicks, openOrientTool, applyOrientation, removeOrientation,
  toggleOrientPick, orientAutoUp, orientCentreOrigin, setOrientHeading,
  alignPairs, alignReferences, openAlignPairs, applyAlignPairs,
  viewerPickMode, onViewerPick, viewerMarkers, viewerRegionBox, viewerRegionStale, exitModelTool,
} = useModelTools({ activateTab, editableClouds, meshClouds, runEditClouds })

// ── Console ───────────────────────────────────────────────────────────────────
// True while a project is being restored — drives the interaction-blocking overlay.
// Project lifecycle: open / create / switch / delete, folder-backed storage,
// `.websfm` save+load, and the blocking load overlay they all share. Tabs and the
// 3D scene live here, so those two resets are injected.
const {
  projectLoading, projectLoadingProgress, projectLoadingLabel,
  handleCreateProject, handleCancelNewProject,
  folderPrompt, folderPromptProject,
  onFolderConnect, onFolderRepick, openProjectFolder,
  moveCurrentProjectToFolder, moveCurrentProjectToBrowser,
  onSaveProject, importProjectFile, onProjectFilePick,
  handleSwitchProject, handleDeleteProject, handleSetCrs, applyCrsSuggestion,
} = useProjectLifecycle({
  resetToViewer,
  clearViewerScene: () => viewerRef.value?.clearReconstructionData(),
  isBusy: () => progressOpen.value || workflowRunning.value,
})

const consoleOpen = ref(localStorage.getItem('consoleOpen') === 'true')
watch(consoleOpen, (v) => localStorage.setItem('consoleOpen', v))
const devConsoleRef = ref(null)
// Cmd/Ctrl-K: open the console (if closed) and put the cursor in its prompt.
function focusConsole() {
  consoleOpen.value = true
  nextTick(() => devConsoleRef.value?.focusPrompt())
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
onMounted(async () => {
  window.addEventListener('keydown', (e) => {
    // A viewer (3D selection, measuring) or menu that acted on this key consumed it;
    // one key press does one thing, innermost first (see utils/keyRouting.js).
    if (e.defaultPrevented) return
    if (e.key === '`' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      consoleOpen.value = !consoleOpen.value
    } else if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      focusConsole()
    } else if (e.key === 'Escape') {
      if (!closeTopModal()) {
        // Nothing modal to dismiss — Escape exits mask/GCP-edit mode on the active tab.
        const tab = activeTab.value
        if (tab?.type === 'image' && imageViewPrefs.value.maskEdit) patchImageView({ maskEdit: false })
        else if (tab?.type === 'image' && imageViewPrefs.value.gcpEdit) exitGcpEdit()
        else if (exitModelTool()) { /* left the active 3D tool */ }
        else if (mapGcpEdit.value && tab?.id === 'map') mapGcpEdit.value = false
      }
    }
  })

  const available = await opfs.isAvailable()
  if (!available) {
    setPersistenceAvailable(false)
    return
  }

  await loadIndex()

  if (projects.value.length === 0) {
    // Nothing saved yet — force creation of a first project.
    newProjectCanCancel.value = false
    newProjectOpen.value = true
  } else {
    // Let the user pick an existing project or create a new one.
    projectPickerOpen.value = true
  }
})

// ── Import (dropped / picked files) ──────────────────────────────────────────────
// The whole import funnel lives in useImportRouting; it drives the import modals
// (state in useModalsStore) and commits through these store actions.
const { importSession: sfmImportSession, openImport: openSfmImport, closeImport: closeSfmImport, commitImport: commitSfmImport } = useSfmInterop({
  addImages, importColmapModel, importInteropModel, activateTab,
})

const {
  cameraPickMode,
  openDroppedImport, onImportKindChosen, onImportSwitchKind,
  onCloudImport, onCloudPick,
  openRasterImport, onRasterPick, addImagesRouted,
  onCameraImport, onGcpImport, onFootprintImport, onFiducialImport,
  onGcpPick, onCameraPick, onColmapPick, onFiducialObsPick, onFiducialMarksPick,
  onVideoPick, onVideoImport,
} = useImportRouting({
  addGcps, addFootprints, importSensors, addPoses, addFiducialObs: addFiducialObservations, addFiducialMarks: importFiducialMarks,
  importColmap: importColmapModel, importCloud,
  importStreamedCloud: reconstructionStore.importStreamedCloud, importCopcCloud: reconstructionStore.importCopcCloud, progress: exportProgress,
  openSfmProject: openSfmImport,
  // A dropped `.tif` arrives as `image/tiff` and would otherwise be ingested as
  // a source photo, so the image path is routed through the georeference fork.
  importRaster, addImages, importProjectFile,
  activateTab,
  showGcps: () => { gcpTableOpen.value = true },
  showSensors: () => { sensorTableOpen.value = true },
  showPoses: () => { poseTableOpen.value = true },
})

// Footprints from imported camera poses: build one "footprints" set, then open
// the map and zoom to it so the result is immediately visible (and any "they
// landed somewhere unexpected" problem is obvious).
function onFootprintFromPoses(settings) {
  footprintFromPosesOpen.value = false
  const { computed: n, setId } = computeFootprints(settings)
  if (n > 0 && setId) zoomToShapefile(setId)
}

// ── Export (camera params + products) ───────────────────────────────────────────
const {
  exportKind, exportPoses, exportSensors, exportCameraFiducials, exportImageFiducials, exportKeypoints, exportMatches, onExportRun,
  exportTargetCloud, openCloudExport, downloadRasterOriginal, downloadImageOriginal, downloadShapefile,
  exportContours, exportTerrain, exportClipped, exportMeasurementScope, openMeasurementExport, measurementExportCrs,
} = useExports({
  poses, sensors, images, matchStore, clouds, selectedCloud, mainSparseCloud, dem, ortho,
  georef, currentProjectName, currentCrs, summary: reconSummary, progress: exportProgress,
  effectiveFrameSpec,
})


// What each run-style dialog does on Run (close it, run the pipeline stage).
const {
  onDetectRun, onMatchRun, georeferenceAfterReconstruct, closeReconstructModal, onReconstructRun, onGeoreferenceRun,
  editMask, onDepthMapsRun, onDenseRun, onDemRun, onOrthoRun, onMeshRun,
  onCropCloudRun, onFilterCloudRun, onGradualSelectionRun, onMergeCloudsRun, onEditSelection, onOptimizeCamerasRun,
  onImageQualityEstimate, onImageQualityGroup, onImageQualityRemove, onToolEditRun, onSectionRun, onProductToolRun,
} = useDialogRuns({
  pipeline: { runDetect, runMatch, runReconstruct, runComputeDepthMaps, runDensify, runGenerateDem, runGenerateOrtho, runGenerateMesh, runEditClouds, runTextureMesh, exportProgress },
  closeProductTabs, openImageTab, refreshGcpReport,
  requestRemoveImages: (ids) => requestRemoveImages(ids),
})

// ── Confirm-before-destroy ────────────────────────────────────────────────────
// Every irreversible action (remove image / sensor / cloud / raster / GCP /
// shapefile, clear keypoints) routes through one of the two dialogs owned here.
// Tabs live in App.vue, so the close-the-subject's-tab callbacks are injected.
const {
  pendingImageDelete, requestRemoveImages, confirmRemoveImages, deleteMessage,
  pendingConfirm, runPendingConfirm, cancelPendingConfirm,
  confirmRemoveSensor, confirmRemoveCloud, confirmRemoveRaster,
  confirmRemoveGcp, confirmRemoveGcpObservation, confirmRemoveShapefile, confirmClearKeypoints,
  confirmRemoveMatches,
} = useConfirmations({ closeTabForImage, closeTabForRaster, removeGcpAndCloseTab, removeGcpObservation })

// DEM / ortho / reference-raster tabs: opening, renaming and removing them, the
// raster in front for the ribbon's contextual tab, and moving a TIFF between the
// source images and the reference data.
const {
  productViewerRefs, activeRasterTab, activeProductViewer,
  openComputedProductTab, renameProductFromSidebar, confirmRemoveProduct,
  openRasterTab, renameRasterFromSidebar, onRasterImportAsImage, convertImageToRaster,
  rasterBeingStyled, onRasterStyleApply,
} = useRasterTabs({
  tabs: { activeTab, openProductTab, openRasterTabRaw, closeTab, closeTabForRaster, closeTabForImage, setTabTitle },
  openRasterImport,
})

// Escape-closes-top-most-modal (pulls modal state from the stores; the few local
// bits are injected). Used by the global keydown handler in the bootstrap below.
const { closeTopModal } = useModalEscape({
  pendingImageDelete, pendingConfirm, cancelPendingConfirm, exportKind, onCancelNewProject: handleCancelNewProject,
  workflowRunning, onCloseWorkflow: closeWorkflowBuilder,
  sfmImportSession, onCloseSfmImport: closeSfmImport,
  folderPrompt,
})

// Autosaved idle sessions can close quietly. Prompt only while closing would
// interrupt compute, project I/O, or an import whose source bytes are not yet safe.
// The same condition holds back reloading into a new app version (UpdatePrompt).
const workInFlight = computed(() => progressOpen.value || projectLoading.value
  || pendingImageWork.value > 0 || pendingRasterWork.value > 0
  || pendingPersistence.value > 0 || persistenceFailures.value.length > 0)
useBeforeUnload(() => workInFlight.value)

// ── ImageViewer refs (for imperative mask ops) ────────────────────────────────
const imageViewerRefs = reactive({})

// The 2D map's Measure context for the Ribbon (null without a raster on the map):
// the same state shape the raster tab reports, read through the map's handles.
const mapMeasure = computed(() => (mapMeasureTargets.value.length ? {
  targets: mapMeasureTargets.value,
  targetId: mapMeasureTargetId.value,
  kind: mapMeasureTarget.value?.kind ?? null,
  measure: mapViewerRef.value?.measureState ?? null,
} : null))

// ── Commands ──────────────────────────────────────────────────────────────────
// Every ribbon button, console verb, viewer menu and interactive workflow block.
const { handleCommand, pickSfmFiles, pickSfmFolder, pickProjectFile } = useCommandDispatch({
  tabs: { activateTab, activeView, activeTab, activeImageTab, openProductTab },
  viewers: { viewerRef, mapViewerRef, imageViewerRefs, activeProductViewer, activeRasterTab },
  view: {
    showCameras, showGrid, showLegend, showFootprints, showMapGrid, selectTool3d, mapGcpEdit,
    setPointSize, setCameraScale, setMapBasemap,
  },
  map: { toggleModelFrame, setMapMeasureTarget },
  tools: { openRegionTool, openOrientTool, openAlignPairs, openFiducialDetect, openFiducialCalibrate, refreshGcpReport, openQuality },
  exports: {
    exportKind, exportPoses, exportSensors, exportCameraFiducials, exportImageFiducials,
    exportKeypoints, exportMatches, downloadRasterOriginal, openMeasurementExport,
  },
  removals: { confirmRemoveRaster, confirmRemoveProduct, requestRemoveImages },
  imports: {
    cameraPickMode, addImagesRouted, onGcpPick, onCameraPick, onFiducialObsPick, onFiducialMarksPick,
    onColmapPick, onCloudPick, onRasterPick, onVideoPick, onProjectFilePick,
  },
  consoleOpen,
})

// The console's command line acts through this: the same dispatch and guard state as
// the ribbon, plus the workflow runner and the stores its verbs read (run, stats, set,
// pair, select).
const consoleEnv = useConsoleEnv({ dispatch: handleCommand, commandState, workflowRunner, matchStats })

// ── Dialog hosts ──────────────────────────────────────────────────────────────
// WorkspaceView and the dialog hosts (ProjectModals / PipelineModals / DataModals)
// read store state themselves; this is the composed state and handlers they need
// (appContext.js).
provideAppContext({
  activateTab, activeImageGcpGuides, activeImageGcps, activeTab, activeTabId, addGcpAtCoord,
  addGcpAtObservation, addNewWorkflow, alignPairs, alignReferences, alignedUuids, allGcpsBrief,
  applyAlignPairs, applyCrsSuggestion, applyOrientation, applyRegion, assignGcpObservation,
  cancelPendingConfirm, cancelRun, changeGcpRole, checkGcpZAgainstReferenceDem, convertGcpHeightsTo,
  clearCurrentProjectDerived, closeAllTabs, closeOtherTabs, closeReconstructModal, closeSfmImport,
  closeTab, closeTabsToLeft, closeTabsToRight, closeWorkflowBuilder, commitSfmImport,
  confirmRemoveGcp, confirmRemoveGcpObservation, confirmRemoveImages, confirmRemoveSensor,
  deleteMessage, detectedImageCount, detectedMaxKeypoints, editMask, editableClouds, exitGcpEdit,
  exportClipped, exportContours, exportKind, exportMeasurementScope, exportTargetCloud, exportTerrain,
  fiducialCalibrateImages, fiducialCalibrateSensor, fiducialDetectImages, fiducialDetectSensor,
  fiducialDisplayForImage, fillGcpZFromReferenceDem, fitRegionDraft, folderPrompt,
  folderPromptProject, footprintImageCount, gcpReport, georeferenceAfterReconstruct,
  handleCancelNewProject, handleCommand, handleCreateProject, handleDeleteProject, handleSetCrs,
  handleSwitchProject, hasSparse, imageViewerRefs, jumpToImage, mapFrame, mapGcpEdit, mapLayers,
  mapMeasureTarget, mapNotes, mapViewerRef, markDisplayedFiducial, matchNodePositions,
  matchSummaries, measurementExportCrs, meshClouds, modelCameras, modelMarkers, moveCurrentProjectToBrowser,
  moveCurrentProjectToFolder, moveTab, onCameraImport, onCloudImport, onCropCloudRun, onDemRun,
  onDenseRun, onDepthMapsRun, onDetectRun, onEditSelection, onExportRun, onFilterCloudRun,
  onFiducialImport, onFolderConnect, onFolderRepick, onFootprintFromPoses, onFootprintImport, onGcpImport,
  onGeoreferenceRun, onGradualSelectionRun, onImageQualityEstimate, onImageQualityGroup,
  onImageQualityRemove, onImportKindChosen, onImportSwitchKind, onMatchRun, onMergeCloudsRun,
  onMeshRun, onOptimizeCamerasRun, onOrthoRun, onProductToolRun, onRasterImportAsImage,
  onRasterStyleApply, onReconstructRun, onSaveProject, onSectionRun, onToolEditRun, onVideoImport, onViewerPick,
  onWorkflowRun, onWorkflowUpdate, openImageTab, openImageWithResiduals, openProjectFolder,
  orientAutoUp, orientCentreOrigin, orientDraft, orientEdit, orientPicking, orientPlanePicks,
  pendingConfirm, pendingImageDelete, pickGcpFromReference, pickProjectFile, pickSfmFiles, pickSfmFolder,
  posedImageCount, probeMapLayersAt, productViewerRefs, progressCancelling, progressComplete,
  progressCurrent, progressFraction, progressIndeterminate, progressLabel, progressOpen,
  progressTitle, progressTotal, progressUnit, projectLoading, projectLoadingLabel,
  projectLoadingProgress, rasterBeingStyled, refreshGcpReport, regionDraft, regionEdit,
  removeOrientation, removeRegion, runPendingConfirm, selectGcp, selectTool3d, selectedGcpId,
  sensorForImage, setGcpGroundPosition, setOrientHeading, sfmImportSession, showCameras,
  showFootprints, showGrid, showLegend, showMapGrid, startMarkingPoint, tabs, toggleOrientPick,
  usedKeysOf, viewerMarkers, viewerPickMode, viewerRef, viewerRegionBox, viewerRegionStale,
  workflowCurrentBlockId, workflowPause, workflowRunner, workflowRunning, workflowState,
  workflowStatuses,
})

// ── Sidebar ───────────────────────────────────────────────────────────────────
// The sections read store data themselves; this is everything else they need —
// App-level state and what each row action does (sidebar/sidebarContext.js).
const { context: sidebarContext, zoomToShapefile } = useSidebarActions({
  tabs: { tabs, activateTab, openImageTab, setTabTitle },
  viewers: { viewerRef, mapViewerRef },
  state: { gcpReport, selectedGcpId, matchStats, incompleteSensorIds, alignedUuids, hasSparse, openTabIds },
  actions: {
    addImagesRouted, openDroppedImport, confirmClearKeypoints, requestRemoveImages, downloadImageOriginal,
    convertImageToRaster, confirmRemoveSensor, confirmRemoveMatches, exportMatches, confirmRemoveGcp, selectGcp,
    jumpToImage, openGcpView, confirmRemoveShapefile, downloadShapefile, confirmRemoveCloud, openCloudExport,
    openComputedProductTab, confirmRemoveProduct, renameProductFromSidebar, exportKind, openRasterTab,
    confirmRemoveRaster, downloadRasterOriginal, renameRasterFromSidebar, onRasterImportAsImage,
  },
})
provideSidebar(sidebarContext)
</script>

<template>
  <div class="app">
    <div v-if="persistenceFailures.length" role="alert" class="persistence-error">
      Unsaved changes: {{ persistenceFailures[0].error?.message || 'Storage write failed' }}
      <button :disabled="pendingPersistence > 0" @click="retryPersistence().catch(() => {})">Retry saving</button>
    </div>
    <MobileWarning />
    <BrowserWarning />
    <ToastStack />
    <UpdatePrompt :busy="workInFlight" />
    <Ribbon
      :active-view="activeView"
      :state="commandState"
      :view-state="ribbonViewState"
      :active-image-id="activeImageTab?.id ?? null"
      :active-image-name="activeImageTab?.name ?? null"
      :image-view-state="activeImageViewState"
      :active-raster="activeRasterTab"
      :map-measure="mapMeasure"
      :console-open="consoleOpen"
      :persistence-enabled="persistenceAvailable"
      :current-project-name="currentProjectName"
      :scene-type="currentSceneType"
      @command="handleCommand"
    />

    <ProjectModals />
    <PipelineModals />
    <DataModals />

    <GlossaryModal v-if="glossaryStore.isOpen" />
    <GuideModal v-if="guideStore.isOpen" />
    <!-- Hover help popups (glossary terms, field `?`s, nested cross-links). -->
    <HelpPopupStack />

    <div class="layout">
      <Sidebar :style="{ width: sidebarWidth + 'px' }" />
      <div class="sidebar-resizer" title="Drag to resize" @mousedown.prevent="startSidebarResize" />
      <WorkspaceView />
    </div>


    <!-- On-demand ONNX model download (consent + progress). Self-mounts from its
         store's `request` state whenever a learned backend needs uncached weights. -->
    <ModelDownloadModal />

    <!-- Floating "report a bug" button → opens a new GitHub issue in a new tab. -->
    <a
      class="bug-report-fab"
      href="https://github.com/fdahle/websfm/issues/new"
      target="_blank"
      rel="noopener noreferrer"
      title="Report a bug or give feedback on GitHub"
      aria-label="Report a bug on GitHub"
    >
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 2l1.88 1.88M16 2l-1.88 1.88" />
        <path d="M9 7.13V6a3 3 0 1 1 6 0v1.13" />
        <path d="M12 20c-3.31 0-6-2.69-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.31-2.69 6-6 6z" />
        <line x1="12" y1="10" x2="12" y2="18" />
        <path d="M6 13H3M21 13h-3M6 9l-2.5-1M20.5 8L18 9M6 17l-2.5 1M20.5 18L18 17" />
      </svg>
    </a>

    <DevConsole v-if="consoleOpen" ref="devConsoleRef" :env="consoleEnv" />
  </div>
</template>

<style scoped>
/* Floating "report a bug" button, bottom-right. Sits above normal content but
   below modals/overlays (z 299+) so it never covers a dialog. */
.bug-report-fab {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 200;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--panel, #2a2a2a);
  color: var(--text, #e6e6e6);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.15));
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  transition: transform 0.12s ease, background 0.12s ease, color 0.12s ease;
}
.bug-report-fab:hover {
  transform: translateY(-2px);
  background: var(--accent, #3b82f6);
  color: #fff;
}



.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.layout {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
}












/* Sidebar resize handle. Takes NO layout width (1px basis cancelled by a -1px
   margin), so the sidebar's own border-right stays the visual seam instead of a
   gap of page background sitting between the panels. The grab target is widened
   to ~7px by the ::after overlay, which is invisible but hoverable — so dragging
   is as easy as before while the handle only shows itself (accent line) on hover. */
.sidebar-resizer {
  flex: 0 0 1px;
  margin-right: -1px;
  position: relative;
  cursor: ew-resize;
  background: transparent;
  transition: background 0.12s;
  z-index: 5;
}
.sidebar-resizer::after {
  content: '';
  position: absolute;
  inset: 0 -3px;
}
.sidebar-resizer:hover { background: var(--accent); }






</style>

<style scoped>
.persistence-error { position: fixed; bottom: 12px; left: 12px; right: 12px; z-index: 500;
  background: #70271f; color: white; padding: 12px; border-radius: 6px; }
.persistence-error button { margin-left: 12px; }
</style>
