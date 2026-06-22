<script setup>
import { ref, computed, reactive, watch, onMounted } from 'vue'
import Ribbon from './components/layout/Ribbon.vue'
import Sidebar from './components/layout/Sidebar.vue'
import Viewer3D from './components/viewers/Viewer3D.vue'
import ViewerMap from './components/viewers/ViewerMap.vue'
import ViewerImage from './components/viewers/ViewerImage.vue'
import ImageInfoModal from './components/modals/ImageInfoModal.vue'
import DetectFeaturesModal from './components/modals/DetectFeaturesModal.vue'
import MatchFeaturesModal from './components/modals/MatchFeaturesModal.vue'
import ImageTableModal from './components/modals/ImageTableModal.vue'
import SensorTableModal from './components/modals/SensorTableModal.vue'
import MatchListModal from './components/modals/MatchListModal.vue'
import ProgressModal from './components/modals/ProgressModal.vue'
import SettingsModal from './components/modals/SettingsModal.vue'
import AboutModal from './components/modals/AboutModal.vue'
import NewProjectModal from './components/modals/NewProjectModal.vue'
import ProjectPicker from './components/layout/ProjectPicker.vue'
import DevConsole from './components/layout/DevConsole.vue'
import { useImages } from './composables/useImages.js'
import { useMatches } from './composables/useMatches.js'
import { useTabs } from './composables/useTabs.js'
import { useProjects } from './composables/useProjects.js'
import { useTheme } from './composables/useTheme.js'
import { useModals } from './composables/useModals.js'
import { usePipeline } from './composables/usePipeline.js'
import { useReconstruction } from './composables/useReconstruction.js'
import { useGcps } from './composables/useGcps.js'
import { useFootprints } from './composables/useFootprints.js'
import { useSensors } from './composables/useSensors.js'
import { usePoses } from './composables/usePoses.js'
import ReconstructModal from './components/modals/ReconstructModal.vue'
import GcpImportModal from './components/modals/GcpImportModal.vue'
import GcpTableModal from './components/modals/GcpTableModal.vue'
import FootprintImportModal from './components/modals/FootprintImportModal.vue'
import CameraImportModal from './components/modals/CameraImportModal.vue'
import { parseGeoJson, looksLikeGeoJson, geoJsonToGcps, guessNameKey } from './utils/geojson.js'
import { detectCameraMode } from './utils/camera.js'
import { buildPosesCsv, buildSensorsCsv, downloadCsv } from './utils/exportCsv.js'
import * as opfs from './utils/opfs.js'
import { ensureProjection } from './utils/crs.js'

// ── Theme ─────────────────────────────────────────────────────────────────────
const { theme, applyTheme, setTheme } = useTheme()

// ── Projects ──────────────────────────────────────────────────────────────────
const {
  persistenceAvailable, projects, currentProjectId, currentProjectName, currentSceneType, currentCrs,
  setPersistenceAvailable, loadIndex, createProject, setProjectCrs, switchProject, renameProject,
  deleteProjectById,
} = useProjects()

async function syncProject(imgs) {
  if (!persistenceAvailable.value || !currentProjectId.value) return
  const proj = projects.value.find((p) => p.id === currentProjectId.value)
  if (!proj) return
  await opfs.writeProject(currentProjectId.value, {
    ...proj,
    lastModified: new Date().toISOString(),
    images: imgs.map((img) => {
      // eslint-disable-next-line no-unused-vars
      const { raw: _raw, ...metaToSave } = img.meta ?? {}
      return {
        id: img.id, uuid: img.uuid, name: img.name,
        kpStatus: img.kpStatus, kpCount: img.kpCount, kpMs: img.kpMs,
        hasMask: !!img.mask, hasDepth: !!img.depth,
        sensorId: img.sensorId ?? null,
        meta: img.meta ? metaToSave : null,
      }
    }),
  })
}

const persistContext = { enabled: persistenceAvailable, projectId: currentProjectId, sync: syncProject }

// ── Images ────────────────────────────────────────────────────────────────────
const {
  images, selectedId,
  imageById, selectImage,
  addImages, removeImage,
  updateMask, updateDepth, detectAll, clearKeypoints, clearAll,
  restoreImages,
} = useImages({ persist: persistContext })

// ── Matches ───────────────────────────────────────────────────────────────────
const { matchStore, matchAll, restoreMatches, clearMatches } = useMatches({ persist: persistContext })

// ── Tabs ──────────────────────────────────────────────────────────────────────
const showMap = computed(() => currentSceneType.value !== 'object')

const {
  tabs, activeTabId,
  activeTab, activeImageTab, activeView,
  activateTab, openImageTab,
  closeTab, closeTabForImage, onImageDetected, resetToViewer,
} = useTabs(imageById, showMap)

// ── Reconstruction ────────────────────────────────────────────────────────────
const {
  cameras, points3d, reconStatus, reconSummary,
  reconstruct, clearReconstruction, restoreReconstruction,
} = useReconstruction({ images, matchStore, persist: persistContext })

// ── Ground Control Points ───────────────────────────────────────────────────────
const {
  gcps, addGcps, setGcpAccuracy, removeGcp, clearGcps, restoreGcps, reprojectGcps,
} = useGcps({ images, currentCrs, persist: persistContext })

// ── Footprints ──────────────────────────────────────────────────────────────────
const {
  footprints, addFootprints, clearFootprints, restoreFootprints, reprojectFootprints,
} = useFootprints({ images, currentCrs, persist: persistContext })

// ── Sensors (shared intrinsics) ───────────────────────────────────────────────────
const {
  sensors, imageCount: sensorImageCount,
  addSensors, updateSensor, assignSensor, mergeSensors, removeSensor, clearSensors, restoreSensors,
} = useSensors({ images, persist: persistContext })

// ── Camera poses (extrinsics) ─────────────────────────────────────────────────────
const {
  poses, addPoses, removePose, clearPoses, restorePoses, reprojectPoses,
} = usePoses({ images, currentCrs, persist: persistContext })

// ── Modals ────────────────────────────────────────────────────────────────────
const {
  settingsOpen, aboutOpen,
  projectPickerOpen, newProjectOpen, newProjectCanCancel,
  detectFeaturesOpen, matchFeaturesOpen,
  imageTableOpen, sensorTableOpen, gcpTableOpen, matchListOpen, reconstructOpen,
  gcpImportOpen, gcpImportText, gcpImportName, gcpImportGeojson, gcpImportCrs,
  footprintImportOpen, footprintImportData,
  cameraImportOpen, cameraImportText, cameraImportName, cameraImportMode,
  infoImageId, infoImage,
} = useModals(imageById)

// ── Pipeline ──────────────────────────────────────────────────────────────────
const {
  progressOpen, progressTitle, progressCurrent, progressTotal, progressLabel,
  runDetect, runMatch, runReconstruct,
} = usePipeline({ images, detectAll, matchAll, onImageDetected, reconstruct })

// ── Derived state ──────────────────────────────────────────────────────────────
const selected = computed(() => images.value.find((img) => img.id === selectedId.value) || null)

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
    })
  }
  return result
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

watch(reconStatus, (s) => {
  if (s === 'done') viewerRef.value?.setReconstructionData(cameras.value, points3d.value)
})

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
  clearReconstruction()
  viewerRef.value?.clearReconstructionData()
  // Restore sensors before images: EXIF auto-grouping reacts to the image list,
  // so the saved sensors must already be in place or it would mint duplicates
  // and clobber manual sensor assignments.
  await restoreSensors(id)
  await restoreImages(projectData.images || [], id)
  await restoreMatches(id)
  await restoreReconstruction(id)
  await restoreGcps(id, projectData.crs)
  await restoreFootprints(id, projectData.crs)
  await restorePoses(id, projectData.crs)
  if (reconStatus.value === 'done')
    viewerRef.value?.setReconstructionData(cameras.value, points3d.value)
}

// ── New project ───────────────────────────────────────────────────────────────
async function handleCreateProject({ name, sceneType, crs }) {
  newProjectOpen.value = false
  clearAll(resetToViewer)
  clearMatches()
  clearGcps()
  clearFootprints()
  clearSensors()
  clearPoses()
  clearReconstruction({ purge: true })
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

async function onGcpImport({ gcps: parsed, sourceCrs }) {
  gcpImportOpen.value = false
  gcpImportGeojson.value = null
  await addGcps(parsed, sourceCrs)
  activateTab('map')
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

// ── Project picker actions ────────────────────────────────────────────────────
async function handleSwitchProject(id) {
  if (id === currentProjectId.value) { projectPickerOpen.value = false; return }
  projectPickerOpen.value = false
  clearAll(resetToViewer)
  clearMatches()
  clearGcps()
  clearFootprints()
  clearSensors()
  clearPoses()
  await openProject(id)
}

async function handleDeleteProject(id) {
  const nextId = await deleteProjectById(id)
  if (id === currentProjectId.value) {
    clearAll(resetToViewer)
    clearGcps()
    clearFootprints()
    clearSensors()
    clearPoses()
    clearReconstruction({ purge: true })
    viewerRef.value?.clearReconstructionData()
    if (nextId) await openProject(nextId)
    else { newProjectCanCancel.value = false; newProjectOpen.value = true }
  }
}

// ── Pipeline handlers (close modal, then delegate to usePipeline) ─────────────
function onDetectRun(settings)      { detectFeaturesOpen.value = false;  runDetect(settings)      }
function onMatchRun(settings)       { matchFeaturesOpen.value  = false;  runMatch(settings)       }
function onReconstructRun(settings) { reconstructOpen.value    = false;  runReconstruct(settings) }

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
    case 'clear-all':            clearAll(resetToViewer); clearMatches(); clearGcps(); clearFootprints(); clearSensors(); clearPoses(); clearReconstruction({ purge: true }); viewerRef.value?.clearReconstructionData(); break
    case 'remove-selected':      if (selectedId.value) removeImage(selectedId.value, closeTabForImage); break
    case 'view-viewer':          activateTab('viewer'); break
    case 'view-map':             activateTab('map'); break
    case 'open-image-table':     imageTableOpen.value = true; break
    case 'open-sensor-table':    sensorTableOpen.value = true; break
    case 'open-gcp-table':       gcpTableOpen.value = true; break
    case 'open-match-list':      matchListOpen.value = true; break
    case 'reconstruct':          reconstructOpen.value = true; break
    case 'detect-features':      detectFeaturesOpen.value = true; break
    case 'match-features':       matchFeaturesOpen.value = true; break
    case 'open-settings':        settingsOpen.value = true; break
    case 'open-about':           aboutOpen.value = true; break
    case 'open-project-picker':  projectPickerOpen.value = !projectPickerOpen.value; break
    case 'toggle-console':       consoleOpen.value = !consoleOpen.value; break
    case 'img-show-info':        if (activeImageTab.value) infoImageId.value = activeImageTab.value.id; break
    case 'img-remove':           if (activeImageTab.value) removeImage(activeImageTab.value.id, closeTabForImage); break
    case 'img-toggle-keypoints': {
      const tab = activeTab.value
      if (tab?.type === 'image') tab.showKeypoints = !tab.showKeypoints
      break
    }
    case 'img-toggle-mask': {
      const tab = activeTab.value
      if (tab?.type === 'image') tab.showMask = !tab.showMask
      break
    }
    case 'img-toggle-depth': {
      const tab = activeTab.value
      if (tab?.type === 'image') tab.showDepth = !tab.showDepth
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
    case 'img-depth-import': imageViewerRefs[activeImageTab.value?.id]?.triggerDepthImport(); break
    case 'img-depth-clear':  imageViewerRefs[activeImageTab.value?.id]?.clearDepth(); break
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
      :gcp-count="gcps.length"
      :pose-count="poses.length"
      :sensor-count="sensors.length"
      :active-image-id="activeImageTab?.id ?? null"
      :active-image-name="activeImageTab?.name ?? null"
      :image-view-state="activeImageViewState"
      :console-open="consoleOpen"
      :persistence-enabled="persistenceAvailable"
      :current-project-name="currentProjectName"
      :scene-type="currentSceneType"
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
      <GcpImportModal
        v-if="gcpImportOpen"
        :raw-text="gcpImportText"
        :file-name="gcpImportName"
        :project-crs="currentCrs"
        :geojson-gcps="gcpImportGeojson"
        :detected-crs="gcpImportCrs"
        @close="gcpImportOpen = false; gcpImportGeojson = null; gcpImportText = ''; gcpImportCrs = null"
        @import="onGcpImport"
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
      <CameraImportModal
        v-if="cameraImportOpen"
        :raw-text="cameraImportText"
        :file-name="cameraImportName"
        :project-crs="currentCrs"
        :detected-mode="cameraImportMode"
        @close="cameraImportOpen = false"
        @import="onCameraImport"
      />
    </Teleport>

    <Teleport to="body">
      <ProgressModal
        v-if="progressOpen"
        :title="progressTitle"
        :current="progressCurrent"
        :total="progressTotal"
        :label="progressLabel"
      />
    </Teleport>

    <Teleport to="body">
      <SettingsModal
        v-if="settingsOpen"
        :theme="theme"
        :crs="currentProjectId ? currentCrs : null"
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
    </Teleport>

    <Teleport to="body">
      <SensorTableModal
        v-if="sensorTableOpen"
        :sensors="sensors"
        :images="images"
        :cameras="cameras"
        @close="sensorTableOpen = false"
        @update="({ id, field, value }) => updateSensor(id, field, value)"
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

    <div class="layout">
      <Sidebar
        :images="images"
        :gcps="gcps"
        :sensors="sensors"
        :poses="poses"
        :reconstruction="reconSummary"
        :sensor-image-count="sensorImageCount"
        :selected-id="selectedId"
        @add-images="addImages"
        @gcp-file="openImportFile"
        @remove-image="(id) => removeImage(id, closeTabForImage)"
        @remove-gcp="removeGcp"
        @remove-sensor="removeSensor"
        @merge-sensors="({ target, source }) => mergeSensors(target, source)"
        @assign-sensor="({ imageId, sensorId }) => assignSensor(imageId, sensorId)"
        @remove-pose="removePose"
        @select="selectImage"
        @open="(id) => openImageTab(id)"
        @show-info="infoImageId = $event"
        @delete-keypoints="clearKeypoints"
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
          <Viewer3D ref="viewerRef" v-show="activeTabId === 'viewer'" :theme="theme" />
          <ViewerMap v-show="activeTabId === 'map'" :images="images" :gcps="gcps" :footprints="footprints" :selected-id="selectedId" :crs="currentCrs" @select="selectImage" />
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
