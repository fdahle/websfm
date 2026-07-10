<script setup>
import { ref, computed, reactive, watch, onMounted, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import Ribbon from './components/layout/Ribbon.vue'
import Sidebar from './components/layout/Sidebar.vue'
import Viewer3D from './components/viewers/Viewer3D.vue'
import ViewerMap from './components/viewers/ViewerMap.vue'
import ViewerImage from './components/viewers/ViewerImage.vue'
import ImageInfoModal from './components/modals/ImageInfoModal.vue'
import DetectFeaturesModal from './components/modals/DetectFeaturesModal.vue'
import MatchFeaturesModal from './components/modals/MatchFeaturesModal.vue'
import ImageTableModal from './components/modals/ImageTableModal.vue'
import MaskManagerModal from './components/modals/MaskManagerModal.vue'
import AutoMaskModal from './components/modals/AutoMaskModal.vue'
import SensorTableModal from './components/modals/SensorTableModal.vue'
import MatchListModal from './components/modals/MatchListModal.vue'
import ProgressModal from './components/modals/ProgressModal.vue'
import SettingsModal from './components/modals/SettingsModal.vue'
import AboutModal from './components/modals/AboutModal.vue'
import NewProjectModal from './components/modals/NewProjectModal.vue'
import GlossaryModal from './components/glossary/GlossaryModal.vue'
import GuideModal from './components/guide/GuideModal.vue'
import ProjectPicker from './components/layout/ProjectPicker.vue'
import DevConsole from './components/layout/DevConsole.vue'
import { useImagesStore } from './stores/useImagesStore.js'
import { useMatchesStore } from './stores/useMatchesStore.js'
import { useTabs } from './composables/useTabs.js'
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
import { useModalEscape } from './composables/useModalEscape.js'
import { useBeforeUnload } from './composables/useBeforeUnload.js'
import { useReconstructionStore } from './stores/useReconstructionStore.js'
import { useGcpsStore } from './stores/useGcpsStore.js'
import { restoreProjectStores, clearProjectStores } from './stores/projectStores.js'
import { useFootprintsStore } from './stores/useFootprintsStore.js'
import { useSensorsStore } from './stores/useSensorsStore.js'
import { usePosesStore } from './stores/usePosesStore.js'
import './stores/useLogStore.js'   // registers the console as a project-scoped store
import ReconstructModal from './components/modals/ReconstructModal.vue'
import ExportModal from './components/modals/ExportModal.vue'
import DepthMapsModal from './components/modals/DepthMapsModal.vue'
import DenseModal from './components/modals/DenseModal.vue'
import DemModal from './components/modals/DemModal.vue'
import OrthoModal from './components/modals/OrthoModal.vue'
import ConfirmModal from './components/modals/ConfirmModal.vue'
import ProductViewer from './components/viewers/ProductViewer.vue'
import GcpImportModal from './components/modals/GcpImportModal.vue'
import GcpTableModal from './components/modals/GcpTableModal.vue'
import FootprintImportModal from './components/modals/FootprintImportModal.vue'
import FootprintFromPosesModal from './components/modals/FootprintFromPosesModal.vue'
import CameraImportModal from './components/modals/CameraImportModal.vue'
import ImportKindModal from './components/modals/ImportKindModal.vue'
import * as opfs from './utils/opfs.js'
import { ensureProjection } from './core/crs.js'

// ── Theme ─────────────────────────────────────────────────────────────────────
const { theme, applyTheme, setTheme } = useTheme()

// ── Projects ──────────────────────────────────────────────────────────────────
const projectsStore = useProjectsStore()
const {
  persistenceAvailable, projects, currentProjectId, currentProjectName, currentSceneType, currentCrs,
} = storeToRefs(projectsStore)
const {
  setPersistenceAvailable, loadIndex, createProject, setProjectCrs, switchProject, renameProject,
  deleteProjectById,
} = projectsStore

// ── Images ────────────────────────────────────────────────────────────────────
const imagesStore = useImagesStore()
const { images, selectedId } = storeToRefs(imagesStore)
const {
  imageById, selectImage,
  addImages, removeImage,
  updateMask, updateDepth, detectAll, clearKeypoints, clearAll,
  setFiducialObservation, addFiducialObservations,
  restoreImages,
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
  activeTab, activeImageTab, activeView,
  activateTab, openImageTab, openProductTab,
  closeTab, closeTabForImage, moveTab,
  closeAllTabs, closeOtherTabs, closeTabsToLeft, closeTabsToRight,
  onImageDetected, resetToViewer, rememberOverlayPrefs,
} = useTabs(imageById, showMap)

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
const { cameras, sparseCameras, points3d, reconStatus, clouds, selectedCloudId, selectedCloud, mainSparseId, mainSparseCloud, depthMaps, dem, ortho, georef, canGeoreference } = storeToRefs(reconstructionStore)
const { reconstruct, importColmapModel, computeDepthMaps, densify, generateDem, generateOrtho, georeference, gcpAccuracyReport, selectCloud, removeCloud, renameCloud, setMainSparse } = reconstructionStore

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
const gcpsStore = useGcpsStore()
const { gcps } = storeToRefs(gcpsStore)
const { addGcps, addGcp, setGcpName, setGcpPosition, setGcpAccuracy, setObservation, removeObservation, removeGcp, reprojectGcps } = gcpsStore

// Per-GCP accuracy report (triangulated residual vs. surveyed position + per-
// observation reprojection error) — refreshed on demand since it triangulates
// against the current sparse cloud; cheap enough to just re-run each open/refresh
// and after every mark so the reprojection feedback stays live.
const gcpReport = ref([])
async function refreshGcpReport() {
  gcpReport.value = await gcpAccuracyReport()
}

// `selectedGcpId` highlights a GCP's marker in the image view + its row in the
// table; set by clicking a GCP row (highlight only — marking is via right-click).
const selectedGcpId = ref(null)
function selectGcp(id) { selectedGcpId.value = id }

// Turn on the GCP overlay for an image's tab so a freshly-placed mark is visible.
function ensureGcpsVisible(imageId) {
  const tab = tabs.value.find((t) => t.type === 'image' && t.imageId === imageId)
  if (tab && !tab.showGcps) { tab.showGcps = true; rememberOverlayPrefs(tab) }
}

// Right-click marking in the image view. Assign attaches the clicked pixel to an
// existing GCP; add-here creates a new GCP already marked at that pixel and
// selects it. Both refresh the accuracy report so reprojection feedback is live.
function assignGcpObservation(imageId, imageName, { gcpId, px, py }) {
  setObservation(gcpId, imageId, imageName, px, py)
  selectedGcpId.value = gcpId
  ensureGcpsVisible(imageId)
  refreshGcpReport()
}
function addGcpAtObservation(imageId, imageName, { px, py }) {
  const id = addGcp()
  setObservation(id, imageId, imageName, px, py)
  selectedGcpId.value = id
  ensureGcpsVisible(imageId)
  refreshGcpReport()
}
// Sidebar observation-list actions.
function jumpToImage({ imageId }) { if (imageId != null) openImageTab(imageId) }
function removeGcpObservation({ gcpId, imageId }) {
  removeObservation(gcpId, imageId)
  refreshGcpReport()
}

// ── Footprints ──────────────────────────────────────────────────────────────────
const footprintsStore = useFootprintsStore()
const { footprints } = storeToRefs(footprintsStore)
const { addFootprints, computeFootprints, reprojectFootprints, removeFootprint } = footprintsStore

// ── Sensors (shared intrinsics) ───────────────────────────────────────────────────
// Project-scoped, but restored/cleared manually (must precede images — its EXIF
// auto-grouping watcher reacts to the image list).
const sensorsStore = useSensorsStore()
const { sensors } = storeToRefs(sensorsStore)
const {
  imageCount: sensorImageCount,
  addSensors, updateSensor, toggleSensorFixed, setFiducialMarks, assignSensor, mergeSensors, removeSensor, clearSensors, restoreSensors,
} = sensorsStore

// ── Camera poses (extrinsics) ─────────────────────────────────────────────────────
const posesStore = usePosesStore()
const { poses } = storeToRefs(posesStore)
const { addPoses, removePose, reprojectPoses } = posesStore

// ── Modals ────────────────────────────────────────────────────────────────────
const {
  settingsOpen, aboutOpen,
  projectPickerOpen, newProjectOpen, newProjectCanCancel,
  detectFeaturesOpen, matchFeaturesOpen,
  imageTableOpen, maskManagerOpen, autoMaskOpen, sensorTableOpen, gcpTableOpen, matchListOpen, reconstructOpen,
  depthMapsOpen, denseOpen, demOpen, orthoOpen,
  gcpImportOpen, gcpImportText, gcpImportName, gcpImportGeojson, gcpImportCrs,
  footprintImportOpen, footprintImportData, footprintFromPosesOpen,
  cameraImportOpen, cameraImportText, cameraImportName, cameraImportMode,
  importKindOpen, importKindFile,
  infoImageId,
} = storeToRefs(useModalsStore())

const glossaryStore = useGlossaryStore()
const guideStore = useGuideStore()

// Resolved image for the Image Info modal. Lives here (not in the modals store)
// because it needs the image list; moves into the store once images is one too.
const infoImage = computed(() => infoImageId.value ? imageById(infoImageId.value) : null)

// ── Pipeline ──────────────────────────────────────────────────────────────────
const {
  progressOpen, progressTitle, progressCurrent, progressTotal, progressLabel,
  cancelRun, runDetect, runMatch, runReconstruct, runComputeDepthMaps, runDensify,
  runGenerateDem, runGenerateOrtho,
} = usePipeline({ images, detectAll, matchAll, onImageDetected, reconstruct, computeDepthMaps, densify, generateDem, generateOrtho })

// Dense pipeline gating for the Ribbon.
const sparseReady = computed(() => clouds.value.some((c) => c.kind === 'sparse' && c.cameras.size >= 2))
const depthMapCount = computed(() => depthMaps.value.size)
// Products gating: a DEM needs any cloud; an ortho needs a DEM (+ depth maps);
// the preview needs a built product.
const cloudReady = computed(() => clouds.value.some((c) => c.points.length > 0))
const demReady = computed(() => !!dem.value)
const orthoReady = computed(() => !!ortho.value)
const productReady = computed(() => !!dem.value || !!ortho.value)

// ── Derived state ──────────────────────────────────────────────────────────────
const selected = computed(() => images.value.find((img) => img.id === selectedId.value) || null)

const kpImageCount = computed(() => images.value.filter(img => img.kpStatus === 'done').length)

// Guard state for the DevConsole command line — same prerequisite flags the
// ribbon uses to enable/disable buttons (see core/help/commands.js guardReason).
const commandState = computed(() => ({
  imageCount:    images.value.length,
  kpImageCount:  kpImageCount.value,
  matchCount:    matchSummaries.value.length,
  gcpCount:      gcps.value.length,
  poseCount:     poses.value.length,
  sensorCount:   sensors.value.length,
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
    if (p.imageId == null || p.x == null || p.y == null) continue
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
  let total = 0, verified = 0, running = 0, error = 0, disabled = 0
  for (const [, entry] of matchStore.value) {
    total++
    if (entry.status === 'running') running++
    else if (entry.status === 'error') error++
    else if (entry.status === 'done' && entry.inlierCount > 0) {
      // A user-excluded pair is still geometrically verified, but it won't feed
      // reconstruction — count it separately so "verified" reflects usable pairs.
      if (entry.disabled) disabled++
      else verified++
    }
  }
  // Pairs that contributed at least one tie-point to the sparse model (0 until
  // reconstruction has run).
  const used = hasSparse.value ? usedMatchesByPair.value.size : null
  return { total, verified, running, error, used, disabled }
})

const activeImageViewState = computed(() => {
  const tab = activeTab.value
  if (!tab || tab.type !== 'image') return null
  const img = imageById(tab.imageId)
  if (!img) return null
  return {
    showKeypoints: tab.showKeypoints,
    showMask:      tab.showMask,
    showDepth:     tab.showDepth,
    showGcps:      tab.showGcps,
    showFiducials: tab.showFiducials,
    isFilm:        sensorForImage(tab.imageId)?.kind === 'film',
    maskMode:      tab.maskMode,
    brushRadius:   tab.brushRadius,
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

// Push the selected point cloud into the 3D viewer. Reference changes on select,
// rebuild (a fresh object replaces the sparse cloud), and restore.
watch(selectedCloud, (c) => {
  if (c) viewerRef.value?.setReconstructionData(c.cameras, c.points)
  else viewerRef.value?.clearReconstructionData()
})

// ── 3D scene display toggles ───────────────────────────────────────────────────
const showCameras = ref(true)
const showGraticule = ref(true)
// ── Map display toggles ────────────────────────────────────────────────────────
const showFootprints = ref(true)

// ── Console ───────────────────────────────────────────────────────────────────
// True while a project is being restored — drives the interaction-blocking overlay.
const projectLoading = ref(false)
// { done, total, label } while restoreImages streams progress, else null — lets
// the loading overlay show "Loading image 3/5 — name.tif" instead of a static spinner.
const projectLoadingProgress = ref(null)

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
      else closeTopModal()
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

async function openProject(id) {
  const projectData = await switchProject(id)
  if (!projectData) return
  // Gate interaction while a project restores. Restoring a model still does a
  // burst of synchronous work (decoding point buffers, rebuilding tracks); the
  // overlay stops the user acting on a half-loaded project and then hitting the
  // freeze mid-click.
  projectLoading.value = true
  try {
    if (projectData.crs) await ensureProjection(projectData.crs).catch(() => {})
    resetToViewer()
    viewerRef.value?.clearReconstructionData()
    // Let the overlay actually paint before the synchronous restore work runs.
    await nextTick()
    await new Promise((r) => requestAnimationFrame(() => r()))
    // Restore sensors before images: EXIF auto-grouping reacts to the image list,
    // so the saved sensors must already be in place or it would mint duplicates
    // and clobber manual sensor assignments. Both have bespoke restore signatures,
    // so they stay manual; every other project-scoped store restores through the
    // registry below (matches, reconstruction, GCPs, footprints, poses).
    await restoreSensors(id)
    await restoreImages(projectData.images || [], id, (done, total, label) => {
      projectLoadingProgress.value = { done, total, label }
    })
    projectLoadingProgress.value = null
    await restoreProjectStores({ projectId: id, projectData })
    // restore() sets selectedCloud, which the watcher pushes into the viewer.
  } finally {
    projectLoading.value = false
    projectLoadingProgress.value = null
  }
}

// ── New project ───────────────────────────────────────────────────────────────
async function handleCreateProject({ name, sceneType, crs }) {
  newProjectOpen.value = false
  // Leaving the current project to create a new one: reset in-memory state only.
  // Purging here would delete the previously-open project's persisted data.
  clearAll(resetToViewer)
  clearSensors()
  clearProjectStores()   // matches, reconstruction, GCPs, footprints, poses
  viewerRef.value?.clearReconstructionData()
  if (crs) await ensureProjection(crs).catch(() => {})
  await createProject(name, sceneType, crs)
}

// Cancelling the New Project dialog falls back to the picker when no project is
// open yet, so the user is never left in an empty, project-less state.
function handleCancelNewProject() {
  newProjectOpen.value = false
  if (!currentProjectId.value && projects.value.length > 0) {
    projectPickerOpen.value = true
  }
}

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
const {
  cameraPickMode,
  openImportFile, openDroppedImport, routeImport,
  onImportKindChosen, onImportSwitchKind,
  openCameraImport, onCameraImport, onGcpImport, onFootprintImport,
  onGcpPick, onCameraPick, onColmapPick,
} = useImportRouting({ addGcps, addFootprints, addSensors, addPoses, addFiducialObs: addFiducialObservations, importColmap: importColmapModel, activateTab })

// Switch to the map and centre it on an image's position (pose or EXIF GPS).
function zoomToImagePosition(imgId) {
  activateTab('map')
  nextTick(() => mapViewerRef.value?.zoomToImage(imgId))
}

// Footprints from imported camera poses (opens the map when any were built).
function onFootprintFromPoses(settings) {
  footprintFromPosesOpen.value = false
  const { computed: n } = computeFootprints(settings)
  if (n > 0) activateTab('map')
}

// ── Export (camera params + products) ───────────────────────────────────────────
const {
  exportKind, exportPoses, exportSensors, exportKeypoints, exportMatches, onExportRun,
} = useExports({
  poses, sensors, images, matchStore, clouds, selectedCloud, mainSparseCloud, dem, ortho,
  currentProjectName, currentCrs,
})

// ── Project picker actions ────────────────────────────────────────────────────
async function handleSwitchProject(id) {
  if (id === currentProjectId.value) { projectPickerOpen.value = false; return }
  projectPickerOpen.value = false
  clearAll(resetToViewer)
  clearSensors()
  clearProjectStores()
  await openProject(id)
}

async function handleDeleteProject(id) {
  const nextId = await deleteProjectById(id)

  // Deleting the last project leaves nothing to pick — close the picker and go
  // straight to project creation (non-cancellable), never an empty list.
  if (projects.value.length === 0) {
    projectPickerOpen.value = false
    clearAll(resetToViewer)
    clearSensors()
    clearProjectStores({ purge: true })
    viewerRef.value?.clearReconstructionData()
    newProjectCanCancel.value = false
    newProjectOpen.value = true
    return
  }

  if (id === currentProjectId.value) {
    clearAll(resetToViewer)
    clearSensors()
    clearProjectStores({ purge: true })
    viewerRef.value?.clearReconstructionData()
    if (nextId) await openProject(nextId)
  }
}

// ── Pipeline handlers (close modal, then delegate to usePipeline) ─────────────
function onDetectRun(settings)      { detectFeaturesOpen.value = false;  runDetect(settings)      }
function onMatchRun(settings)       { matchFeaturesOpen.value  = false;  runMatch(settings)       }
function onReconstructRun(settings) { reconstructOpen.value    = false;  runReconstruct(settings) }

// Open an image from the Mask Manager and drop straight into mask-draw mode.
function editMask(id) {
  maskManagerOpen.value = false
  openImageTab(id)
  const tab = activeTab.value
  if (tab?.type === 'image') { tab.showMask = true; tab.showDepth = false; tab.maskMode = 'draw' }
}
function onDepthMapsRun(settings)   { depthMapsOpen.value      = false;  runComputeDepthMaps(settings) }
function onDenseRun(settings)       { denseOpen.value          = false;  runDensify(settings) }
// Products: generation just produces the product; the user opens it via the
// Products sidebar section (double-click / "Open in tab") when they want to inspect it.
async function onDemRun(settings)   { demOpen.value = false;   await runGenerateDem(settings) }
async function onOrthoRun(settings) { orthoOpen.value = false; await runGenerateOrtho(settings) }

// ── Image deletion (with confirmation) ────────────────────────────────────────
// Removing images is irreversible (drops keypoints/masks/matches), so route every
// delete request through a confirm dialog. Holds the pending image ids + names.
const pendingImageDelete = ref(null)

// Clearing an image's mask is irreversible (drops the painted region), so route it
// through a confirm dialog. Holds the tab/image id whose mask is pending clear.
const pendingMaskClear = ref(null)
function confirmMaskClear() {
  imageViewerRefs[pendingMaskClear.value]?.clearMask()
  pendingMaskClear.value = null
}

// Escape-closes-top-most-modal (pulls modal state from the stores; the few local
// bits are injected). Used by the global keydown handler in the bootstrap below.
const { closeTopModal } = useModalEscape({
  pendingImageDelete, pendingMaskClear, exportKind, onCancelNewProject: handleCancelNewProject,
})

// Site-wide confirm before the tab is closed / reloaded / navigated away.
useBeforeUnload()

function requestRemoveImages(idOrIds) {
  const ids = (Array.isArray(idOrIds) ? idOrIds : [idOrIds]).filter(Boolean)
  if (!ids.length) return
  const names = ids.map((id) => imageById(id)?.name).filter(Boolean)
  pendingImageDelete.value = { ids, names }
}

function confirmRemoveImages() {
  const ids = pendingImageDelete.value?.ids ?? []
  for (const id of ids) removeImage(id, closeTabForImage)
  pendingImageDelete.value = null
}

const deleteMessage = computed(() => {
  const p = pendingImageDelete.value
  if (!p) return ''
  if (p.ids.length === 1) return `Remove “${p.names[0] ?? 'this image'}”? This also deletes its keypoints, mask, depth map and matches. This can't be undone.`
  return `Remove ${p.ids.length} images? This also deletes their keypoints, masks, depth maps and matches. This can't be undone.`
})

// ── ImageViewer refs (for imperative mask ops) ────────────────────────────────
const imageViewerRefs = reactive({})
const ribbonInput = ref(null)
const gcpInput = ref(null)
const cameraInput = ref(null)
const colmapInput = ref(null)
// cameraPickMode comes from useImportRouting (above); the command dispatch sets it
// before opening the hidden camera-file <input>.

// ── Commands ──────────────────────────────────────────────────────────────────
function handleCommand(id) {
  switch (id) {
    case 'import-images':        ribbonInput.value.click(); break
    case 'import-gcps':          gcpInput.value.click(); break
    case 'import-camera-list':   cameraPickMode.value = 'pose';   cameraInput.value.click(); break
    case 'import-calib':         cameraPickMode.value = 'sensor'; cameraInput.value.click(); break
    case 'import-colmap':        colmapInput.value.click(); break
    case 'export-cameras':       exportPoses(); break
    case 'export-sensors':       exportSensors(); break
    case 'export-cloud':         exportKind.value = 'cloud'; break
    case 'export-model':         exportKind.value = 'model'; break
    case 'export-colmap':        exportKind.value = 'colmap'; break
    case 'export-dem':           exportKind.value = 'dem'; break
    case 'export-ortho':         exportKind.value = 'ortho'; break
    case 'export-keypoints':     exportKeypoints(); break
    case 'export-matches':       exportMatches(); break
    case 'clear-all':            clearAll(resetToViewer, { purge: true }); clearSensors({ purge: true }); clearProjectStores({ purge: true }); viewerRef.value?.clearReconstructionData(); break
    case 'remove-selected':      if (selectedId.value) requestRemoveImages(selectedId.value); break
    case 'view-viewer':          activateTab('viewer'); break
    case 'view-map':             activateTab('map'); break
    case 'view-preset-top':      viewerRef.value?.setView('top'); break
    case 'view-preset-bottom':   viewerRef.value?.setView('bottom'); break
    case 'view-preset-left':     viewerRef.value?.setView('left'); break
    case 'view-preset-right':    viewerRef.value?.setView('right'); break
    case 'view-preset-front':    viewerRef.value?.setView('front'); break
    case 'view-preset-back':     viewerRef.value?.setView('back'); break
    case 'reset-view':           viewerRef.value?.resetView(); break
    case 'view-toggle-cameras':  showCameras.value = !showCameras.value; break
    case 'view-toggle-graticule': showGraticule.value = !showGraticule.value; break
    case 'map-fit-view':         mapViewerRef.value?.fitView(); break
    case 'map-toggle-footprints': showFootprints.value = !showFootprints.value; break
    case 'open-image-table':     imageTableOpen.value = true; break
    case 'open-mask-manager':    maskManagerOpen.value = true; break
    case 'auto-mask':            autoMaskOpen.value = true; break
    case 'open-sensor-table':    sensorTableOpen.value = true; break
    case 'open-gcp-table':       gcpTableOpen.value = true; refreshGcpReport(); break
    case 'open-match-list':      matchListOpen.value = true; break
    case 'reconstruct':          reconstructOpen.value = true; break
    case 'compute-depth':        depthMapsOpen.value = true; break
    case 'dense':                denseOpen.value = true; break
    case 'gen-dem':              demOpen.value = true; break
    case 'gen-ortho':            orthoOpen.value = true; break
    case 'auto-georeference':    georeference(); break
    case 'footprints-from-poses': footprintFromPosesOpen.value = true; break
    case 'detect-features':      detectFeaturesOpen.value = true; break
    case 'match-features':       matchFeaturesOpen.value = true; break
    case 'open-settings':        settingsOpen.value = true; break
    case 'open-about':           aboutOpen.value = true; break
    case 'open-glossary':        glossaryStore.openHome(); break
    case 'open-guide':           guideStore.openHome(); break
    case 'open-project-picker':  projectPickerOpen.value = !projectPickerOpen.value; break
    case 'toggle-console':       consoleOpen.value = !consoleOpen.value; break
    case 'img-show-info':        if (activeImageTab.value) infoImageId.value = activeImageTab.value.id; break
    case 'img-remove':           if (activeImageTab.value) requestRemoveImages(activeImageTab.value.id); break
    case 'img-toggle-keypoints': {
      const tab = activeTab.value
      if (tab?.type === 'image') { tab.showKeypoints = !tab.showKeypoints; rememberOverlayPrefs(tab) }
      break
    }
    case 'img-toggle-mask': {
      const tab = activeTab.value
      // Mask and depth overlays are mutually exclusive — turning one on clears the other.
      if (tab?.type === 'image') {
        tab.showMask = !tab.showMask
        if (tab.showMask) tab.showDepth = false
        rememberOverlayPrefs(tab)
      }
      break
    }
    case 'img-toggle-depth': {
      const tab = activeTab.value
      if (tab?.type === 'image') {
        tab.showDepth = !tab.showDepth
        if (tab.showDepth) tab.showMask = false
        rememberOverlayPrefs(tab)
      }
      break
    }
    case 'img-toggle-gcps': {
      const tab = activeTab.value
      if (tab?.type === 'image') { tab.showGcps = !tab.showGcps; rememberOverlayPrefs(tab) }
      break
    }
    case 'img-toggle-fiducials': {
      const tab = activeTab.value
      if (tab?.type === 'image') { tab.showFiducials = !tab.showFiducials; rememberOverlayPrefs(tab) }
      break
    }
    case 'img-mask-draw': {
      const tab = activeTab.value
      if (tab?.type === 'image') tab.maskMode = tab.maskMode === 'draw' ? 'none' : 'draw'
      break
    }
    case 'img-mask-erase': {
      const tab = activeTab.value
      if (tab?.type === 'image') tab.maskMode = tab.maskMode === 'erase' ? 'none' : 'erase'
      break
    }
    case 'img-mask-import': imageViewerRefs[activeImageTab.value?.id]?.triggerMaskImport(); break
    case 'img-mask-clear':  pendingMaskClear.value = activeImageTab.value?.id ?? null; break
    case 'img-brush-s': { const t = activeTab.value; if (t?.type === 'image') t.brushRadius = 10; break }
    case 'img-brush-m': { const t = activeTab.value; if (t?.type === 'image') t.brushRadius = 20; break }
    case 'img-brush-l': { const t = activeTab.value; if (t?.type === 'image') t.brushRadius = 40; break }
  }
}

function onRibbonPick(event) {
  const files = [...event.target.files].filter((f) => f.type.startsWith('image/'))
  if (files.length) addImages(files)
  event.target.value = ''
}
</script>

<template>
  <div class="app">
    <Ribbon
      :active-view="activeView"
      :has-selection="!!selected"
      :image-count="images.length"
      :match-count="matchSummaries.length"
      :kp-image-count="kpImageCount"
      :gcp-count="gcps.length"
      :pose-count="poses.length"
      :sensor-count="sensors.length"
      :sparse-ready="sparseReady"
      :depth-map-count="depthMapCount"
      :cloud-ready="cloudReady"
      :dem-ready="demReady"
      :ortho-ready="orthoReady"
      :product-ready="productReady"
      :active-image-id="activeImageTab?.id ?? null"
      :active-image-name="activeImageTab?.name ?? null"
      :image-view-state="activeImageViewState"
      :console-open="consoleOpen"
      :persistence-enabled="persistenceAvailable"
      :current-project-name="currentProjectName"
      :scene-type="currentSceneType"
      :show-cameras="showCameras"
      :show-graticule="showGraticule"
      :show-footprints="showFootprints"
      :footprint-count="footprints.length"
      @command="handleCommand"
    />
    <input ref="ribbonInput" type="file" accept="image/*" multiple hidden @change="onRibbonPick" />
    <input ref="gcpInput" type="file" accept=".csv,.txt,.tsv,.gcp,.pts,.geojson,.json,application/geo+json,text/*" hidden @change="onGcpPick" />
    <input ref="cameraInput" type="file" accept=".csv,.txt,.tsv,.cam,text/*" hidden @change="onCameraPick" />
    <input ref="colmapInput" type="file" accept=".txt,.bin,.zip" multiple hidden @change="onColmapPick" />

    <div v-if="projectPickerOpen && !currentProjectId" class="project-backdrop" />

    <div v-if="projectLoading" class="loading-overlay">
      <div class="loading-card">
        <div class="loading-spinner" />
        <div class="loading-text">
          <span>Loading project…</span>
          <span v-if="projectLoadingProgress" class="loading-detail">
            Loading image {{ projectLoadingProgress.done }}/{{ projectLoadingProgress.total }}
            — {{ projectLoadingProgress.label }}
          </span>
        </div>
      </div>
    </div>

    <ProjectPicker
      v-if="projectPickerOpen"
      :projects="projects"
      :current-project-id="currentProjectId"
      :dismissible="!!currentProjectId"
      @switch="handleSwitchProject"
      @rename="(id, name) => renameProject(id, name)"
      @delete="handleDeleteProject"
      @new="() => { projectPickerOpen = false; newProjectCanCancel = true; newProjectOpen = true }"
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
        @close="matchFeaturesOpen = false"
        @run="onMatchRun"
      />
    </Teleport>

    <Teleport to="body">
      <ReconstructModal
        v-if="reconstructOpen"
        @close="reconstructOpen = false"
        @run="onReconstructRun"
      />
    </Teleport>

    <Teleport to="body">
      <ExportModal
        v-if="exportKind"
        :kind="exportKind"
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
        v-if="pendingMaskClear"
        title="Clear mask?"
        message="This removes the painted mask for this image. This can't be undone."
        confirm-label="Clear"
        danger
        @confirm="confirmMaskClear"
        @cancel="pendingMaskClear = null"
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
      <GcpImportModal
        v-if="gcpImportOpen"
        :raw-text="gcpImportText"
        :file-name="gcpImportName"
        :project-crs="currentCrs"
        :geojson-gcps="gcpImportGeojson"
        :detected-crs="gcpImportCrs"
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
        :cancelable="true"
        @cancel="cancelRun"
      />
    </Teleport>

    <Teleport to="body">
      <SettingsModal
        v-if="settingsOpen"
        :theme="theme"
        :crs="currentProjectId ? currentCrs : null"
        :scene-type="currentSceneType"
        @close="settingsOpen = false"
        @set-theme="setTheme"
        @set-crs="handleSetCrs"
      />
    </Teleport>

    <Teleport to="body">
      <AboutModal v-if="aboutOpen" @close="aboutOpen = false" />
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
        @remove="removeSensor"
      />
    </Teleport>

    <Teleport to="body">
      <GcpTableModal
        v-if="gcpTableOpen"
        :gcps="gcps"
        :crs="currentCrs"
        :report="gcpReport"
        :selected-gcp-id="selectedGcpId"
        @close="gcpTableOpen = false"
        @remove="removeGcp"
        @update-accuracy="({ id, kind, value }) => setGcpAccuracy(id, kind, value)"
        @update-name="({ id, name }) => setGcpName(id, name)"
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
        :footprints="footprints"
        :clouds="clouds"
        :selected-cloud-id="selectedCloudId"
        :main-sparse-id="mainSparseId"
        :recon-status="reconStatus"
        :match-stats="matchStats"
        :sensor-image-count="sensorImageCount"
        :selected-id="selectedId"
        :aligned-uuids="alignedUuids"
        :has-sparse="hasSparse"
        :dem="dem"
        :ortho="ortho"
        @open-product="openProductTab"
        @open-matches="matchListOpen = true"
        @select-cloud="showCloud"
        @remove-cloud="removeCloud"
        @rename-cloud="({ id, name }) => renameCloud(id, name)"
        @set-main-cloud="setMainSparse"
        @reconstruct="reconstructOpen = true"
        @add-images="addImages"
        @import-file="openDroppedImport"
        @remove-image="requestRemoveImages"
        @remove-gcp="removeGcp"
        @select-gcp="selectGcp"
        @jump-to-image="jumpToImage"
        @remove-gcp-observation="removeGcpObservation"
        @remove-sensor="removeSensor"
        @merge-sensors="({ target, source }) => mergeSensors(target, source)"
        @assign-sensor="({ imageId, sensorId }) => assignSensor(imageId, sensorId)"
        @remove-pose="removePose"
        @remove-footprint="removeFootprint"
        @select="selectImage"
        @open="(id) => openImageTab(id)"
        @show-info="infoImageId = $event"
        @delete-keypoints="clearKeypoints"
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
          <Viewer3D ref="viewerRef" v-show="activeTabId === 'viewer'" :theme="theme" :images="images" :show-cameras="showCameras" :show-graticule="showGraticule" />
          <ViewerMap ref="mapViewerRef" v-show="activeTabId === 'map'" :images="images" :gcps="gcps" :footprints="footprints" :poses="poses" :selected-id="selectedId" :aligned-uuids="alignedUuids" :has-sparse="hasSparse" :crs="currentCrs" :show-footprints="showFootprints" @select="selectImage" />
          <template v-for="tab in tabs" :key="tab.id">
            <ViewerImage
              v-if="tab.type === 'image' && imageById(tab.imageId)"
              v-show="activeTabId === tab.id"
              :ref="(el) => { if (el) imageViewerRefs[tab.imageId] = el; else delete imageViewerRefs[tab.imageId] }"
              :image="imageById(tab.imageId)"
              :show-keypoints="tab.showKeypoints"
              :show-mask="tab.showMask"
              :show-depth="tab.showDepth"
              :show-gcps="tab.showGcps"
              :gcps="activeTabId === tab.id ? activeImageGcps : []"
              :all-gcps="allGcpsBrief"
              :selected-gcp-id="selectedGcpId"
              :mask-mode="tab.maskMode"
              :brush-radius="tab.brushRadius"
              @update-mask="(dataUrl) => updateMask(tab.imageId, dataUrl)"
              @update-depth="(dataUrl) => updateDepth(tab.imageId, dataUrl)"
              :is-film="sensorForImage(tab.imageId)?.kind === 'film'"
              :show-fiducials="tab.showFiducials"
              :fiducial-marks="sensorForImage(tab.imageId)?.fiducials?.marks ?? []"
              :fiducial-obs="imageById(tab.imageId)?.fiducialObs ?? []"
              @mark-gcp="(pt) => assignGcpObservation(tab.imageId, imageById(tab.imageId)?.name, pt)"
              @add-gcp="(pt) => addGcpAtObservation(tab.imageId, imageById(tab.imageId)?.name, pt)"
              @mark-fiducial="({ fidId, px, py }) => setFiducialObservation(tab.imageId, fidId, px, py)"
            />
            <ProductViewer
              v-else-if="tab.type === 'product'"
              v-show="activeTabId === tab.id"
              :kind="tab.productKind"
              :product="tab.productKind === 'ortho' ? ortho : dem"
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

    <DevConsole v-if="consoleOpen" :dispatch="handleCommand" :command-state="commandState" />
  </div>
</template>

<style scoped>
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
  height: 100%;
  width: 100%;
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

/* Sidebar resize handle — a thin draggable strip between sidebar and main. */
.sidebar-resizer {
  flex-shrink: 0;
  width: 5px;
  cursor: ew-resize;
  background: transparent;
  z-index: 5;
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
