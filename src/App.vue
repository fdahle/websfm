<script setup>
import { ref, computed, reactive, watch, onMounted, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import Ribbon from './components/layout/Ribbon.vue'
import Sidebar from './components/layout/Sidebar.vue'
import Viewer3D from './components/viewers/Viewer3D.vue'
import ViewerMap from './components/viewers/ViewerMap.vue'
import ViewerImage from './components/viewers/ViewerImage.vue'
import ViewerGcp from './components/viewers/ViewerGcp.vue'
import ImageInfoModal from './components/modals/ImageInfoModal.vue'
import DetectFeaturesModal from './components/modals/DetectFeaturesModal.vue'
import MatchFeaturesModal from './components/modals/MatchFeaturesModal.vue'
import ImageTableModal from './components/modals/ImageTableModal.vue'
import CameraPoseTableModal from './components/modals/CameraPoseTableModal.vue'
import MaskManagerModal from './components/modals/MaskManagerModal.vue'
import AutoMaskModal from './components/modals/AutoMaskModal.vue'
import SensorTableModal from './components/modals/SensorTableModal.vue'
import FiducialDetectModal from './components/modals/FiducialDetectModal.vue'
import FiducialCalibrateModal from './components/modals/FiducialCalibrateModal.vue'
import MatchListModal from './components/modals/MatchListModal.vue'
import QualityReportModal from './components/modals/QualityReportModal.vue'
import DebugSummaryModal from './components/modals/DebugSummaryModal.vue'
import ProgressModal from './components/modals/ProgressModal.vue'
import ModelDownloadModal from './components/modals/ModelDownloadModal.vue'
import SettingsModal from './components/modals/SettingsModal.vue'
import ProjectSettingsModal from './components/modals/ProjectSettingsModal.vue'
import AboutModal from './components/modals/AboutModal.vue'
import SystemInfoModal from './components/modals/SystemInfoModal.vue'
import NewProjectModal from './components/modals/NewProjectModal.vue'
import SaveProjectModal from './components/modals/SaveProjectModal.vue'
import FolderReconnectModal from './components/modals/FolderReconnectModal.vue'
import GlossaryModal from './components/glossary/GlossaryModal.vue'
import GuideModal from './components/guide/GuideModal.vue'
import ProjectPicker from './components/layout/ProjectPicker.vue'
import DevConsole from './components/layout/DevConsole.vue'
import BrowserWarning from './components/layout/BrowserWarning.vue'
import ToastStack from './components/layout/ToastStack.vue'
import { useImagesStore } from './stores/useImagesStore.js'
import { useMatchesStore } from './stores/useMatchesStore.js'
import { useTabs } from './composables/useTabs.js'
import { useImageViewSettings } from './composables/useImageViewSettings.js'
import { imageResidualVectors } from './core/eval/imageStats.js'
import { makeCanonicalToScan } from './core/sfm/displayFrame.js'
import { distortionOf } from './core/sfm/distortion.js'
import { useProjectsStore } from './stores/useProjectsStore.js'
import { useTheme } from './composables/useTheme.js'
import { useModalsStore } from './stores/useModalsStore.js'
import { useGlossaryStore } from './stores/useGlossaryStore.js'
import { useGuideStore } from './stores/useGuideStore.js'
import { usePipeline } from './composables/usePipeline.js'
import { useTabDrag } from './composables/useTabDrag.js'
import { useSidebarResize } from './composables/useSidebarResize.js'
import { useImportRouting } from './composables/useImportRouting.js'
import { useExports } from './composables/useExports.js'
import { useConfirmations } from './composables/useConfirmations.js'
import { useProjectLifecycle } from './composables/useProjectLifecycle.js'
import { useModalEscape } from './composables/useModalEscape.js'
import { useBeforeUnload } from './composables/useBeforeUnload.js'
import { useReconstructionStore } from './stores/useReconstructionStore.js'
import { useExternalStore } from './stores/useExternalStore.js'
import { useGcpsStore } from './stores/useGcpsStore.js'
import { useFootprintsStore } from './stores/useFootprintsStore.js'
import { useSensorsStore } from './stores/useSensorsStore.js'
import { usePosesStore } from './stores/usePosesStore.js'
import './stores/useLogStore.js'   // registers the console as a project-scoped store
import { useLog } from './composables/useLog.js'
import ReconstructModal from './components/modals/ReconstructModal.vue'
import FindGcpsModal from './components/modals/FindGcpsModal.vue'
import GeoreferenceModal from './components/modals/GeoreferenceModal.vue'
import ExportModal from './components/modals/ExportModal.vue'
import DepthMapsModal from './components/modals/DepthMapsModal.vue'
import DenseModal from './components/modals/DenseModal.vue'
import DemModal from './components/modals/DemModal.vue'
import MeshModal from './components/modals/MeshModal.vue'
import FilterCloudModal from './components/modals/FilterCloudModal.vue'
import CropCloudModal from './components/modals/CropCloudModal.vue'
import MergeCloudsModal from './components/modals/MergeCloudsModal.vue'
import OrthoModal from './components/modals/OrthoModal.vue'
import ConfirmModal from './components/modals/ConfirmModal.vue'
import ProductViewer from './components/viewers/ProductViewer.vue'
import GcpImportModal from './components/modals/GcpImportModal.vue'
import GcpTableModal from './components/modals/GcpTableModal.vue'
import FootprintImportModal from './components/modals/FootprintImportModal.vue'
import FootprintFromPosesModal from './components/modals/FootprintFromPosesModal.vue'
import CameraImportModal from './components/modals/CameraImportModal.vue'
import ImportKindModal from './components/modals/ImportKindModal.vue'
import ImportCloudModal from './components/modals/ImportCloudModal.vue'
import ImportRasterModal from './components/modals/ImportRasterModal.vue'
import InteropImportModal from './components/modals/InteropImportModal.vue'
import InteropSourceModal from './components/modals/InteropSourceModal.vue'
import RasterStyleModal from './components/modals/RasterStyleModal.vue'
import * as opfs from './utils/opfs.js'
import { ensureProjection } from './core/crs.js'
import { resolveK } from './core/sfm/reconstruction.js'
import { estimateUpFromCameras } from './core/sfm/geometry.js'
import { useSfmInterop } from './composables/useSfmInterop.js'

// ── Theme ─────────────────────────────────────────────────────────────────────
const { theme, applyTheme, setTheme } = useTheme()

// ── Projects ──────────────────────────────────────────────────────────────────
const projectsStore = useProjectsStore()
const {
  persistenceAvailable, projects, currentProjectId, currentProject, currentProjectName, currentSceneType, currentCrs,
} = storeToRefs(projectsStore)
const {
  setPersistenceAvailable, loadIndex, setProjectCrs, renameProject, folderSupported,
} = projectsStore

// ── Images ────────────────────────────────────────────────────────────────────
const imagesStore = useImagesStore()
const { images, selectedId, pendingWorkCount: pendingImageWork } = storeToRefs(imagesStore)
const {
  imageById, selectImage,
  addImages, removeImage,
  updateMask, updateDepth, detectAll, clearKeypoints,
  setFiducialObservation, setFiducialDetection, addFiducialObservations,
} = imagesStore

// Largest detected keypoint count over all images — lets the Match modal warn when
// a LightGlue cap would discard most of them (P6 auto-hint).
const detectedMaxKeypoints = computed(() =>
  images.value.reduce((m, img) => Math.max(m, img.kpCount || 0), 0))

// ── Matches ───────────────────────────────────────────────────────────────────
// Project-scoped store; restore/clear run through the project-store registry.
const matchesStore = useMatchesStore()
const { matchStore } = storeToRefs(matchesStore)
const { matchAll, setPairDisabled } = matchesStore

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
  resetToViewer,
} = useTabs(imageById, showMap)

// Image-view overlay + edit toggles: one global, persisted preference shared by every
// image tab (switching images never changes them), not per-tab state.
const { imageViewPrefs, setImageViewPrefs } = useImageViewSettings()
function patchImageView(patch) {
  setImageViewPrefs({ ...imageViewPrefs.value, ...patch })
}
// Keypoints can only draw once the image has been detected, so the global toggle is
// gated per image rather than forced off on the preference itself.
function showKeypointsFor(img) {
  return imageViewPrefs.value.showKeypoints && img?.kpStatus === 'done'
}

// ── Tab drag-reorder + context menu ─────────────────────────────────────────────
const {
  draggedTabId, dragOverTabId,
  onTabDragStart, onTabDragOver, onTabDrop, onTabDragEnd,
  tabCtx, onTabRightClick, closeTabCtx,
  tabCtxHasLeft, tabCtxHasRight, tabCtxHasOthers,
} = useTabDrag({ tabs, moveTab })

// ── Sidebar resize ──────────────────────────────────────────────────────────────
const { sidebarWidth, startSidebarResize } = useSidebarResize()

// ── Reconstruction ────────────────────────────────────────────────────────────
// Project-scoped store; restore/clear run through the project-store registry.
const reconstructionStore = useReconstructionStore()
const { cameras, sparseCameras, points3d, reconStatus, clouds, selectedCloudId, selectedCloud, mainSparseId, mainSparseCloud, depthMapCount, dem, ortho, georef, canGeoreference, canGeoreferenceGcps, denseSummary, summary: reconSummary } = storeToRefs(reconstructionStore)
const { reconstruct, importColmapModel, importInteropModel, importCloud, editClouds, computeDepthMaps, densify, generateDem, generateOrtho, generateMesh, georeference, gcpAccuracyReport, gcpGuides, gcpEstimate, selectCloud, removeCloud, renameCloud, setMainSparse, clearDerived: clearReconstructionDerived } = reconstructionStore

async function clearCurrentProjectDerived() {
  await clearReconstructionDerived()
  // Product tabs would otherwise remain open with a now-null backing raster.
  for (const tab of [...tabs.value]) if (tab.type === 'product') closeTab(tab.id)
}

// ── External reference data (imported DEMs / orthophotos) ─────────────────────
// Project-scoped; restore/clear run through the project-store registry. Only the
// index is in memory — pixel planes hydrate on first use (useExternalStore).
const externalStore = useExternalStore()
const {
  rasters, pendingRasters, pendingWorkCount: pendingRasterWork,
  sources: rasterSources, hasReferenceDem, orthoRasters: referenceOrthos, mapRasters,
} = storeToRefs(externalStore)
const { importRaster, setRasterKind, setRasterStyle, setVerticalInfo, setRasterOnMap, setRasterOpacity, removeRaster, rasterById, probeRasterAt, ensureRasterLoaded } = externalStore

// Clicking a point cloud in the sidebar shows it in the 3D viewer.
function showCloud(id) {
  selectCloud(id)
  activateTab('viewer')
}

// Context-menu "Zoom to": show the cloud in the 3D viewer and re-frame the camera
// on it (resetView frames the freshly-loaded bounding sphere).
function zoomToCloud(id) {
  selectCloud(id)
  activateTab('viewer')
  nextTick(() => viewerRef.value?.resetView())
}

// ── Ground Control Points ───────────────────────────────────────────────────────
const { log } = useLog()
const gcpsStore = useGcpsStore()
const { gcps, importDefaults: gcpImportDefaults } = storeToRefs(gcpsStore)
const { addGcps, addGcp, setGcpName, setGcpRole, setGcpPosition, setGcpAccuracy, setObservation,
  setGcpVerticalDatum, setObservationAccuracy, removeObservation, removeGcp, reprojectGcps } = gcpsStore

// GCP elevations from an imported reference DEM (the stated goal of the
// external-reference-data work). The sampler is *injected* rather than imported
// so useGcpsStore keeps no dependency on the external store; it reprojects the
// GCP's project-CRS position into the raster's native CRS (the raster itself is
// never warped) and carries the raster's declared vertical accuracy back with
// the value, so a filled Z can never claim an accuracy it doesn't have.
const sampleReferenceDem = (x, y) => externalStore.sampleReferenceDem(x, y)

async function fillGcpZFromReferenceDem() {
  const res = await gcpsStore.fillZFromReferenceDem(sampleReferenceDem)
  if (res.filled) refreshGcpReport()
}

async function checkGcpZAgainstReferenceDem() {
  await gcpsStore.checkZAgainstReferenceDem(sampleReferenceDem)
}

// Per-GCP accuracy report (triangulated residual vs. surveyed position + per-
// observation reprojection error) — refreshed on demand since it triangulates
// against the current sparse cloud; cheap enough to just re-run each open/refresh
// and after every mark so the reprojection feedback stays live.
const gcpReport = ref([])
async function refreshGcpReport() {
  gcpReport.value = await gcpAccuracyReport()
}

async function changeGcpRole({ id, role }) {
  setGcpRole(id, role)
  // A role change alters the control set. Refit immediately so a checkpoint can
  // never be displayed against a stale transform that still used it as control.
  if (reconstructionStore.sparseCameras.size) await georeference()
  await refreshGcpReport()
}

// `selectedGcpId` highlights a GCP's marker in the image view + its row in the
// table; set by clicking a GCP row (highlight only — marking is via right-click).
const selectedGcpId = ref(null)
function selectGcp(id) { selectedGcpId.value = id }

// Turn on the GCP overlay so a freshly-placed mark is visible.
function ensureGcpsVisible() {
  if (!imageViewPrefs.value.showGcps) patchImageView({ showGcps: true })
}

// One line per placed mark — the *only* GCP-guide logging in the app. `guide` is
// read from activeImageGcpGuides by the caller BEFORE setObservation: marking a GCP
// retires its guide on that image, so the prediction being compared against only
// exists until the click lands.
//
// The info line reports the gap between where the model predicted the mark and
// where the user actually clicked. That gap is the diagnostic (METHODS.md §6.4) —
// it should shrink as marks accumulate, and a large one means the reconstruction
// and the user disagree. Logging the guides themselves instead (on every recompute)
// reported the app re-rendering, not the user working.
async function logGcpMark(gcpId, imageId, imageName, px, py, guide) {
  const gcp = gcps.value.find((g) => g.id === gcpId)
  const name = gcp?.name ?? 'GCP'
  const at = `(${px.toFixed(0)}, ${py.toFixed(0)}) on ${imageName}`
  // Runs after setObservation, but this excludes the target image, so 0 still
  // means "the mark just placed is this GCP's first".
  const otherMarks = (gcp?.observations ?? [])
    .filter((o) => o.imageId !== imageId && o.px != null && o.py != null).length
  // Guides are only computed in gcpEdit mode, so an absent guide means either
  // nothing could be predicted yet, or the user is marking with guides off — say
  // which, rather than implying a prediction existed and was missed.
  if (!guide) {
    const why = otherMarks === 0 ? ' — first mark for this GCP, nothing to predict from yet' : ''
    log(`GCP "${name}" marked at ${at}${why}`, 'info', 'GCP')
  } else if (guide.kind === 'line') {
    // `line` is normalised (a²+b²=1), so |a·u+b·v+c| is a true pixel distance.
    const d = Math.abs(guide.line[0] * px + guide.line[1] * py + guide.line[2])
    log(`GCP "${name}" marked at ${at} — ${d.toFixed(1)}px off the epipolar line predicted `
      + `from its 1 other mark`, 'info', 'GCP')
  } else {
    const d = Math.hypot(guide.u - px, guide.v - py)
    const used = guide.viewCount - (guide.rejectedCount ?? 0)
    const from = guide.rejectedCount
      ? `${used} of its ${guide.viewCount} other marks (${guide.rejectedCount} inconsistent with `
        + `the rest, left out of that prediction only)`
      : `its ${guide.viewCount} other marks`
    log(`GCP "${name}" marked at ${at} — ${d.toFixed(1)}px from the position predicted by `
      + `${from}`, 'info', 'GCP')
  }
  await logGcpEstimateShift(gcpId, imageId, px, py, name, guide)
}

// Detail-only: proof that the new mark actually moved the model's estimate, and
// which way. Runs AFTER setObservation, so `gcpEstimate` sees the new mark.
//
// `guide` (pre-mark) is the prediction from the GCP's *other* N marks; the estimate
// after the click is fitted from all N+1. Their difference is this mark's influence
// on where the model puts the GCP, seen on the image being worked on — the only
// place it's observable, since the guide here retires the moment the mark lands.
// Expect it to move toward the click and to shrink as N grows (each mark is one
// vote of N+1). A 0.0px move with the mark counted as inconsistent is the robust
// fit rejecting it, not a stuck estimate.
async function logGcpEstimateShift(gcpId, imageId, px, py, name, guide) {
  if (guide?.kind !== 'point') return   // nothing predicted here before the mark
  const after = await gcpEstimate(gcpId, imageId)
  if (!after) return
  const dx = after.u - guide.u, dy = after.v - guide.v
  const moved = Math.hypot(dx, dy)
  // Sign against the click: a mark should pull the estimate toward itself.
  const toClick = Math.hypot(px - guide.u, py - guide.v)
  const towards = toClick > 1e-6 && ((px - guide.u) * dx + (py - guide.v) * dy) > 0
  const dir = moved < 0.05
    ? 'did not move the estimate (mark consistent with it, or rejected as inconsistent)'
    : `moved the estimate ${moved.toFixed(1)}px ${towards ? 'toward' : 'away from'} your click `
      + `(Δx ${dx >= 0 ? '+' : ''}${dx.toFixed(1)}, Δy ${dy >= 0 ? '+' : ''}${dy.toFixed(1)}), `
      + `now (${after.u.toFixed(1)}, ${after.v.toFixed(1)}) from ${after.viewCount} marks`
  log(`GCP "${name}": this mark ${dir}`, 'debug', 'GCP')
}

// Right-click marking in the image view. Assign attaches the clicked pixel to an
// existing GCP; add-here creates a new GCP already marked at that pixel and
// selects it. Both refresh the accuracy report so reprojection feedback is live.
// The guide is captured before setObservation retires it; logging then runs async
// so the mark itself stays instant.
function assignGcpObservation(imageId, imageName, { gcpId, px, py }) {
  const guide = activeImageGcpGuides.value.find((g) => g.gcpId === gcpId)
  setObservation(gcpId, imageId, imageName, px, py)
  selectedGcpId.value = gcpId
  ensureGcpsVisible()
  refreshGcpReport()
  logGcpMark(gcpId, imageId, imageName, px, py, guide)
}
function addGcpAtObservation(imageId, imageName, { px, py }) {
  const id = addGcp()
  setObservation(id, imageId, imageName, px, py)
  selectedGcpId.value = id
  ensureGcpsVisible()
  refreshGcpReport()
  logGcpMark(id, imageId, imageName, px, py, null)  // new GCP — never has a guide
}

// ── GCP ground-position editing from the 2D map ─────────────────────────────────
// Map coordinates are already in the project CRS (= GCP storage CRS), so a click /
// drag sets X/Y directly. Z has no top-down axis and is left to the table.
function setGcpGroundPosition({ id, x, y }) {
  setGcpPosition(id, 'x', x)
  setGcpPosition(id, 'y', y)
  selectedGcpId.value = id
  const g = gcps.value.find((gg) => gg.id === id)
  log(`GCP "${g?.name ?? id}" position set to (${x.toFixed(3)}, ${y.toFixed(3)}) ${currentCrs.value}`, 'info', 'GCP')
  refreshGcpReport()
}
function addGcpAtCoord({ x, y }) {
  const id = addGcp()
  setGcpPosition(id, 'x', x)
  setGcpPosition(id, 'y', y)
  selectedGcpId.value = id
  refreshGcpReport()
}
// Sidebar observation-list actions.
function jumpToImage({ imageId }) { if (imageId != null) openImageTab(imageId) }

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

// Double-click a GCP in the sidebar → multi-image inspector tab.
function openGcpView(gcpId) {
  const g = gcps.value.find((x) => x.id === gcpId)
  if (g) openGcpTab(gcpId, g.name)
}

// Remove a GCP and close its inspector tab if one is open.
function removeGcpAndCloseTab(gcpId) {
  removeGcp(gcpId)
  closeTab(`gcp:${gcpId}`)
}
// Delete from the image-view GCP-edit toolbar: drop it, clear selection if it was
// the target, and refresh reprojection feedback.
function deleteGcpFromEditor(gcpId) {
  removeGcpAndCloseTab(gcpId)
  if (selectedGcpId.value === gcpId) selectedGcpId.value = null
  refreshGcpReport()
}
function removeGcpObservation({ gcpId, imageId }) {
  removeObservation(gcpId, imageId)
  refreshGcpReport()
}

// ── Shapefiles (vector polygon layers: computed footprints + imported polygons) ───
const footprintsStore = useFootprintsStore()
// `shapefiles` = the managed sets (sidebar rows); `mapFootprints` = the flat list
// of polygons in the sets currently shown on the map (what ViewerMap draws).
const { sets: shapefiles, mapPolygons: mapFootprints } = storeToRefs(footprintsStore)
const { addFootprints, computeFootprints, reprojectFootprints, removeSet, renameSet, setSetOnMap } = footprintsStore
// Total polygons across all sets — gates the ribbon's footprint layer toggle.
const footprintCount = computed(() => shapefiles.value.reduce((n, s) => n + s.footprints.length, 0))

// ── Sensors (shared intrinsics) ───────────────────────────────────────────────────
// Project-scoped, but restored/cleared manually (must precede images — its EXIF
// auto-grouping watcher reacts to the image list).
const sensorsStore = useSensorsStore()
const { sensors } = storeToRefs(sensorsStore)
const {
  imageCount: sensorImageCount,
  addSensors, updateSensor, toggleSensorFixed, setFiducialMarks, setFiducialCalibration,
  assignSensor, mergeSensors, removeSensor,
} = sensorsStore

// Sensor ids whose intrinsics fall back to the default-FOV guess for at least one
// assigned image (or, with no images, on their own) — i.e. no usable calibration.
// Surfaced with a ⚠ in the sidebar so an uncalibrated/incomplete sensor is visible
// before reconstruction (same test SensorTable uses for its warn badge).
const incompleteSensorIds = computed(() => {
  const bad = new Set()
  for (const s of sensors.value) {
    const imgs = images.value.filter((i) => i.sensorId === s.id)
    const probe = imgs.length ? imgs : [{ meta: null }]
    if (probe.some((img) => resolveK(img.meta, s).source.startsWith('default FOV'))) bad.add(s.id)
  }
  return bad
})

// ── Camera poses (extrinsics) ─────────────────────────────────────────────────────
const posesStore = usePosesStore()
const { poses } = storeToRefs(posesStore)
const { addPoses, removePose, reprojectPoses } = posesStore

// Distinct current images that carry each preselect evidence source — the Match
// modal gates its "Preselect by" methods on these (poses link by image.id, as do
// footprints; count only links that resolve to a loaded image).
const posedImageCount = computed(() => {
  const ids = new Set(images.value.map((i) => i.id))
  const posed = new Set()
  for (const p of poses.value)
    if (p.enabled !== false && p.imageId && Number.isFinite(p.x) && Number.isFinite(p.y) && ids.has(p.imageId)) posed.add(p.imageId)
  return posed.size
})
const footprintImageCount = computed(() => {
  const ids = new Set(images.value.map((i) => i.id))
  const withFp = new Set()
  for (const s of shapefiles.value)
    for (const fp of s.footprints)
      if (fp.imageId && ids.has(fp.imageId)) withFp.add(fp.imageId)
  return withFp.size
})

// ── Modals ────────────────────────────────────────────────────────────────────
const {
  settingsOpen, projectSettingsOpen, aboutOpen, systemInfoOpen,
  projectPickerOpen, newProjectOpen, newProjectCanCancel, saveProjectOpen,
  detectFeaturesOpen, matchFeaturesOpen,
  imageTableOpen, poseTableOpen, maskManagerOpen, autoMaskOpen, sensorTableOpen, gcpTableOpen, matchListOpen, reconstructOpen,
  findGcpsOpen, georeferenceOpen,
  depthMapsOpen, denseOpen, demOpen, orthoOpen, meshOpen,
  cropCloudOpen, filterCloudOpen, mergeCloudsOpen,
  gcpImportOpen, gcpImportText, gcpImportName, gcpImportGeojson, gcpImportCrs,
  footprintImportOpen, footprintImportData, footprintFromPosesOpen,
  cameraImportOpen, cameraImportText, cameraImportName, cameraImportMode,
  importKindDeclared, importKindOpen, importKindFile,
  importCloudOpen, importCloudData,
  importRasterOpen, importRasterData, rasterStyleId,
  infoImageId,
  fiducialDetectOpen, fiducialDetectSensorId, fiducialCalibrateOpen, fiducialCalibrateSensorId,
  qualityOpen, qualitySection,
  debugSummaryOpen,
} = storeToRefs(useModalsStore())

const glossaryStore = useGlossaryStore()
const guideStore = useGuideStore()

// Resolved image for the Image Info modal. Lives here (not in the modals store)
// because it needs the image list; moves into the store once images is one too.
const infoImage = computed(() => infoImageId.value ? imageById(infoImageId.value) : null)

// Detection and calibration target one film sensor independently. Detection only
// sees that sensor's images; calibration joins the stored anonymous slots later.
const fiducialDetectSensor = computed(() =>
  fiducialDetectSensorId.value ? sensors.value.find((s) => s.id === fiducialDetectSensorId.value) ?? null : null)
const fiducialDetectImages = computed(() =>
  fiducialDetectSensor.value ? images.value.filter((i) => i.sensorId === fiducialDetectSensor.value.id) : [])
const fiducialCalibrateSensor = computed(() =>
  fiducialCalibrateSensorId.value ? sensors.value.find((s) => s.id === fiducialCalibrateSensorId.value) ?? null : null)
const fiducialCalibrateImages = computed(() =>
  fiducialCalibrateSensor.value ? images.value.filter((i) => i.sensorId === fiducialCalibrateSensor.value.id) : [])

// Both entry points stay reachable for every film sensor. Calibration directs the
// user to detection when no accepted spots exist yet.
const filmSensors = computed(() => sensors.value.filter((s) => s.kind === 'film'))

function fiducialDisplayForImage(imageId) {
  const img = imageById(imageId), sensor = sensorForImage(imageId)
  const detections = img?.fiducialDetections || []
  const cal = sensor?.fiducialCalibration
  if (cal?.marks?.length) {
    const byId = new Map(cal.marks.map((m) => [m.id, m]))
    return {
      marks: cal.marks,
      obs: detections.flatMap((d) => { const fidId = cal.slotMap?.[d.slot]; return byId.has(fidId) ? [{ fidId, px: d.px, py: d.py, slot: d.slot }] : [] }),
    }
  }
  return { marks: detections.map((d) => ({ id: d.slot })), obs: detections.map((d) => ({ fidId: d.slot, px: d.px, py: d.py, slot: d.slot })) }
}

function markDisplayedFiducial(imageId, { fidId, px, py }) {
  const sensor = sensorForImage(imageId), cal = sensor?.fiducialCalibration
  const slot = cal ? Object.keys(cal.slotMap || {}).find((s) => cal.slotMap[s] === fidId) : fidId
  if (slot) setFiducialDetection(imageId, { slot, px, py, family: 'manual', source: 'manual', confidence: 1, reviewed: true })
}

// Ribbon entry. With one candidate sensor go straight to the modal; with several
// there is no way to know which is meant, so hand off to the sensor table — the
// home of film-sensor actions, where each row has its own button.
function openFiducialDetect() {
  const candidates = filmSensors.value
  if (candidates.length === 1) {
    fiducialDetectSensorId.value = candidates[0].id
    fiducialDetectOpen.value = true
    return
  }
  sensorTableOpen.value = true
  log(`${candidates.length} film sensors available — pick one and use "Detect fiducials…"`,
    'info', 'Fiducial')
}

function openFiducialCalibrate() {
  const candidates = filmSensors.value
  if (candidates.length === 1) {
    fiducialCalibrateSensorId.value = candidates[0].id
    fiducialCalibrateOpen.value = true
    return
  }
  sensorTableOpen.value = true
  log(`${candidates.length} film sensors available — pick one and use "Calibrate fiducials…"`, 'info', 'Fiducial')
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
const {
  progressOpen, progressTitle, progressCurrent, progressTotal, progressLabel,
  progressUnit, progressFraction, progressIndeterminate, progressComplete, progressCancelling,
  cancelRun, runDetect, runMatch, runReconstruct, runComputeDepthMaps, runDensify,
  runGenerateDem, runGenerateOrtho, runGenerateMesh, runEditClouds, progress: exportProgress,
} = usePipeline({ images, detectAll, matchAll, reconstruct, computeDepthMaps, densify, generateDem, generateOrtho, generateMesh, editClouds })

// Dense pipeline gating for the Ribbon.
const sparseReady = computed(() => clouds.value.some((c) => c.kind === 'sparse' && c.cameras.size >= 2))
// From the store: counts saved-but-not-yet-hydrated maps too, so Densify / Ortho
// stay enabled after a project reopen (the planes load on demand).
// Products gating: a DEM needs any cloud; an ortho needs a DEM (+ depth maps);
// the preview needs a built product.
const cloudReady = computed(() => clouds.value.some((c) =>
  c.kind === 'dense' ? c.count > 0 : c.points.length > 0))
// Mesh needs a dense cloud (Poisson input); the modal further checks it has normals.
const denseReady = computed(() => clouds.value.some((c) => c.kind === 'dense' && c.count > 0))
const meshReady = computed(() => clouds.value.some((c) => c.kind === 'mesh' && c.count > 0))
// What the crop/filter/merge tools can act on: every non-empty dense cloud, computed
// or imported. Sparse clouds are excluded on purpose — their points carry the
// view-tracks dense/ortho/COLMAP-export read (see core/products/cloudEdit.js).
const editableClouds = computed(() => clouds.value.filter((c) => c.kind === 'dense' && c.count > 0))
const demReady = computed(() => !!dem.value)
const orthoReady = computed(() => !!ortho.value)
const productReady = computed(() => !!dem.value || !!ortho.value)

// ── Derived state ──────────────────────────────────────────────────────────────
const selected = computed(() => images.value.find((img) => img.id === selectedId.value) || null)

const kpImageCount = computed(() => images.value.filter(img => img.kpStatus === 'done').length)

// True while any image is still decoding or transcoding (TIFF PNG encode /
// preview pending). Pixel-reading compute ops (Detect, Auto-mask) gate on this so
// they can't be launched mid-import against not-yet-ready images.
const imagesLoading = computed(() => images.value.some(img => img.loading || img.previewPending))

// Guard state for the DevConsole command line — same prerequisite flags the
// ribbon uses to enable/disable buttons (see core/help/commands.js guardReason).
const commandState = computed(() => ({
  projectReady:  !!currentProjectId.value,
  imageCount:    images.value.length,
  imagesLoading: imagesLoading.value,
  kpImageCount:  kpImageCount.value,
  matchCount:    matchSummaries.value.length,
  gcpCount:      gcps.value.length,
  poseCount:     poses.value.length,
  sensorCount:   sensors.value.length,
  filmSensorCount: filmSensors.value.length,
  sparseReady:   sparseReady.value,
  depthMapCount: depthMapCount.value,
  cloudReady:    cloudReady.value,
  demReady:      demReady.value,
  orthoReady:    orthoReady.value,
  productReady:  productReady.value,
}))

const hasSparse = computed(() => clouds.value.some((c) => c.kind === 'sparse'))

// UUIDs of images registered (aligned) in the sparse model. Empty until a sparse
// cloud exists — so `hasSparse` gates whether "not in this set" means "unaligned"
// versus "reconstruction hasn't run yet". Used to dim unregistered images.
const alignedUuids = computed(() => new Set(sparseCameras.value.keys()))

// Per-pair count of matches that became tie-points in the sparse model.
// Walk every tie-point's view-track ([uuid, kpIdx] observations); a pair of
// observations (sorted by uuid to match `pairId`) is a "used correspondence"
// of that image pair. Recomputed only when the sparse cloud changes.
const usedMatchesByPair = computed(() => {
  const byPair = new Map()   // pairId → Set("kpA:kpB")
  const sparse = clouds.value.find((c) => c.kind === 'sparse')
  if (!sparse) return byPair
  for (const pt of sparse.points) {
    if (!pt.views || pt.views.size < 2) continue
    const obs = [...pt.views.entries()]              // [[uuid, kpIdx], …]
    for (let i = 0; i < obs.length; i++) {
      for (let j = i + 1; j < obs.length; j++) {
        let [ua, ka] = obs[i]
        let [ub, kb] = obs[j]
        if (ua > ub) { [ua, ka, ub, kb] = [ub, kb, ua, ka] }
        const pid = `${ua}--${ub}`
        let set = byPair.get(pid)
        if (!set) { set = new Set(); byPair.set(pid, set) }
        set.add(`${ka}:${kb}`)
      }
    }
  }
  return byPair
})

const matchSummaries = computed(() => {
  const result = []
  for (const [pid, entry] of matchStore.value) {
    if (entry.status !== 'done' || entry.inlierCount === 0) continue
    const imgA = images.value.find((img) => img.uuid === entry.idA)
    const imgB = images.value.find((img) => img.uuid === entry.idB)
    if (!imgA || !imgB) continue
    result.push({
      pairId:      pid,
      idA:         imgA.id,
      idB:         imgB.id,
      idAUuid:     imgA.uuid,
      idBUuid:     imgB.uuid,
      nameA:       imgA.name,
      nameB:       imgB.name,
      inlierCount: entry.inlierCount,
      rawCount:    entry.rawCount,
      usedCount:   usedMatchesByPair.value.get(pid)?.size ?? 0,
      disabled:    entry.disabled ?? false,
    })
  }
  return result
})

// Imported camera positions keyed by image uuid, in the project working CRS — feeds
// the match graph's optional geographic layout (place nodes where the photos were
// actually taken). Only poses that resolved to an image and carry x/y are included.
const matchNodePositions = computed(() => {
  const out = {}
  const poseByImageId = new Map()
  for (const p of poses.value) {
    if (p.enabled === false || p.imageId == null || p.x == null || p.y == null) continue
    poseByImageId.set(p.imageId, p)
  }
  for (const img of images.value) {
    const p = poseByImageId.get(img.id)
    if (p) out[img.uuid] = { x: p.x, y: p.y }
  }
  return out
})

// Sidebar summary of the pairwise match store: verified/total/running/failed counts.
// `verified` mirrors matchSummaries.length (done + inliers), but we walk the store
// once here to also surface in-flight and failed pairs at a glance.
const matchStats = computed(() => {
  let total = 0, verified = 0, running = 0, error = 0, disabled = 0, weak = 0
  for (const [, entry] of matchStore.value) {
    total++
    if (entry.status === 'running') running++
    else if (entry.status === 'error') error++
    else if (entry.status === 'done' && entry.inlierCount > 0) {
      // A user-excluded pair is still geometrically verified, but it won't feed
      // reconstruction — count it separately so "verified" reflects usable pairs.
      // A weak pair (valid F below the accept gate) is a PnP-only bridge, not
      // verified geometry — counted apart too.
      if (entry.disabled) disabled++
      else if (entry.weak) weak++
      else verified++
    }
  }
  // Pairs that contributed at least one tie-point to the sparse model (0 until
  // reconstruction has run).
  const used = hasSparse.value ? usedMatchesByPair.value.size : null
  return { total, verified, running, error, used, disabled, weak }
})

const activeImageViewState = computed(() => {
  const tab = activeTab.value
  if (!tab || tab.type !== 'image') return null
  const img = imageById(tab.imageId)
  if (!img) return null
  const prefs = imageViewPrefs.value
  return {
    showKeypoints: showKeypointsFor(img),
    showMask:      prefs.showMask,
    showDepth:     prefs.showDepth,
    showGcps:      prefs.showGcps,
    showResiduals: prefs.showResiduals,
    showFiducials: prefs.showFiducials,
    isFilm:        sensorForImage(tab.imageId)?.kind === 'film',
    maskEdit:      prefs.maskEdit,
    gcpEdit:       prefs.gcpEdit,
    kpStatus:      img.kpStatus,
    kpCount:       img.kpCount,
    hasMask:       !!img.mask,
    hasDepth:      !!img.depth,
    gcpCount:      activeImageGcps.value.length,
    fidCount:      (img.fiducialObs?.length ?? 0),
  }
})

// GCP observations falling on the active image tab (for marker overlay), each
// tagged with its live reprojection error (px) from the accuracy report so the
// viewer can flag a bad mark.
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
    cam, reconstructionStore.mainSparseCloud?.points ?? [], img.uuid,
    canonicalToScanFor(img, cam),
  )
})

// The residual overlay draws computed (pinhole-frame) pixels on the RAW image, so it
// has to undo what ingest folded out: the distortion bags and, for a film scan, the
// scan→canonical affine. Returns null when the image needs neither — the common
// EXIF-only digital case, where the overlay is already in the right frame.
function canonicalToScanFor(img, cam) {
  const summary = reconstructionStore.summary
  const sensor = img.sensorId ? sensors.value.find((s) => s.id === img.sensorId) : null
  return makeCanonicalToScan({
    K: cam.K,
    dist: sensor ? distortionOf(sensor) : null,
    selfCal: (summary?.selfCalDistortion ?? []).find((d) => d.sensorId === img.sensorId) ?? null,
    fiducial: (summary?.fiducialTransforms ?? []).find((t) => t.uuid === img.uuid) ?? null,
  })
}

const activeImageGcps = computed(() => {
  const tab = activeTab.value
  if (!tab || tab.type !== 'image') return []
  const out = []
  for (const g of gcps.value) {
    if (g.enabled === false) continue
    const rep = gcpReport.value.find((r) => r.gcpId === g.id)
    for (const obs of g.observations || []) {
      if (obs.imageId === tab.imageId && obs.px != null && obs.py != null) {
        const reprojPx = rep?.observations?.find((o) => o.imageId === obs.imageId)?.reprojPx ?? null
        out.push({ id: g.id, name: g.name, px: obs.px, py: obs.py, reprojPx })
      }
    }
  }
  return out
})

// Guided marking: for GCPs *not yet* marked on the active image, where the
// current cloud's poses say they must lie — a predicted pixel (≥2 other
// observations) or an epipolar line (exactly 1). Async (triangulation goes
// through wasm), so a token drops out-of-order results; empty unless the image
// is registered and the GCP overlay is being looked at.
const activeImageGcpGuides = ref([])
let guideToken = 0
// Guides follow `gcpEdit` alone, NOT `showGcps`. They are an aiming aid for
// *placing* a mark, so they have no purpose while merely viewing GCPs — and since
// turning gcpEdit on force-enables showGcps (see the ribbon command), gating on
// `showGcps || gcpEdit` left the guides drawn after the user switched editing off.
async function refreshGcpGuides() {
  const tab = activeTab.value
  if (tab?.type !== 'image' || !imageViewPrefs.value.gcpEdit) {
    activeImageGcpGuides.value = []
    return
  }
  const token = ++guideToken
  const res = await gcpGuides(tab.imageId)
  if (token === guideToken) activeImageGcpGuides.value = res
}
// Two watchers below feed one refresh, and a single user action commonly trips
// both (adding/marking a GCP mutates `gcps` *and* selects it), which ran the
// guides twice and double-logged every line. They can't merge into one watcher:
// a combined `deep: true` would deep-traverse `sparseCameras`. So coalesce —
// at most one refresh per tick, after both watchers have fired.
let guideRefreshQueued = false
function queueGcpGuidesRefresh() {
  if (guideRefreshQueued) return
  guideRefreshQueued = true
  nextTick(() => { guideRefreshQueued = false; refreshGcpGuides() })
}
// Cameras change on a rebuild (`sparseCameras` is a fresh Map), so a shallow
// watch catches it — no deep traversal of every camera's R/t/K.
// Not selectedGcpId: the guide set doesn't depend on it (every unmarked GCP gets
// one; selection only changes which are drawn boldly, which is ViewerImage's own
// prop). Watching it here just recomputed the identical set on every row click.
watch(
  [() => activeTab.value?.imageId, () => imageViewPrefs.value.gcpEdit, sparseCameras],
  queueGcpGuidesRefresh,
  { immediate: true },
)
// Marks mutate in place, so this one needs to be deep — it's what retires a
// guide the moment its GCP is marked on this image.
watch(gcps, queueGcpGuidesRefresh, { deep: true })

// Just [{ id, name }] of every GCP — the image viewer's right-click "assign to
// existing" submenu.
const allGcpsBrief = computed(() => gcps.value.map((g) => ({ id: g.id, name: g.name })))

// Resolve the (film) sensor for an image id — feeds the viewer's fiducial menu.
function sensorForImage(imageId) {
  const img = imageById(imageId)
  return img?.sensorId ? sensors.value.find((s) => s.id === img.sensorId) : null
}

// ── Viewer ref (for imperative point-cloud updates) ───────────────────────────
const viewerRef = ref(null)
const mapViewerRef = ref(null)

// Estimated scene "up" from the reconstruction's camera poses — passed to Viewer3D so
// a dense/mesh cloud (which carries no cameras of its own) still frames level, the
// same way COLMAP/Metashape orient the view (see estimateUpFromCameras). Derived from
// the sparse cameras, so it's stable across sparse↔dense↔mesh selections.
const viewerSceneUp = computed(() => estimateUpFromCameras(sparseCameras.value))

// Push the selected point cloud into the 3D viewer. Reference changes on select,
// rebuild (a fresh object replaces the sparse cloud), and restore.
//
// Building the Three.js scene (point buffers + per-camera frustum geometry/textures)
// is heavy main-thread work, so we only do it while the 3D tab is actually shown.
// Selecting/restoring a cloud while working in an image/map tab just stashes it as
// `pendingScene`; it's flushed when the viewer tab becomes active. This keeps that
// cost off the critical path (e.g. project restore lands on a different tab, or the
// user selects clouds from the sidebar while in 2D).
let pendingScene = null // { cameras, data } — the scene owed to the (possibly hidden) viewer
function flushScene() {
  if (!pendingScene) return
  const { cameras, data } = pendingScene
  pendingScene = null
  if (data == null) viewerRef.value?.clearReconstructionData()
  else viewerRef.value?.setReconstructionData(cameras, data)
}
watch(selectedCloud, (c) => {
  // Dense clouds are flat typed arrays; sparse clouds are point-object arrays; mesh
  // clouds are indexed triangle buffers. The viewer accepts all three (it hands the
  // dense/mesh position buffers straight to Three.js).
  let data = null
  const cameras = c?.cameras ?? new Map()
  if (c) {
    if (c.kind === 'dense') data = { count: c.count, pos: c.pos, col: c.col }
    else if (c.kind === 'mesh') data = { kind: 'mesh', nVerts: c.nVerts, count: c.count, pos: c.pos, idx: c.idx, col: c.col }
    else data = c.points
  }
  pendingScene = { cameras, data }
  if (activeTabId.value === 'viewer') flushScene()
})
// Build any scene owed to the viewer the moment its tab is shown.
watch(activeTabId, (id) => { if (id === 'viewer') flushScene() })

// ── 3D scene display toggles ───────────────────────────────────────────────────
const showCameras = ref(true)
const showGrid = ref(true)
// ── Map display toggles ────────────────────────────────────────────────────────
// The footprint layer master toggle (ribbon). Defaults on so a freshly computed
// or imported shapefile set is visible immediately; per-set visibility is the
// finer control (each set's `onMap` flag, toggled from its sidebar row). The
// layer only ever holds polygons from sets the user has kept on the map, so this
// no longer clutters a bare basemap.
const showFootprints = ref(true)
const showMapGrid = ref(true)

// ── Console ───────────────────────────────────────────────────────────────────
// True while a project is being restored — drives the interaction-blocking overlay.
// Project lifecycle: open / create / switch / delete, folder-backed storage,
// `.websfm` save+load, and the blocking load overlay they all share. Tabs and the
// 3D scene live here, so those two resets are injected.
const {
  projectLoading, projectLoadingProgress, projectLoadingLabel,
  resetInMemoryProject,
  handleCreateProject, handleCancelNewProject,
  folderPrompt, folderPromptProject,
  onFolderConnect, onFolderRepick, openProjectFolder,
  moveCurrentProjectToFolder, moveCurrentProjectToBrowser,
  onSaveProject, importProjectFile, onProjectFilePick,
  handleSwitchProject, handleDeleteProject,
} = useProjectLifecycle({
  resetToViewer,
  clearViewerScene: () => viewerRef.value?.clearReconstructionData(),
})

const consoleOpen = ref(localStorage.getItem('consoleOpen') === 'true')
watch(consoleOpen, (v) => localStorage.setItem('consoleOpen', v))

// ── Bootstrap ─────────────────────────────────────────────────────────────────
onMounted(async () => {
  applyTheme(theme.value)
  window.addEventListener('keydown', (e) => {
    if (e.key === '`' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      consoleOpen.value = !consoleOpen.value
    } else if (e.key === 'Escape') {
      if (tabCtx.value) closeTabCtx()
      else if (!closeTopModal()) {
        // Nothing modal to dismiss — Escape exits mask/GCP-edit mode on the active tab.
        const tab = activeTab.value
        if (tab?.type === 'image' && imageViewPrefs.value.maskEdit) patchImageView({ maskEdit: false })
        else if (tab?.type === 'image' && imageViewPrefs.value.gcpEdit) patchImageView({ gcpEdit: false })
      }
    }
  })
  document.addEventListener('click', () => { if (tabCtx.value) closeTabCtx() })

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

// ── Coordinate system ─────────────────────────────────────────────────────────
async function handleSetCrs(crs) {
  if (!currentProjectId.value) return
  await ensureProjection(crs).catch(() => {})
  await setProjectCrs(currentProjectId.value, crs, async (prevCrs, newCrs) => {
    await reprojectGcps(prevCrs, newCrs)
    await reprojectFootprints(prevCrs, newCrs)
    await reprojectPoses(prevCrs, newCrs)
  })
}

// ── Import (dropped / picked files) ──────────────────────────────────────────────
// The whole import funnel lives in useImportRouting; it drives the import modals
// (state in useModalsStore) and commits through these store actions.
const { importSession: sfmImportSession, openImport: openSfmImport, closeImport: closeSfmImport, commitImport: commitSfmImport } = useSfmInterop({
  addImages, importColmapModel, importInteropModel, activateTab,
})

const {
  cameraPickMode,
  openImportFile, openDroppedImport, routeImport,
  onImportKindChosen, onImportSwitchKind,
  onCloudImport, onCloudPick,
  openRasterImport, onRasterPick, addImagesRouted,
  openCameraImport, onCameraImport, onGcpImport, onFootprintImport,
  onGcpPick, onCameraPick, onColmapPick,
} = useImportRouting({
  addGcps, addFootprints, addSensors, addPoses, addFiducialObs: addFiducialObservations,
  importColmap: importColmapModel, importCloud,
  openSfmProject: openSfmImport,
  // A dropped `.tif` arrives as `image/tiff` and would otherwise be ingested as
  // a source photo, so the image path is routed through the georeference fork.
  importRaster, addImages, importProjectFile,
  activateTab,
  showGcps: () => { gcpTableOpen.value = true },
  showSensors: () => { sensorTableOpen.value = true },
  showPoses: () => { poseTableOpen.value = true },
})

// Switch to the map and centre it on an image's position (pose or EXIF GPS).
function zoomToImagePosition(imgId) {
  activateTab('map')
  nextTick(() => mapViewerRef.value?.zoomToImage(imgId))
}

// Footprints from imported camera poses: build one "footprints" set, then open
// the map and zoom to it so the result is immediately visible (and any "they
// landed somewhere unexpected" problem is obvious).
function onFootprintFromPoses(settings) {
  footprintFromPosesOpen.value = false
  const { computed: n, setId } = computeFootprints(settings)
  if (n > 0 && setId) zoomToShapefile(setId)
}

// Switch to the map and fit the view to a shapefile set's extent.
function zoomToShapefile(id) {
  const set = shapefiles.value.find((s) => s.id === id)
  if (!set) return
  activateTab('map')
  nextTick(() => mapViewerRef.value?.zoomToFootprints(set.footprints))
}

// ── Export (camera params + products) ───────────────────────────────────────────
const {
  exportKind, exportPoses, exportSensors, exportKeypoints, exportMatches, onExportRun,
} = useExports({
  poses, sensors, images, matchStore, clouds, selectedCloud, mainSparseCloud, dem, ortho,
  georef, currentProjectName, currentCrs, summary: reconSummary, progress: exportProgress,
})

// ── Pipeline handlers (close modal, then delegate to usePipeline) ─────────────
function onDetectRun(settings)      { detectFeaturesOpen.value = false;  runDetect(settings)      }
function onMatchRun(settings)       { matchFeaturesOpen.value  = false;  runMatch(settings)       }
// A Georeference request may hand off to the normal reconstruction dialog so the
// user retains control over its settings. Only after a successful sparse run do we
// fit the final SfM→project-CRS similarity.
const georeferenceAfterReconstruct = ref(false)
function closeReconstructModal() {
  reconstructOpen.value = false
  georeferenceAfterReconstruct.value = false
}
async function onReconstructRun(settings) {
  const finishGeoreference = georeferenceAfterReconstruct.value
  reconstructOpen.value = false
  georeferenceAfterReconstruct.value = false
  await runReconstruct(settings)
  if (finishGeoreference && reconStatus.value === 'done') {
    await georeference()
    await refreshGcpReport()
  }
  if (reconStatus.value === 'done') {
    // The store retired products tied to the previous camera solution; do not leave
    // tabs open with a null backing raster.
    for (const tab of [...tabs.value]) if (tab.type === 'product') closeTab(tab.id)
  }
}

async function onGeoreferenceRun({ mode }) {
  georeferenceOpen.value = false
  if (mode === 'adjust') {
    georeferenceAfterReconstruct.value = true
    reconstructOpen.value = true
    return
  }
  await georeference()
  await refreshGcpReport()
}

// Open an image from the Mask Manager and drop straight into mask-edit mode.
function editMask(id) {
  maskManagerOpen.value = false
  openImageTab(id)
  patchImageView({ showDepth: false, maskEdit: true, gcpEdit: false })
}
function onDepthMapsRun(settings)   { depthMapsOpen.value      = false;  runComputeDepthMaps(settings) }
function onDenseRun(settings)       { denseOpen.value          = false;  runDensify(settings) }
// Products: generation just produces the product; the user opens it via the
// Products sidebar section (double-click / "Open in tab") when they want to inspect it.
async function onDemRun(settings)   { demOpen.value = false;   await runGenerateDem(settings) }
async function onOrthoRun(settings) { orthoOpen.value = false; await runGenerateOrtho(settings) }
async function onMeshRun(settings)  { meshOpen.value = false;  await runGenerateMesh(settings) }
// Cloud editing. Each modal emits a ready-made request ({ sourceIds, settings, name });
// the mode is fixed by which modal sent it. Always adds a new cloud — non-destructive.
async function onCropCloudRun(req)   { cropCloudOpen.value = false;   await runEditClouds({ ...req, mode: 'crop' }) }
async function onFilterCloudRun(req) { filterCloudOpen.value = false; await runEditClouds({ ...req, mode: 'filter' }) }
async function onMergeCloudsRun(req) { mergeCloudsOpen.value = false; await runEditClouds({ ...req, mode: 'merge' }) }

// ── Confirm-before-destroy ────────────────────────────────────────────────────
// Every irreversible action (remove image / sensor / cloud / raster / GCP /
// shapefile, clear keypoints) routes through one of the two dialogs owned here.
// Tabs live in App.vue, so the close-the-subject's-tab callbacks are injected.
const {
  pendingImageDelete, requestRemoveImages, confirmRemoveImages, deleteMessage,
  pendingConfirm, askConfirm, runPendingConfirm,
  confirmRemoveSensor, confirmRemoveCloud, confirmRemoveRaster,
  confirmRemoveGcp, confirmRemoveShapefile, confirmClearKeypoints,
} = useConfirmations({ closeTabForImage, closeTabForRaster, removeGcpAndCloseTab })

// Escape-closes-top-most-modal (pulls modal state from the stores; the few local
// bits are injected). Used by the global keydown handler in the bootstrap below.
const { closeTopModal } = useModalEscape({
  pendingImageDelete, exportKind, onCancelNewProject: handleCancelNewProject,
})

// Autosaved idle sessions can close quietly. Prompt only while closing would
// interrupt compute, project I/O, or an import whose source bytes are not yet safe.
useBeforeUnload(() => progressOpen.value || projectLoading.value
  || pendingImageWork.value > 0 || pendingRasterWork.value > 0)

// Open an imported reference raster in its own tab. The tab opens immediately
// (the preview PNG is in the index, so there's something to look at at once) and
// the full plane hydrates behind it — a REMA tile is hundreds of MB and must not
// block the tab switch.
function openRasterTab(id) {
  const meta = externalStore.rasterById(id)
  if (!meta) return
  openRasterTabRaw(id, meta.name)
  externalStore.ensureRasterLoaded(id)
}

// The import modal's escape hatch: the geokey sniff said "reference raster" but
// this really is a source photo (a georeferenced aerial frame is unusual, not
// impossible — and a scan carrying a degenerate identity geotransform trips it).
// Pull the original back out, hand it to the image ingest, and drop the
// reference-data record.
//
// Via the store, NOT opfs directly: `external/{id}.src` is only written when the
// project persists, so in a non-persisting project the sole copy is the in-memory
// one the store holds — reading OPFS here made the escape hatch fail on exactly
// the freshly-imported raster the user was trying to rescue.
async function onRasterImportAsImage({ id }) {
  const meta = externalStore.rasterById(id)
  if (!meta) return
  importRasterOpen.value = false
  importRasterData.value = null
  const file = await externalStore.originalFile(id)
  if (!file) {
    log(`Could not re-read "${meta.name}" to import it as an image — re-add the file.`, 'warn', 'Import')
    return
  }
  // Reachable from the Reference Data right-click too, where the raster may have
  // an open tab — it would otherwise linger showing an empty viewer.
  closeTabForRaster(id)
  await removeRaster(id)
  addImages([new File([file], meta.name, { type: 'image/tiff' })])
}

// The mirror of onRasterImportAsImage: a GeoTIFF that the ingest-time geokey
// sniff sent down the source-photo path (tags written in a form geotiff.js
// couldn't read, or absent when the user expected them). Re-read the original
// TIFF out of OPFS, import it as a reference raster, and drop the image entry —
// but ONLY if the raster import actually succeeded, so a file with no
// geotransform stays where it is instead of vanishing from both sections.
async function convertImageToRaster(imageId) {
  const img = imageById(imageId)
  if (!img) return
  askConfirm({
    title: 'Convert to reference data?',
    message: `Re-import “${img.name}” as an imported DEM / orthophoto? It is removed from `
      + 'the source images, along with its keypoints, mask, depth map and matches.',
    confirmLabel: 'Convert',
    onConfirm: async () => {
      // Two sources for the ORIGINAL TIFF, and both are needed: a freshly added
      // image still holds its File in memory (and in a non-persisting project
      // that is the ONLY copy — addImages only writes to OPFS when persisting),
      // while a restored image has `file: null` and lives in OPFS. Note the OPFS
      // key is `uuid`, NOT `id` (which is name-size-lastModified) — getFileHandle
      // throws NotFoundError rather than returning null, so this must be caught.
      let file = img.file
      if (!file) {
        try {
          const blob = await opfs.loadImageBlob(projects.currentProjectId, img.uuid)
          if (blob) file = new File([blob], img.name, { type: 'image/tiff' })
        } catch { /* fall through to the warning below */ }
      }
      if (!file) {
        log(`Could not re-read “${img.name}” to convert it — re-add the file.`, 'warn', 'Import')
        return
      }
      // alwaysConfirm: the auto-sniff already declined this file once, so its
      // DEM-vs-ortho guess has not earned a silent import here.
      const record = await openRasterImport(file, { alwaysConfirm: true })
      if (!record) return // importRaster already logged why; keep the image
      removeImage(imageId, closeTabForImage)
    },
  })
}

// The raster the Style modal is editing, resolved live from the store: a
// restyle replaces the record, so holding the object would leave the modal
// showing the pre-restyle preview.
const rasterBeingStyled = computed(() =>
  rasterStyleId.value ? externalStore.rasterById(rasterStyleId.value) : null)

async function onRasterStyleApply({ id, style }) {
  rasterStyleId.value = null
  await setRasterStyle(id, style)
}

// ── ImageViewer refs (for imperative mask ops) ────────────────────────────────
const imageViewerRefs = reactive({})

// ── Raster tabs (DEM / orthophoto / imported reference) ───────────────────────
// One ProductViewer ref per open raster tab, for the Ribbon's contextual tab to
// drive fit/zoom imperatively (mirrors imageViewerRefs).
const productViewerRefs = reactive({})

// The raster tab in front, if any — the Ribbon's contextual-tab trigger and the
// target of every `raster-*` command. A computed product has no id/name of its
// own; an imported one carries its record so the tab can label + restyle it.
const activeRasterTab = computed(() => {
  const tab = activeTab.value
  if (tab?.type === 'product') {
    return { tabId: tab.id, kind: tab.productKind, imported: false, name: tab.title }
  }
  if (tab?.type === 'raster') {
    const r = rasterById(tab.rasterId)
    return {
      tabId: tab.id,
      rasterId: tab.rasterId,
      kind: r?.kind ?? 'dem',
      imported: true,
      name: r?.name ?? 'Raster',
      onMap: !!r?.onMap,
    }
  }
  return null
})

function activeProductViewer() {
  const t = activeRasterTab.value
  return t ? productViewerRefs[t.tabId] ?? null : null
}
const ribbonInput = ref(null)
const gcpInput = ref(null)
const cameraInput = ref(null)
const colmapInput = ref(null)
const sfmFolderInput = ref(null)
const sfmSourceOpen = ref(false)
const cloudInput = ref(null)
const rasterInput = ref(null)
const projectFileInput = ref(null)
// cameraPickMode comes from useImportRouting (above); the command dispatch sets it
// before opening the hidden camera-file <input>.

// ── Commands ──────────────────────────────────────────────────────────────────

// Commands whose entire effect is "open this modal", as data rather than 22
// identical switch cases. A new pipeline modal is one line here. Anything with a
// guard, a toggle, or a side effect (open-gcp-table also refreshes the report;
// open-project-picker toggles) stays an explicit case below — the table is for the
// trivial ones only, so it never hides behaviour.
const MODAL_COMMANDS = {
  'save-project-file':     saveProjectOpen,
  'open-image-table':      imageTableOpen,
  'open-pose-table':       poseTableOpen,
  'open-mask-manager':     maskManagerOpen,
  'auto-mask':             autoMaskOpen,
  'open-sensor-table':     sensorTableOpen,
  'open-match-list':       matchListOpen,
  'detect-features':       detectFeaturesOpen,
  'match-features':        matchFeaturesOpen,
  'reconstruct':           reconstructOpen,
  'find-gcps':             findGcpsOpen,
  'georeference':          georeferenceOpen,
  'compute-depth':         depthMapsOpen,
  'dense':                 denseOpen,
  'gen-dem':               demOpen,
  'gen-ortho':             orthoOpen,
  'gen-mesh':              meshOpen,
  'filter-cloud':          filterCloudOpen,
  'crop-cloud':            cropCloudOpen,
  'merge-clouds':          mergeCloudsOpen,
  'footprints-from-poses': footprintFromPosesOpen,
  'open-settings':         settingsOpen,
  'open-project-settings': projectSettingsOpen,
  'open-about':            aboutOpen,
  'open-system-info':      systemInfoOpen,
  'open-debug-summary':    debugSummaryOpen,
}

// Quality Report hub deep-links. The old per-view command ids are kept so muscle
// memory and existing logs stay valid (PLAN-eval-quality-hub WS0); several map to
// one section.
const EVAL_SECTIONS = {
  'eval-overview':       'overview',
  'eval-reconstruction': 'sparse',
  'eval-images':         'sparse',
  'eval-calibration':    'calibration',
  'eval-gcps':           'accuracy',
  'eval-poses':          'accuracy',
  'eval-dem-gcps':       'accuracy',
  'eval-match-graph':    'matching',
  'eval-coverage':       'coverage',
  'eval-depth-coverage': 'dense',
}

function handleCommand(id) {
  const modal = MODAL_COMMANDS[id]
  if (modal) { modal.value = true; return }
  if (EVAL_SECTIONS[id]) { openQuality(EVAL_SECTIONS[id]); return }
  // 3D view presets: 'view-preset-top' → setView('top').
  if (id.startsWith('view-preset-')) { viewerRef.value?.setView(id.slice('view-preset-'.length)); return }

  switch (id) {
    case 'import-images':        ribbonInput.value.click(); break
    case 'import-gcps':          gcpInput.value.click(); break
    case 'import-camera-list':   cameraPickMode.value = 'pose';   cameraInput.value.click(); break
    case 'import-calib':         cameraPickMode.value = 'sensor'; cameraInput.value.click(); break
    case 'import-colmap':        sfmSourceOpen.value = true; break
    case 'import-cloud':         cloudInput.value.click(); break
    case 'import-raster':        rasterInput.value.click(); break
    case 'export-cameras':       exportPoses(); break
    case 'export-sensors':       exportSensors(); break
    case 'export-cloud':         exportKind.value = 'cloud'; break
    case 'export-mesh':          exportKind.value = 'mesh'; break
    case 'export-model':         exportKind.value = 'model'; break
    case 'export-colmap':        exportKind.value = 'colmap'; break
    case 'export-undistorted':   exportKind.value = 'undistorted'; break
    case 'export-tiles3d':       exportKind.value = 'tiles3d'; break
    case 'export-dem':           exportKind.value = 'dem'; break
    case 'export-ortho':         exportKind.value = 'ortho'; break
    case 'export-keypoints':     exportKeypoints(); break
    case 'export-matches':       exportMatches(); break
    case 'clear-all':            resetInMemoryProject({ purge: true }); break
    case 'remove-selected':      if (selectedId.value) requestRemoveImages(selectedId.value); break
    case 'view-viewer':          activateTab('viewer'); break
    case 'view-map':             activateTab('map'); break
    case 'reset-view':           viewerRef.value?.resetView(); break
    case 'view-toggle-cameras':  showCameras.value = !showCameras.value; break
    case 'view-toggle-grid': showGrid.value = !showGrid.value; break
    case 'map-fit-view':         mapViewerRef.value?.fitView(); break
    case 'map-toggle-grid': showMapGrid.value = !showMapGrid.value; break
    case 'map-toggle-footprints': showFootprints.value = !showFootprints.value; break
    case 'detect-fiducials':     openFiducialDetect(); break
    case 'calibrate-fiducials':  openFiducialCalibrate(); break
    case 'open-gcp-table':       gcpTableOpen.value = true; refreshGcpReport(); break
    // Legacy command id retained for saved console history / older integrations.
    case 'auto-georeference':    georeferenceOpen.value = true; break
    case 'open-glossary':        glossaryStore.openHome(); break
    case 'open-guide':           guideStore.openHome(); break
    case 'open-project-picker':  projectPickerOpen.value = !projectPickerOpen.value; break
    case 'toggle-console':       consoleOpen.value = !consoleOpen.value; break
    case 'raster-fit':           activeProductViewer()?.fit(); break
    case 'raster-zoom-in':       activeProductViewer()?.zoomBy(1.4); break
    case 'raster-zoom-out':      activeProductViewer()?.zoomBy(1 / 1.4); break
    case 'raster-style':         if (activeRasterTab.value?.rasterId) rasterStyleId.value = activeRasterTab.value.rasterId; break
    case 'raster-toggle-map': {
      const r = activeRasterTab.value
      if (r?.rasterId) setRasterOnMap(r.rasterId, !r.onMap)
      break
    }
    case 'raster-remove':        if (activeRasterTab.value?.rasterId) confirmRemoveRaster(activeRasterTab.value.rasterId); break
    case 'img-show-info':        if (activeImageTab.value) infoImageId.value = activeImageTab.value.id; break
    case 'img-remove':           if (activeImageTab.value) requestRemoveImages(activeImageTab.value.id); break
    case 'img-toggle-keypoints': {
      // The toggle is global, but the overlay only draws on detected images
      // (showKeypointsFor), so flipping it here reads the preference, not the gate.
      if (activeTab.value?.type === 'image') patchImageView({ showKeypoints: !imageViewPrefs.value.showKeypoints })
      break
    }
    case 'img-toggle-mask': {
      // Mask and depth overlays are mutually exclusive — turning one on clears the other.
      if (activeTab.value?.type === 'image') {
        const on = !imageViewPrefs.value.showMask
        patchImageView({ showMask: on, ...(on ? { showDepth: false } : {}) })
      }
      break
    }
    case 'img-toggle-depth': {
      if (activeTab.value?.type === 'image') {
        const on = !imageViewPrefs.value.showDepth
        patchImageView({ showDepth: on, ...(on ? { showMask: false } : {}) })
      }
      break
    }
    case 'img-toggle-gcps': {
      if (activeTab.value?.type === 'image') patchImageView({ showGcps: !imageViewPrefs.value.showGcps })
      break
    }
    case 'img-toggle-residuals': {
      if (activeTab.value?.type === 'image') patchImageView({ showResiduals: !imageViewPrefs.value.showResiduals })
      break
    }
    case 'img-toggle-fiducials': {
      if (activeTab.value?.type === 'image') patchImageView({ showFiducials: !imageViewPrefs.value.showFiducials })
      break
    }
    case 'img-mask-edit': {
      if (activeTab.value?.type === 'image') {
        const on = !imageViewPrefs.value.maskEdit
        // Mask-edit mode always renders the mask overlay itself (ViewerImage keys
        // it on `showMask || maskEdit`), so don't touch the user's showMask toggle
        // here — just make sure depth (mutually exclusive) is off while editing.
        patchImageView({ maskEdit: on, ...(on ? { showDepth: false, gcpEdit: false } : {}) })
      }
      break
    }
    case 'img-gcp-edit': {
      if (activeTab.value?.type === 'image') {
        const on = !imageViewPrefs.value.gcpEdit
        // GCP-edit needs the markers visible and is mutually exclusive with mask
        // editing; leave depth alone (GCPs draw over it fine).
        patchImageView({ gcpEdit: on, ...(on ? { showGcps: true, maskEdit: false } : {}) })
      }
      break
    }
  }
}

function onRibbonPick(event) {
  const files = [...event.target.files].filter((f) => f.type.startsWith('image/'))
  // Same georeference fork as the drop path: a picked GeoTIFF DEM is reference
  // data, not a source photo, and it arrives here as `image/tiff`.
  if (files.length) addImagesRouted(files)
  event.target.value = ''
}
</script>

<template>
  <div class="app">
    <BrowserWarning />
    <ToastStack />
    <Ribbon
      :active-view="activeView"
      :has-selection="!!selected"
      :image-count="images.length"
      :images-loading="imagesLoading"
      :match-count="matchSummaries.length"
      :kp-image-count="kpImageCount"
      :gcp-count="gcps.length"
      :pose-count="poses.length"
      :sensor-count="sensors.length"
      :film-sensor-count="filmSensors.length"
      :sparse-ready="sparseReady"
      :depth-map-count="depthMapCount"
      :cloud-ready="cloudReady"
      :dense-ready="denseReady"
      :editable-cloud-count="editableClouds.length"
      :mesh-ready="meshReady"
      :dem-ready="demReady"
      :ortho-ready="orthoReady"
      :product-ready="productReady"
      :active-image-id="activeImageTab?.id ?? null"
      :active-image-name="activeImageTab?.name ?? null"
      :image-view-state="activeImageViewState"
      :active-raster="activeRasterTab"
      :console-open="consoleOpen"
      :persistence-enabled="persistenceAvailable"
      :current-project-name="currentProjectName"
      :scene-type="currentSceneType"
      :show-cameras="showCameras"
      :show-grid="showGrid"
      :show-map-grid="showMapGrid"
      :show-footprints="showFootprints"
      :footprint-count="footprintCount"
      @command="handleCommand"
    />
    <input ref="ribbonInput" type="file" accept="image/*" multiple hidden @change="onRibbonPick" />
    <input ref="gcpInput" type="file" accept=".csv,.txt,.tsv,.gcp,.pts,.geojson,.json,application/geo+json,text/*" hidden @change="onGcpPick" />
    <input ref="cameraInput" type="file" accept=".csv,.txt,.tsv,.cam,text/*" hidden @change="onCameraPick" />
    <input ref="colmapInput" type="file" accept=".db,.sqlite,.txt,.bin,.zip,.json,.nvm" multiple hidden @change="(e) => { sfmSourceOpen = false; onColmapPick(e) }" />
    <input ref="sfmFolderInput" type="file" webkitdirectory multiple hidden @change="(e) => { sfmSourceOpen = false; onColmapPick(e) }" />
    <input ref="cloudInput" type="file" accept=".ply,.las,.laz,.xyz,.pts" hidden @change="onCloudPick" />
    <input ref="rasterInput" type="file" accept=".tif,.tiff" hidden @change="onRasterPick" />
    <input ref="projectFileInput" type="file" accept=".websfm,.zip" hidden @change="onProjectFilePick" />

    <div v-if="projectPickerOpen && !currentProjectId" class="project-backdrop" />

    <div v-if="projectLoading" class="loading-overlay">
      <div class="loading-card">
        <div class="loading-spinner" />
        <div class="loading-text">
          <span>{{ projectLoadingLabel }}</span>
          <span v-if="projectLoadingProgress" class="loading-detail">
            <template v-if="projectLoadingProgress.total">
              Loading image {{ projectLoadingProgress.done }}/{{ projectLoadingProgress.total }}
              — {{ projectLoadingProgress.label }}
            </template>
            <template v-else>{{ projectLoadingProgress.label }}</template>
          </span>
        </div>
      </div>
    </div>

    <ProjectPicker
      v-if="projectPickerOpen"
      :projects="projects"
      :current-project-id="currentProjectId"
      :dismissible="!!currentProjectId"
      :folder-supported="folderSupported"
      @switch="handleSwitchProject"
      @rename="(id, name) => renameProject(id, name)"
      @delete="handleDeleteProject"
      @new="() => { projectPickerOpen = false; newProjectCanCancel = true; newProjectOpen = true }"
      @open-file="projectFileInput.click()"
      @open-folder="() => { projectPickerOpen = false; openProjectFolder() }"
      @save-copy="() => { projectPickerOpen = false; saveProjectOpen = true }"
      @move-to-folder="(id) => { projectPickerOpen = false; moveCurrentProjectToFolder(id) }"
      @move-to-browser="(id) => { projectPickerOpen = false; moveCurrentProjectToBrowser(id) }"
      @settings="() => { projectPickerOpen = false; projectSettingsOpen = true }"
      @close="projectPickerOpen = false"
    />

    <Teleport to="body">
      <DetectFeaturesModal
        v-if="detectFeaturesOpen"
        :images="images"
        @close="detectFeaturesOpen = false"
        @run="onDetectRun"
      />
    </Teleport>

    <Teleport to="body">
      <MatchFeaturesModal
        v-if="matchFeaturesOpen"
        :detected-max-keypoints="detectedMaxKeypoints"
        :posed-image-count="posedImageCount"
        :footprint-image-count="footprintImageCount"
        @close="matchFeaturesOpen = false"
        @run="onMatchRun"
      />
    </Teleport>

    <Teleport to="body">
      <ReconstructModal
        v-if="reconstructOpen"
        :ground-control-adjustment="georeferenceAfterReconstruct"
        @close="closeReconstructModal"
        @run="onReconstructRun"
      />
    </Teleport>

    <Teleport to="body">
      <FindGcpsModal
        v-if="findGcpsOpen"
        :has-relative-ortho="!!ortho"
        :reference-orthos="referenceOrthos"
        @close="findGcpsOpen = false"
      />
    </Teleport>

    <Teleport to="body">
      <GeoreferenceModal
        v-if="georeferenceOpen"
        :can-adjust-with-gcps="canGeoreferenceGcps && canGeoreference"
        :can-transform="canGeoreference"
        :has-matches="matchSummaries.length > 0"
        :gcp-count="gcps.length"
        :pose-count="poses.length"
        :project-crs="currentCrs"
        @close="georeferenceOpen = false"
        @run="onGeoreferenceRun"
      />
    </Teleport>

    <Teleport to="body">
      <InteropSourceModal
        v-if="sfmSourceOpen"
        @close="sfmSourceOpen = false"
        @files="colmapInput.click()"
        @folder="sfmFolderInput.click()"
      />
    </Teleport>

    <Teleport to="body">
      <InteropImportModal
        v-if="sfmImportSession"
        :session="sfmImportSession"
        @close="closeSfmImport"
        @run="commitSfmImport"
      />
    </Teleport>

    <Teleport to="body">
      <ExportModal
        v-if="exportKind"
        :kind="exportKind"
        :has-georef="!!georef"
        @close="exportKind = null"
        @run="onExportRun"
      />
    </Teleport>

    <Teleport to="body">
      <DepthMapsModal
        v-if="depthMapsOpen"
        @close="depthMapsOpen = false"
        @run="onDepthMapsRun"
      />
    </Teleport>

    <Teleport to="body">
      <DenseModal
        v-if="denseOpen"
        @close="denseOpen = false"
        @run="onDenseRun"
      />
    </Teleport>

    <Teleport to="body">
      <DemModal
        v-if="demOpen"
        :can-georeference="canGeoreference"
        :project-crs="currentCrs"
        @close="demOpen = false"
        @run="onDemRun"
      />
    </Teleport>

    <Teleport to="body">
      <ConfirmModal
        v-if="pendingImageDelete"
        :title="pendingImageDelete.ids.length > 1 ? 'Remove images?' : 'Remove image?'"
        :message="deleteMessage"
        confirm-label="Remove"
        danger
        @confirm="confirmRemoveImages"
        @cancel="pendingImageDelete = null"
      />
    </Teleport>

    <Teleport to="body">
      <ConfirmModal
        v-if="pendingConfirm"
        :title="pendingConfirm.title"
        :message="pendingConfirm.message"
        :confirm-label="pendingConfirm.confirmLabel || 'Remove'"
        danger
        @confirm="runPendingConfirm"
        @cancel="pendingConfirm = null"
      />
    </Teleport>

    <Teleport to="body">
      <OrthoModal
        v-if="orthoOpen"
        :dem-crs="dem?.crs === 'local' || !dem?.crs ? 'local frame' : dem.crs"
        :dem-size="dem ? `${dem.width}×${dem.height}` : null"
        @close="orthoOpen = false"
        @run="onOrthoRun"
      />
    </Teleport>

    <Teleport to="body">
      <MeshModal
        v-if="meshOpen"
        :has-dense="clouds.some((c) => c.kind === 'dense' && c.count > 0)"
        :has-dense-normals="clouds.some((c) => c.kind === 'dense' && !!c.nrm)"
        :dense-count="clouds.find((c) => c.kind === 'dense' && c.count > 0)?.count ?? 0"
        @close="meshOpen = false"
        @run="onMeshRun"
      />
    </Teleport>

    <Teleport to="body">
      <FilterCloudModal
        v-if="filterCloudOpen"
        :clouds="editableClouds"
        :merge-cell="denseSummary?.mergeCell ?? 0"
        @close="filterCloudOpen = false"
        @run="onFilterCloudRun"
      />
    </Teleport>

    <Teleport to="body">
      <CropCloudModal
        v-if="cropCloudOpen"
        :clouds="editableClouds"
        @close="cropCloudOpen = false"
        @run="onCropCloudRun"
      />
    </Teleport>

    <Teleport to="body">
      <MergeCloudsModal
        v-if="mergeCloudsOpen"
        :clouds="editableClouds"
        :merge-cell="denseSummary?.mergeCell ?? 0"
        @close="mergeCloudsOpen = false"
        @run="onMergeCloudsRun"
      />
    </Teleport>

    <Teleport to="body">
      <GcpImportModal
        v-if="gcpImportOpen"
        :raw-text="gcpImportText"
        :file-name="gcpImportName"
        :project-crs="currentCrs"
        :geojson-gcps="gcpImportGeojson"
        :detected-crs="gcpImportCrs"
        :accuracy-defaults="gcpImportDefaults"
        :kind-declared="importKindDeclared"
        @close="gcpImportOpen = false; gcpImportGeojson = null; gcpImportText = ''; gcpImportCrs = null"
        @import="onGcpImport"
        @switch-kind="onImportSwitchKind"
      />
    </Teleport>

    <Teleport to="body">
      <ImportKindModal
        v-if="importKindOpen && importKindFile"
        :file-name="importKindFile.name"
        @close="importKindOpen = false; importKindFile = null"
        @select="onImportKindChosen"
      />
    </Teleport>

    <Teleport to="body">
      <ImportCloudModal
        v-if="importCloudOpen && importCloudData"
        :data="importCloudData"
        @close="importCloudOpen = false; importCloudData = null"
        @run="onCloudImport"
      />
    </Teleport>

    <Teleport to="body">
      <ImportRasterModal
        v-if="importRasterOpen && importRasterData"
        :data="importRasterData"
        @close="importRasterOpen = false; importRasterData = null"
        @set-kind="({ id, kind }) => setRasterKind(id, kind)"
        @set-vertical="({ id, ...v }) => setVerticalInfo(id, v)"
        @import-as-image="onRasterImportAsImage"
      />
    </Teleport>

    <Teleport to="body">
      <RasterStyleModal
        v-if="rasterBeingStyled"
        :raster="rasterBeingStyled"
        @close="rasterStyleId = null"
        @apply="onRasterStyleApply"
      />
    </Teleport>

    <Teleport to="body">
      <FootprintImportModal
        v-if="footprintImportOpen && footprintImportData"
        :features="footprintImportData.features"
        :property-keys="footprintImportData.propertyKeys"
        :detected-crs="footprintImportData.detectedCrs"
        :file-name="footprintImportData.fileName"
        :project-crs="currentCrs"
        :images="images"
        @close="footprintImportOpen = false; footprintImportData = null"
        @import="onFootprintImport"
      />
    </Teleport>

    <Teleport to="body">
      <FootprintFromPosesModal
        v-if="footprintFromPosesOpen"
        :poses="poses"
        :sensors="sensors"
        :images="images"
        :project-crs="currentCrs"
        @close="footprintFromPosesOpen = false"
        @run="onFootprintFromPoses"
      />
    </Teleport>

    <Teleport to="body">
      <CameraImportModal
        v-if="cameraImportOpen"
        :raw-text="cameraImportText"
        :file-name="cameraImportName"
        :project-crs="currentCrs"
        :detected-mode="cameraImportMode"
        :kind-declared="importKindDeclared"
        @close="cameraImportOpen = false"
        @import="onCameraImport"
        @switch-kind="onImportSwitchKind"
      />
    </Teleport>

    <Teleport to="body">
      <ProgressModal
        v-if="progressOpen"
        :title="progressTitle"
        :current="progressCurrent"
        :total="progressTotal"
        :label="progressLabel"
        :unit="progressUnit"
        :fraction="progressFraction"
        :indeterminate="progressIndeterminate"
        :complete="progressComplete"
        :cancelling="progressCancelling"
        :cancelable="true"
        @cancel="cancelRun"
      />
    </Teleport>

    <Teleport to="body">
      <SettingsModal
        v-if="settingsOpen"
        :theme="theme"
        @close="settingsOpen = false"
        @set-theme="setTheme"
      />
      <ProjectSettingsModal
        v-if="projectSettingsOpen && currentProject"
        :project="currentProject"
        :clear-derived="clearCurrentProjectDerived"
        @close="projectSettingsOpen = false"
        @rename="(name) => renameProject(currentProjectId, name)"
        @set-crs="handleSetCrs"
      />
    </Teleport>

    <Teleport to="body">
      <AboutModal v-if="aboutOpen" @close="aboutOpen = false" />
      <SystemInfoModal v-if="systemInfoOpen" @close="systemInfoOpen = false" />
    </Teleport>

    <Teleport to="body">
      <ImageTableModal
        v-if="imageTableOpen"
        :images="images"
        :sensors="sensors"
        :poses="poses"
        :cameras="cameras"
        :crs="currentCrs"
        :selected-id="selectedId"
        @close="imageTableOpen = false"
        @select="selectImage"
        @open="(id) => { openImageTab(id); imageTableOpen = false }"
        @assign-sensor="({ imageId, sensorId }) => assignSensor(imageId, sensorId)"
        @open-sensor-table="imageTableOpen = false; sensorTableOpen = true"
      />

      <CameraPoseTableModal
        v-if="poseTableOpen"
        :poses="poses"
        :crs="currentCrs"
        @close="poseTableOpen = false"
      />

      <MaskManagerModal
        v-if="maskManagerOpen"
        @close="maskManagerOpen = false"
        @edit="editMask"
      />
      <AutoMaskModal
        v-if="autoMaskOpen"
        @close="autoMaskOpen = false"
      />
    </Teleport>

    <Teleport to="body">
      <SensorTableModal
        v-if="sensorTableOpen"
        :sensors="sensors"
        :images="images"
        :cameras="sparseCameras"
        @close="sensorTableOpen = false"
        @update="({ id, field, value }) => updateSensor(id, field, value)"
        @toggle-fixed="({ id, field }) => toggleSensorFixed(id, field)"
        @set-fiducial-marks="({ id, marks }) => setFiducialMarks(id, marks)"
        @detect-fiducials="(id) => { fiducialDetectSensorId = id; fiducialDetectOpen = true }"
        @calibrate-fiducials="(id) => { fiducialCalibrateSensorId = id; fiducialCalibrateOpen = true }"
        @remove="removeSensor"
      />
    </Teleport>

    <Teleport to="body">
      <FiducialCalibrateModal
        v-if="fiducialCalibrateOpen && fiducialCalibrateSensor"
        :sensor="fiducialCalibrateSensor"
        :images="fiducialCalibrateImages"
        @close="fiducialCalibrateOpen = false"
        @detect="() => { fiducialCalibrateOpen = false; fiducialDetectSensorId = fiducialCalibrateSensor.id; fiducialDetectOpen = true }"
      />
    </Teleport>

    <Teleport to="body">
      <FiducialDetectModal
        v-if="fiducialDetectOpen && fiducialDetectSensor"
        :sensor="fiducialDetectSensor"
        :images="fiducialDetectImages"
        @close="fiducialDetectOpen = false"
        @open-image="(id) => { openImageTab(id); fiducialDetectOpen = false; sensorTableOpen = false }"
      />
    </Teleport>

    <Teleport to="body">
      <GcpTableModal
        v-if="gcpTableOpen"
        :gcps="gcps"
        :crs="currentCrs"
        :report="gcpReport"
        :selected-gcp-id="selectedGcpId"
        :has-reference-dem="hasReferenceDem"
        @fill-z="fillGcpZFromReferenceDem"
        @check-z="checkGcpZAgainstReferenceDem"
        @close="gcpTableOpen = false"
        @remove="removeGcpAndCloseTab"
        @update-accuracy="({ id, kind, value }) => setGcpAccuracy(id, kind, value)"
        @update-name="({ id, name }) => setGcpName(id, name)"
        @update-role="changeGcpRole"
        @update-vertical-datum="({ id, verticalDatum }) => setGcpVerticalDatum(id, verticalDatum)"
        @update-position="({ id, axis, value }) => setGcpPosition(id, axis, value)"
        @refresh-report="refreshGcpReport"
        @select="selectGcp"
        @add="addGcp"
      />
    </Teleport>

    <Teleport to="body">
      <MatchListModal
        v-if="matchListOpen"
        :match-summaries="matchSummaries"
        :images="images"
        :match-store="matchStore"
        :has-sparse="hasSparse"
        :aligned-uuids="alignedUuids"
        :used-matches-by-pair="usedMatchesByPair"
        :node-positions="matchNodePositions"
        @toggle-disabled="setPairDisabled"
        @close="matchListOpen = false"
      />
    </Teleport>

    <Teleport to="body">
      <NewProjectModal
        v-if="newProjectOpen"
        :can-cancel="newProjectCanCancel"
        @create="handleCreateProject"
        @cancel="handleCancelNewProject"
      />
    </Teleport>

    <Teleport to="body">
      <FolderReconnectModal
        v-if="folderPrompt"
        :project-name="folderPromptProject?.name || 'This project'"
        :folder-name="folderPromptProject?.folderName || ''"
        :mode="folderPrompt.action === 'repick' ? 'repick' : 'prompt'"
        :error="folderPrompt.error"
        @connect="onFolderConnect"
        @repick="onFolderRepick"
        @cancel="folderPrompt = null"
      />
    </Teleport>

    <Teleport to="body">
      <SaveProjectModal
        v-if="saveProjectOpen && currentProjectId"
        :project-id="currentProjectId"
        :project-name="currentProjectName"
        @close="saveProjectOpen = false"
        @run="onSaveProject"
      />
    </Teleport>

    <!-- Evaluate tab: the Quality Report hub (PLAN-eval-quality-hub) -->
    <Teleport to="body">
      <QualityReportModal
        v-if="qualityOpen"
        :section="qualitySection"
        @close="qualityOpen = false"
        @open-image="(id) => { openImageTab(id); qualityOpen = false }"
        @open-image-residuals="openImageWithResiduals"
        @open-match-list="qualityOpen = false; matchListOpen = true"
      />
    </Teleport>

    <Teleport to="body">
      <DebugSummaryModal v-if="debugSummaryOpen" @close="debugSummaryOpen = false" />
    </Teleport>

    <GlossaryModal />
    <GuideModal />

    <div class="layout">
      <Sidebar
        :style="{ width: sidebarWidth + 'px' }"
        :images="images"
        :gcps="gcps"
        :gcp-report="gcpReport"
        :selected-gcp-id="selectedGcpId"
        :sensors="sensors"
        :poses="poses"
        :shapefiles="shapefiles"
        :clouds="clouds"
        :selected-cloud-id="selectedCloudId"
        :main-sparse-id="mainSparseId"
        :recon-status="reconStatus"
        :match-stats="matchStats"
        :sensor-image-count="sensorImageCount"
        :incomplete-sensor-ids="incompleteSensorIds"
        :selected-id="selectedId"
        :aligned-uuids="alignedUuids"
        :has-sparse="hasSparse"
        :dem="dem"
        :ortho="ortho"
        :rasters="rasters"
        :pending-rasters="pendingRasters"
        :open-tab-ids="openTabIds"
        @open-product="openProductTab"
        @open-raster="openRasterTab"
        @convert-raster-to-image="(id) => onRasterImportAsImage({ id })"
        @remove-raster="confirmRemoveRaster"
        @set-raster-kind="({ id, kind }) => setRasterKind(id, kind)"
        @style-raster="(id) => (rasterStyleId = id)"
        @set-raster-on-map="({ id, onMap }) => setRasterOnMap(id, onMap)"
        @set-raster-opacity="({ id, opacity }) => setRasterOpacity(id, opacity)"
        @open-matches="matchListOpen = true"
        @select-cloud="showCloud"
        @remove-cloud="confirmRemoveCloud"
        @rename-cloud="({ id, name }) => renameCloud(id, name)"
        @set-main-cloud="setMainSparse"
        @reconstruct="reconstructOpen = true"
        @add-images="addImagesRouted"
        @import-file="openDroppedImport"
        @remove-image="requestRemoveImages"
        @convert-image-to-raster="convertImageToRaster"
        @remove-gcp="confirmRemoveGcp"
        @select-gcp="selectGcp"
        @jump-to-image="jumpToImage"
        @remove-gcp-observation="removeGcpObservation"
        @update-gcp-observation-accuracy="({ gcpId, imageId, axis, value }) => setObservationAccuracy(gcpId, imageId, axis, value)"
        @open-gcp="openGcpView"
        @remove-sensor="confirmRemoveSensor"
        @merge-sensors="({ target, source }) => mergeSensors(target, source)"
        @open-sensor="sensorTableOpen = true"
        @assign-sensor="({ imageId, sensorId }) => assignSensor(imageId, sensorId)"
        @remove-pose="removePose"
        @remove-shapefile="confirmRemoveShapefile"
        @rename-shapefile="({ id, name }) => renameSet(id, name)"
        @set-shapefile-on-map="({ id, onMap }) => setSetOnMap(id, onMap)"
        @zoom-to-shapefile="zoomToShapefile"
        @select="selectImage"
        @open="(id) => openImageTab(id)"
        @show-info="infoImageId = $event"
        @delete-keypoints="confirmClearKeypoints"
        @zoom-to-image="zoomToImagePosition"
        @zoom-to-cloud="zoomToCloud"
      />
      <div class="sidebar-resizer" title="Drag to resize" @mousedown.prevent="startSidebarResize" />
      <main class="main">
        <div class="tabstrip">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="tab"
            :class="{
              active: tab.id === activeTabId,
              dragging: tab.id === draggedTabId,
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
          <Viewer3D ref="viewerRef" v-show="activeTabId === 'viewer'" :theme="theme" :images="images" :show-cameras="showCameras" :show-grid="showGrid" :scene-up="viewerSceneUp" @command="handleCommand" />
          <ViewerMap ref="mapViewerRef" v-show="activeTabId === 'map'" :images="images" :gcps="gcps" :footprints="mapFootprints" :poses="poses" :selected-id="selectedId" :selected-gcp-id="selectedGcpId" :aligned-uuids="alignedUuids" :has-sparse="hasSparse" :crs="currentCrs" :show-footprints="showFootprints" :show-grid="showMapGrid" :rasters="mapRasters" :probe-raster="probeRasterAt" :load-raster="ensureRasterLoaded" @select="selectImage" @command="handleCommand" @select-gcp="selectGcp" @set-gcp-position="setGcpGroundPosition" @add-gcp-at="addGcpAtCoord" @delete-gcp="deleteGcpFromEditor" />
          <template v-for="tab in tabs" :key="tab.id">
            <ViewerImage
              v-if="tab.type === 'image' && imageById(tab.imageId)"
              v-show="activeTabId === tab.id"
              :ref="(el) => { if (el) imageViewerRefs[tab.imageId] = el; else delete imageViewerRefs[tab.imageId] }"
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
              @exit-mask-edit="patchImageView({ maskEdit: false })"
              @exit-gcp-edit="patchImageView({ gcpEdit: false })"
              @update-mask="(dataUrl, persist) => updateMask(tab.imageId, dataUrl, persist)"
              @update-depth="(dataUrl) => updateDepth(tab.imageId, dataUrl)"
              :is-film="sensorForImage(tab.imageId)?.kind === 'film'"
              :show-fiducials="imageViewPrefs.showFiducials"
              :fiducial-marks="fiducialDisplayForImage(tab.imageId).marks"
              :fiducial-obs="fiducialDisplayForImage(tab.imageId).obs"
              @mark-gcp="(pt) => assignGcpObservation(tab.imageId, imageById(tab.imageId)?.name, pt)"
              @add-gcp="(pt) => addGcpAtObservation(tab.imageId, imageById(tab.imageId)?.name, pt)"
              @select-gcp="selectGcp"
              @delete-gcp="deleteGcpFromEditor"
              @mark-fiducial="(event) => markDisplayedFiducial(tab.imageId, event)"
            />
            <ViewerGcp
              v-else-if="tab.type === 'gcp'"
              v-show="activeTabId === tab.id"
              :gcp="gcps.find((g) => g.id === tab.gcpId) ?? null"
              :images="images"
              :report="gcpReport.find((r) => r.gcpId === tab.gcpId) ?? null"
              @jump-to-image="jumpToImage"
            />
            <ProductViewer
              v-else-if="tab.type === 'product'"
              v-show="activeTabId === tab.id"
              :ref="(el) => { if (el) productViewerRefs[tab.id] = el; else delete productViewerRefs[tab.id] }"
              :kind="tab.productKind"
              :product="tab.productKind === 'ortho' ? ortho : dem"
            />
            <!-- Same viewer, imported raster instead of a computed product. -->
            <ProductViewer
              v-else-if="tab.type === 'raster'"
              v-show="activeTabId === tab.id"
              :ref="(el) => { if (el) productViewerRefs[tab.id] = el; else delete productViewerRefs[tab.id] }"
              :kind="rasterById(tab.rasterId)?.kind ?? 'dem'"
              :product="rasterById(tab.rasterId)"
              :source="rasterSources.get(tab.rasterId) ?? null"
            />
          </template>

          <Teleport to="body">
            <ImageInfoModal
              v-if="infoImage"
              :image="infoImage"
              @close="infoImageId = null"
            />
          </Teleport>
        </div>
      </main>
    </div>

    <!-- Tab context menu (closable tabs only) -->
    <Teleport to="body">
      <div
        v-if="tabCtx"
        class="tab-ctx-menu"
        :style="{ left: tabCtx.x + 'px', top: tabCtx.y + 'px' }"
        @click.stop
      >
        <button class="tab-ctx-item" @click="closeTab(tabCtx.id); closeTabCtx()">Close</button>
        <button class="tab-ctx-item" :disabled="!tabCtxHasOthers" @click="closeOtherTabs(tabCtx.id); closeTabCtx()">Close others</button>
        <button class="tab-ctx-item" :disabled="!tabCtxHasLeft" @click="closeTabsToLeft(tabCtx.id); closeTabCtx()">Close to the left</button>
        <button class="tab-ctx-item" :disabled="!tabCtxHasRight" @click="closeTabsToRight(tabCtx.id); closeTabCtx()">Close to the right</button>
        <div class="tab-ctx-sep" />
        <button class="tab-ctx-item" @click="closeAllTabs(); closeTabCtx()">Close all</button>
      </div>
    </Teleport>

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

    <DevConsole v-if="consoleOpen" :dispatch="handleCommand" :command-state="commandState" />
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

.project-backdrop {
  position: fixed;
  inset: 0;
  z-index: 299;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

/* Interaction-blocking overlay shown while a project restores. */
.loading-overlay {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}
.loading-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 22px;
  border-radius: 10px;
  background: var(--panel, #1e1e24);
  color: var(--text, #e8e8ec);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
  font-size: 14px;
}
.loading-spinner {
  width: 20px;
  height: 20px;
  flex: none;
  border: 3px solid rgba(255, 255, 255, 0.2);
  border-top-color: var(--accent, #44aaff);
  border-radius: 50%;
  animation: loading-spin 0.8s linear infinite;
}
.loading-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.loading-detail {
  font-size: 12px;
  color: var(--text-dim, #9a9aa4);
}
@keyframes loading-spin {
  to { transform: rotate(360deg); }
}

.app {
  display: flex;
  flex-direction: column;
  height: calc(100% * var(--ui-scale-inverse));
  width: calc(100% * var(--ui-scale-inverse));
  zoom: var(--ui-scale);
}

.layout {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
}

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

.tab:hover { color: var(--text); }

.tab.active {
  background: var(--bg);
  color: var(--text);
  box-shadow: inset 0 2px 0 var(--accent);
}

.tab.dragging { opacity: 0.45; }

/* Drop indicator: accent bar on the leading edge of the hovered tab. */
.tab.drag-over { box-shadow: inset 3px 0 0 var(--accent); }

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

.tab-ctx-item:hover:not(:disabled) { background: var(--hover-bg); }

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
