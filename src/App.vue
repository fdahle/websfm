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
import HelpPanelStack from './components/help/HelpPanelStack.vue'
import ProjectPicker from './components/layout/ProjectPicker.vue'
import DevConsole from './components/layout/DevConsole.vue'
import { useImagesStore } from './stores/useImagesStore.js'
import { useMatchesStore } from './stores/useMatchesStore.js'
import { useTabs } from './composables/useTabs.js'
import { useProjectsStore } from './stores/useProjectsStore.js'
import { useTheme } from './composables/useTheme.js'
import { useModalsStore } from './stores/useModalsStore.js'
import { usePipeline } from './composables/usePipeline.js'
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
import { parseGeoJson, looksLikeGeoJson, geoJsonToGcps, guessNameKey } from './core/geojson.js'
import { detectCameraMode } from './utils/camera.js'
import { detectFileKind } from './utils/importKind.js'
import { buildPosesCsv, buildSensorsCsv, downloadCsv } from './utils/exportCsv.js'
import { cloudToPly, reconstructionToJson, demToAsciiGrid, demToGeoTiff, orthoToGeoTiff, rasterWorldFile } from './core/exporters.js'
import { downloadBlob, dataUrlToBlob } from './utils/download.js'
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
  restoreImages,
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
  activeTab, activeImageTab, activeView,
  activateTab, openImageTab, openProductTab,
  closeTab, closeTabForImage, onImageDetected, resetToViewer,
} = useTabs(imageById, showMap)

// ── Reconstruction ────────────────────────────────────────────────────────────
// Project-scoped store; restore/clear run through the project-store registry.
const reconstructionStore = useReconstructionStore()
const { cameras, sparseCameras, points3d, reconStatus, clouds, selectedCloudId, selectedCloud, depthMaps, dem, ortho, georef, canGeoreference } = storeToRefs(reconstructionStore)
const { reconstruct, computeDepthMaps, densify, generateDem, generateOrtho, georeference, selectCloud, removeCloud, renameCloud } = reconstructionStore

// Clicking a point cloud in the sidebar shows it in the 3D viewer.
function showCloud(id) {
  selectCloud(id)
  activateTab('viewer')
}

// ── Ground Control Points ───────────────────────────────────────────────────────
const gcpsStore = useGcpsStore()
const { gcps } = storeToRefs(gcpsStore)
const { addGcps, setGcpAccuracy, removeGcp, reprojectGcps } = gcpsStore

// ── Footprints ──────────────────────────────────────────────────────────────────
const footprintsStore = useFootprintsStore()
const { footprints } = storeToRefs(footprintsStore)
const { addFootprints, computeFootprints, reprojectFootprints } = footprintsStore

// ── Sensors (shared intrinsics) ───────────────────────────────────────────────────
// Project-scoped, but restored/cleared manually (must precede images — its EXIF
// auto-grouping watcher reacts to the image list).
const sensorsStore = useSensorsStore()
const { sensors } = storeToRefs(sensorsStore)
const {
  imageCount: sensorImageCount,
  addSensors, updateSensor, toggleSensorFixed, assignSensor, mergeSensors, removeSensor, clearSensors, restoreSensors,
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

const hasSparse = computed(() => clouds.value.some((c) => c.kind === 'sparse'))

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
      nameA:       imgA.name,
      nameB:       imgB.name,
      inlierCount: entry.inlierCount,
      rawCount:    entry.rawCount,
      usedCount:   usedMatchesByPair.value.get(pid)?.size ?? 0,
    })
  }
  return result
})

// Sidebar summary of the pairwise match store: verified/total/running/failed counts.
// `verified` mirrors matchSummaries.length (done + inliers), but we walk the store
// once here to also surface in-flight and failed pairs at a glance.
const matchStats = computed(() => {
  let total = 0, verified = 0, running = 0, error = 0
  for (const [, entry] of matchStore.value) {
    total++
    if (entry.status === 'running') running++
    else if (entry.status === 'error') error++
    else if (entry.status === 'done' && entry.inlierCount > 0) verified++
  }
  // Pairs that contributed at least one tie-point to the sparse model (0 until
  // reconstruction has run).
  const used = hasSparse.value ? usedMatchesByPair.value.size : null
  return { total, verified, running, error, used }
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
    maskMode:      tab.maskMode,
    brushRadius:   tab.brushRadius,
    kpStatus:      img.kpStatus,
    kpCount:       img.kpCount,
    hasMask:       !!img.mask,
    hasDepth:      !!img.depth,
    gcpCount:      activeImageGcps.value.length,
  }
})

// GCP observations falling on the active image tab (for marker overlay).
const activeImageGcps = computed(() => {
  const tab = activeTab.value
  if (!tab || tab.type !== 'image') return []
  const out = []
  for (const g of gcps.value) {
    if (g.enabled === false) continue
    for (const obs of g.observations || []) {
      if (obs.imageId === tab.imageId && obs.px != null && obs.py != null) {
        out.push({ name: g.name, px: obs.px, py: obs.py })
      }
    }
  }
  return out
})

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

// ── Console ───────────────────────────────────────────────────────────────────
const consoleOpen = ref(localStorage.getItem('consoleOpen') === 'true')
watch(consoleOpen, (v) => localStorage.setItem('consoleOpen', v))

// ── Bootstrap ─────────────────────────────────────────────────────────────────
onMounted(async () => {
  applyTheme(theme.value)
  window.addEventListener('keydown', (e) => {
    if (e.key === '`' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      consoleOpen.value = !consoleOpen.value
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

async function openProject(id) {
  const projectData = await switchProject(id)
  if (!projectData) return
  if (projectData.crs) await ensureProjection(projectData.crs).catch(() => {})
  resetToViewer()
  viewerRef.value?.clearReconstructionData()
  // Restore sensors before images: EXIF auto-grouping reacts to the image list,
  // so the saved sensors must already be in place or it would mint duplicates
  // and clobber manual sensor assignments. Both have bespoke restore signatures,
  // so they stay manual; every other project-scoped store restores through the
  // registry below (matches, reconstruction, GCPs, footprints, poses).
  await restoreSensors(id)
  await restoreImages(projectData.images || [], id)
  await restoreProjectStores({ projectId: id, projectData })
  // restore() sets selectedCloud, which the watcher pushes into the viewer.
}

// ── New project ───────────────────────────────────────────────────────────────
async function handleCreateProject({ name, sceneType, crs }) {
  newProjectOpen.value = false
  clearAll(resetToViewer)
  clearSensors()
  clearProjectStores({ purge: true })   // matches, reconstruction, GCPs, footprints, poses
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

// ── Import (GCPs / footprints) ──────────────────────────────────────────────────
// A delimited text file is always GCPs. A GeoJSON file is routed by geometry:
// point features → GCP import, polygon features → footprint import.
async function openImportFile(file) {
  if (!file) return
  let text
  try {
    text = await file.text()
  } catch (err) {
    console.error('Could not read import file', err)
    return
  }

  if (looksLikeGeoJson(file.name, text)) {
    const parsed = parseGeoJson(text)
    if (parsed.kind === 'polygons' || parsed.kind === 'mixed') {
      footprintImportData.value = {
        features: parsed.features,
        propertyKeys: parsed.propertyKeys,
        detectedCrs: parsed.sourceCrs,
        fileName: file.name,
      }
      footprintImportOpen.value = true
    }
    if (parsed.kind === 'points' || parsed.kind === 'mixed') {
      const nameKey = guessNameKey(parsed.propertyKeys)
      gcpImportGeojson.value = geoJsonToGcps(parsed.features, nameKey)
      gcpImportCrs.value = parsed.sourceCrs
      gcpImportName.value = file.name
      gcpImportOpen.value = true
    }
    return
  }

  // Delimited-text GCP file.
  gcpImportGeojson.value = null
  gcpImportCrs.value = null
  gcpImportText.value = text
  gcpImportName.value = file.name
  gcpImportOpen.value = true
}

// Sidebar drag-and-drop has no declared intent, so classify the dropped file and
// route it: GCPs/footprints → GCP importer, poses/intrinsics → camera importer,
// and anything ambiguous (a bare name + X/Y/Z list) → a small chooser.
async function openDroppedImport(file) {
  if (!file) return
  let text
  try {
    text = await file.text()
  } catch (err) {
    console.error('Could not read dropped file', err)
    return
  }
  routeImport(file, detectFileKind(text, file.name).kind)
}

function routeImport(file, kind) {
  if (kind === 'pose' || kind === 'sensor') openCameraImport(file, kind)
  else if (kind === 'gcp' || kind === 'footprint') openImportFile(file)
  else { importKindFile.value = file; importKindOpen.value = true }
}

// User answered the "what is this file?" chooser.
function onImportKindChosen(kind) {
  const file = importKindFile.value
  importKindOpen.value = false
  importKindFile.value = null
  if (file) routeImport(file, kind)
}

// User re-classified the file from inside an open import modal ("Import as …").
function onImportSwitchKind({ kind, rawText, fileName }) {
  gcpImportOpen.value = false
  cameraImportOpen.value = false
  if (kind === 'gcp') {
    gcpImportGeojson.value = null
    gcpImportCrs.value = null
    gcpImportText.value = rawText
    gcpImportName.value = fileName
    gcpImportOpen.value = true
  } else {
    cameraImportText.value = rawText
    cameraImportName.value = fileName
    cameraImportMode.value = kind // 'pose' | 'sensor'
    cameraImportOpen.value = true
  }
}

// Switch to the map and centre it on an image's position (pose or EXIF GPS).
function zoomToImagePosition(imgId) {
  activateTab('map')
  nextTick(() => mapViewerRef.value?.zoomToImage(imgId))
}

async function onGcpImport({ gcps: parsed, sourceCrs }) {
  gcpImportOpen.value = false
  gcpImportGeojson.value = null
  await addGcps(parsed, sourceCrs)
  activateTab('map')
}

function onFootprintFromPoses(settings) {
  footprintFromPosesOpen.value = false
  const { computed: n } = computeFootprints(settings)
  if (n > 0) activateTab('map')
}

async function onFootprintImport({ footprints: parsed, sourceCrs }) {
  footprintImportOpen.value = false
  footprintImportData.value = null
  await addFootprints(parsed, sourceCrs)
  activateTab('map')
}

function onGcpPick(event) {
  const file = event.target.files?.[0]
  if (file) openImportFile(file)
  event.target.value = ''
}

// ── Import (camera intrinsics / extrinsics) ──────────────────────────────────────
// A delimited camera file opens the import modal in the sniffed mode (sensor vs
// pose); `forceMode` lets the Ribbon's two commands hint a default.
async function openCameraImport(file, forceMode = null) {
  if (!file) return
  let text
  try {
    text = await file.text()
  } catch (err) {
    console.error('Could not read camera file', err)
    return
  }
  cameraImportText.value = text
  cameraImportName.value = file.name
  cameraImportMode.value = forceMode || detectCameraMode(text)
  cameraImportOpen.value = true
}

async function onCameraImport(payload) {
  cameraImportOpen.value = false
  if (payload.mode === 'sensor') {
    await addSensors(payload.sensors)
  } else {
    await addPoses(payload.poses, payload.sourceCrs)
    activateTab('map')
  }
}

function onCameraPick(event) {
  const file = event.target.files?.[0]
  if (file) openCameraImport(file, cameraPickMode.value)
  event.target.value = ''
}

// ── Export (camera params) ───────────────────────────────────────────────────────
function exportPoses() {
  if (!poses.value.length) return
  downloadCsv(`${currentProjectName.value || 'project'}-poses.csv`, buildPosesCsv(poses.value, currentCrs.value))
}

function exportSensors() {
  if (!sensors.value.length) return
  downloadCsv(`${currentProjectName.value || 'project'}-sensors.csv`, buildSensorsCsv(sensors.value))
}

function saveJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function exportKeypoints() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
  const data = images.value
    .filter(img => img.kpStatus === 'done' && img.keypoints?.length)
    .map(img => ({
      image: img.name,
      uuid: img.uuid,
      kpCount: img.kpCount,
      keypoints: img.keypoints.map(kp => ({ x: kp.x, y: kp.y, scale: kp.scale, response: kp.response })),
    }))
  saveJson(data, `keypoints-${stamp}.json`)
}

function exportMatches() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
  const byUuid = Object.fromEntries(images.value.map(img => [img.uuid, img.name]))
  const data = []
  for (const [, entry] of matchStore.value) {
    if (entry.status !== 'done') continue
    data.push({
      imageA: byUuid[entry.idA] ?? entry.idA,
      imageB: byUuid[entry.idB] ?? entry.idB,
      rawCount: entry.rawCount,
      inlierCount: entry.inlierCount,
      matches: entry.matches,
    })
  }
  saveJson(data, `matches-${stamp}.json`)
}

const projectBase = () => currentProjectName.value || 'project'

// Which export dialog is open ('cloud' | 'model' | 'dem' | 'ortho'), or null.
const exportKind = ref(null)

// Parse the current DEM's CRS into an EPSG code + geographic flag for GeoTIFF /
// .prj. The working CRS is a proj4 string or "EPSG:xxxx"; only the latter yields a
// code (else the geotransform is still written, without a CRS).
function crsInfo(source) {
  const crs = source?.crs
  if (!crs || crs === 'local') return { crs: null, code: null, geographic: false }
  const m = /EPSG:(\d+)/i.exec(crs)
  const code = m ? Number(m[1]) : null
  const geographic = code === 4326 || /degree|deg\b/i.test(source.unit || '')
  return { crs, code, geographic }
}

function onExportRun(settings) {
  const kind = exportKind.value
  exportKind.value = null
  if (kind === 'cloud') doExportCloud(settings)
  else if (kind === 'model') doExportModel(settings)
  else if (kind === 'dem') doExportDem(settings)
  else if (kind === 'ortho') doExportOrtho(settings)
}

// Point cloud (selected, else the first non-empty) → PLY.
function doExportCloud({ format, includeColor }) {
  const cloud = selectedCloud.value?.points?.length
    ? selectedCloud.value
    : clouds.value.find((c) => c.points.length > 0)
  if (!cloud) return
  const binary = format !== 'ply-ascii'
  const ply = cloudToPly(cloud.points, { binary, color: includeColor })
  downloadBlob(`${projectBase()}-${cloud.kind}.ply`, ply, binary ? 'application/octet-stream' : 'text/plain;charset=utf-8')
}

// SfM cameras (+ optional tracks) → JSON interchange (uses the sparse cloud).
function doExportModel({ includeTracks }) {
  const cloud = clouds.value.find((c) => c.kind === 'sparse')
    ?? (selectedCloud.value?.cameras?.size ? selectedCloud.value : null)
  if (!cloud) return
  const cams = [...cloud.cameras.entries()].map(([uuid, c]) => ({ uuid, R: c.R, t: c.t, K: c.K }))
  const pts = cloud.points.map((p) => ({
    x: p.x, y: p.y, z: p.z, color: p.color,
    views: includeTracks && p.views ? [...p.views.entries()] : [],
  }))
  saveJson(reconstructionToJson(cams, pts, currentCrs.value), `${projectBase()}-model.json`)
}

// DEM → GeoTIFF, or ESRI ASCII grid (+ .prj sidecar carrying the CRS).
function doExportDem({ format, nodata }) {
  if (!dem.value) return
  const info = crsInfo(dem.value)
  if (format === 'geotiff') {
    downloadBlob(`${projectBase()}-dem.tif`, demToGeoTiff(dem.value, { crs: info, nodata }), 'image/tiff')
    return
  }
  downloadBlob(`${projectBase()}-dem.asc`, demToAsciiGrid(dem.value, { nodata }), 'text/plain;charset=utf-8')
  if (info.crs) downloadBlob(`${projectBase()}-dem.prj`, info.crs, 'text/plain;charset=utf-8')
}

// Ortho → GeoTIFF, or PNG + world file (.wld) + .prj. Shares the DEM's geotransform.
async function doExportOrtho({ format }) {
  if (!ortho.value || !dem.value) return
  const info = crsInfo(dem.value)
  if (format === 'geotiff') {
    downloadBlob(`${projectBase()}-ortho.tif`, orthoToGeoTiff(ortho.value, dem.value, { crs: info }), 'image/tiff')
    return
  }
  if (!ortho.value.previewDataUrl) return
  downloadBlob(`${projectBase()}-ortho.png`, await dataUrlToBlob(ortho.value.previewDataUrl))
  downloadBlob(`${projectBase()}-ortho.wld`, rasterWorldFile(dem.value), 'text/plain;charset=utf-8')
  if (info.crs) downloadBlob(`${projectBase()}-ortho.prj`, info.crs, 'text/plain;charset=utf-8')
}

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
// Products: build, then pop the preview so the result is immediately visible.
async function onDemRun(settings)   { demOpen.value = false;   await runGenerateDem(settings);   if (dem.value) openProductTab('dem') }
async function onOrthoRun(settings) { orthoOpen.value = false; await runGenerateOrtho(settings); if (ortho.value) openProductTab('ortho') }

// ── Image deletion (with confirmation) ────────────────────────────────────────
// Removing images is irreversible (drops keypoints/masks/matches), so route every
// delete request through a confirm dialog. Holds the pending image ids + names.
const pendingImageDelete = ref(null)

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
const cameraPickMode = ref(null) // sensor | pose | null, set before opening the file picker

// ── Commands ──────────────────────────────────────────────────────────────────
function handleCommand(id) {
  switch (id) {
    case 'import-images':        ribbonInput.value.click(); break
    case 'import-gcps':          gcpInput.value.click(); break
    case 'import-camera-list':   cameraPickMode.value = 'pose';   cameraInput.value.click(); break
    case 'import-calib':         cameraPickMode.value = 'sensor'; cameraInput.value.click(); break
    case 'export-cameras':       exportPoses(); break
    case 'export-sensors':       exportSensors(); break
    case 'export-cloud':         exportKind.value = 'cloud'; break
    case 'export-model':         exportKind.value = 'model'; break
    case 'export-dem':           exportKind.value = 'dem'; break
    case 'export-ortho':         exportKind.value = 'ortho'; break
    case 'export-keypoints':     exportKeypoints(); break
    case 'export-matches':       exportMatches(); break
    case 'clear-all':            clearAll(resetToViewer); clearSensors(); clearProjectStores({ purge: true }); viewerRef.value?.clearReconstructionData(); break
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
    case 'open-image-table':     imageTableOpen.value = true; break
    case 'open-mask-manager':    maskManagerOpen.value = true; break
    case 'auto-mask':            autoMaskOpen.value = true; break
    case 'open-sensor-table':    sensorTableOpen.value = true; break
    case 'open-gcp-table':       gcpTableOpen.value = true; break
    case 'open-match-list':      matchListOpen.value = true; break
    case 'reconstruct':          reconstructOpen.value = true; break
    case 'compute-depth':        depthMapsOpen.value = true; break
    case 'dense':                denseOpen.value = true; break
    case 'gen-dem':              demOpen.value = true; break
    case 'gen-ortho':            orthoOpen.value = true; break
    case 'view-products':        openProductTab(dem.value ? 'dem' : 'ortho'); break
    case 'auto-georeference':    georeference(); break
    case 'footprints-from-poses': footprintFromPosesOpen.value = true; break
    case 'detect-features':      detectFeaturesOpen.value = true; break
    case 'match-features':       matchFeaturesOpen.value = true; break
    case 'open-settings':        settingsOpen.value = true; break
    case 'open-about':           aboutOpen.value = true; break
    case 'open-project-picker':  projectPickerOpen.value = !projectPickerOpen.value; break
    case 'toggle-console':       consoleOpen.value = !consoleOpen.value; break
    case 'img-show-info':        if (activeImageTab.value) infoImageId.value = activeImageTab.value.id; break
    case 'img-remove':           if (activeImageTab.value) requestRemoveImages(activeImageTab.value.id); break
    case 'img-toggle-keypoints': {
      const tab = activeTab.value
      if (tab?.type === 'image') tab.showKeypoints = !tab.showKeypoints
      break
    }
    case 'img-toggle-mask': {
      const tab = activeTab.value
      // Mask and depth overlays are mutually exclusive — turning one on clears the other.
      if (tab?.type === 'image') {
        tab.showMask = !tab.showMask
        if (tab.showMask) tab.showDepth = false
      }
      break
    }
    case 'img-toggle-depth': {
      const tab = activeTab.value
      if (tab?.type === 'image') {
        tab.showDepth = !tab.showDepth
        if (tab.showDepth) tab.showMask = false
      }
      break
    }
    case 'img-toggle-gcps': {
      const tab = activeTab.value
      if (tab?.type === 'image') tab.showGcps = !tab.showGcps
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
    case 'img-mask-clear':  imageViewerRefs[activeImageTab.value?.id]?.clearMask(); break
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
      @command="handleCommand"
    />
    <input ref="ribbonInput" type="file" accept="image/*" multiple hidden @change="onRibbonPick" />
    <input ref="gcpInput" type="file" accept=".csv,.txt,.tsv,.gcp,.pts,.geojson,.json,application/geo+json,text/*" hidden @change="onGcpPick" />
    <input ref="cameraInput" type="file" accept=".csv,.txt,.tsv,.cam,text/*" hidden @change="onCameraPick" />

    <div v-if="projectPickerOpen && !currentProjectId" class="project-backdrop" />

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
        @close="detectFeaturesOpen = false"
        @run="onDetectRun"
      />
    </Teleport>

    <Teleport to="body">
      <MatchFeaturesModal
        v-if="matchFeaturesOpen"
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
        @remove="removeSensor"
      />
    </Teleport>

    <Teleport to="body">
      <GcpTableModal
        v-if="gcpTableOpen"
        :gcps="gcps"
        :crs="currentCrs"
        @close="gcpTableOpen = false"
        @remove="removeGcp"
        @update-accuracy="({ id, kind, value }) => setGcpAccuracy(id, kind, value)"
      />
    </Teleport>

    <Teleport to="body">
      <MatchListModal
        v-if="matchListOpen"
        :match-summaries="matchSummaries"
        :images="images"
        :match-store="matchStore"
        :has-sparse="hasSparse"
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
      <HelpPanelStack />
    </Teleport>

    <div class="layout">
      <Sidebar
        :images="images"
        :gcps="gcps"
        :sensors="sensors"
        :poses="poses"
        :clouds="clouds"
        :selected-cloud-id="selectedCloudId"
        :recon-status="reconStatus"
        :match-stats="matchStats"
        :sensor-image-count="sensorImageCount"
        :selected-id="selectedId"
        :dem="dem"
        :ortho="ortho"
        @open-product="openProductTab"
        @open-matches="matchListOpen = true"
        @select-cloud="showCloud"
        @remove-cloud="removeCloud"
        @rename-cloud="({ id, name }) => renameCloud(id, name)"
        @reconstruct="reconstructOpen = true"
        @add-images="addImages"
        @import-file="openDroppedImport"
        @remove-image="requestRemoveImages"
        @remove-gcp="removeGcp"
        @remove-sensor="removeSensor"
        @merge-sensors="({ target, source }) => mergeSensors(target, source)"
        @assign-sensor="({ imageId, sensorId }) => assignSensor(imageId, sensorId)"
        @remove-pose="removePose"
        @select="selectImage"
        @open="(id) => openImageTab(id)"
        @show-info="infoImageId = $event"
        @delete-keypoints="clearKeypoints"
        @zoom-to-image="zoomToImagePosition"
      />
      <main class="main">
        <div class="tabstrip">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="tab"
            :class="{ active: tab.id === activeTabId }"
            @click="activateTab(tab.id)"
          >
            <span class="tab-title">{{ tab.title }}</span>
            <span v-if="tab.closable" class="tab-close" title="Close" @click.stop="closeTab(tab.id)">×</span>
          </button>
        </div>

        <div class="content">
          <Viewer3D ref="viewerRef" v-show="activeTabId === 'viewer'" :theme="theme" :images="images" :show-cameras="showCameras" :show-graticule="showGraticule" />
          <ViewerMap ref="mapViewerRef" v-show="activeTabId === 'map'" :images="images" :gcps="gcps" :footprints="footprints" :poses="poses" :selected-id="selectedId" :crs="currentCrs" @select="selectImage" />
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
              :mask-mode="tab.maskMode"
              :brush-radius="tab.brushRadius"
              @update-mask="(dataUrl) => updateMask(tab.imageId, dataUrl)"
              @update-depth="(dataUrl) => updateDepth(tab.imageId, dataUrl)"
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

    <DevConsole v-if="consoleOpen" />
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

</style>
