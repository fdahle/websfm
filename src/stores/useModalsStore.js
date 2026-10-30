import { ref } from 'vue'
import { defineStore } from 'pinia'

// Pure UI state: which modals/dialogs are open and the transient payloads they
// carry while open. Not project-scoped — it does not persist or restore, so it
// is a plain Pinia store (no project-store registry contract).
//
// NOTE: `infoImage` (the resolved image for the Image Info modal) lives in App.vue
// rather than here, because resolving it needs the image list. Once images become
// a store, that computed can move in and read useImagesStore() directly.
export const useModalsStore = defineStore('modals', () => {
  const settingsOpen = ref(false)
  const projectSettingsOpen = ref(false)
  const aboutOpen = ref(false)
  const systemInfoOpen = ref(false)
  const shortcutsOpen = ref(false) // Help ▸ Shortcuts, or ?
  const whatsNewOpen = ref(false)
  const projectPickerOpen = ref(false)
  const newProjectOpen = ref(false)
  const newProjectCanCancel = ref(true)
  const saveProjectOpen = ref(false) // Export project file (.websfm) options
  const workflowBuilderOpen = ref(false)
  const detectFeaturesOpen = ref(false)
  const matchFeaturesOpen = ref(false)
  const imageTableOpen = ref(false)
  const poseTableOpen = ref(false)
  const maskManagerOpen = ref(false)
  const autoMaskOpen = ref(false)
  const sensorTableOpen = ref(false)
  const gcpTableOpen = ref(false)
  const matchListOpen = ref(false)
  const reconstructOpen = ref(false)
  const findGcpsOpen = ref(false)
  const georeferenceOpen = ref(false)
  const scaleBarsOpen = ref(false) // known-distance constraints (F11)
  const depthMapsOpen = ref(false)
  const denseOpen = ref(false)
  const demOpen = ref(false)
  const orthoOpen = ref(false)
  const meshOpen = ref(false)
  // Cloud editing (crop / filter / merge over dense clouds).
  const cropCloudOpen = ref(false)
  const filterCloudOpen = ref(false)
  const mergeCloudsOpen = ref(false)
  // Filter Cloud opened from a deep link (Point Cloud ▾ ▸ Remove outliers /
  // Subsample) starts on one method; null ⇒ the normal preset.
  const filterCloudPreset = ref(null)
  // The Tools-tab dialogs (Point Cloud ▾ / Mesh ▾ / Model ▾ / Products ▾ / Images ▾)
  // share ONE slot: the open tool's ribbon command id, or null. Tools are one-at-a-
  // time dialogs, and a slot per tool would add a flag + an Escape entry per tool.
  const toolModal = ref(null)
  const gcpImportOpen = ref(false)
  const gcpImportText = ref('')
  const gcpImportName = ref('')
  const gcpImportGeojson = ref(null) // pre-parsed GCPs from a GeoJSON points file, or null
  const gcpImportCrs = ref(null) // CRS detected from the GeoJSON, or null
  const footprintImportOpen = ref(false)
  const footprintImportData = ref(null) // { features, propertyKeys, detectedCrs, fileName }
  const footprintFromPosesOpen = ref(false)
  const cameraImportOpen = ref(false)
  const cameraImportText = ref('')
  const cameraImportName = ref('')
  const cameraImportMode = ref('pose') // sniffed default: 'sensor' | 'pose'
  // Did the USER state what this file is (a Ribbon ▸ Import command, or the
  // "what is this file?" chooser), or did we sniff it (drag-and-drop)? The two
  // tabular import modals ask their "Import as" question prominently only in
  // the sniffed case; a declared kind gets a one-line correction link instead.
  const importKindDeclared = ref(false)
  // Fiducial import preview: { kind: 'image', fileName, rows, layout } |
  // { kind: 'camera', fileName, groups } while open, else null.
  const fiducialImportData = ref(null)
  const importKindOpen = ref(false) // "what is this dropped file?" chooser
  const importKindFile = ref(null) // the File awaiting a kind choice, or null
  const importCloudOpen = ref(false) // point-cloud / mesh import settings
  const importCloudData = ref(null) // { parsed, stats, fileName } from the parseCloud op
  // Reference-raster import. Only opened when the DEM-vs-ortho sniff was LOW
  // confidence — a high-confidence sniff imports silently (the kind stays
  // editable on the sidebar row, which is what makes that defensible).
  const importRasterOpen = ref(false)
  const importRasterData = ref(null) // { raster: RasterMeta, fileName }
  // Import ▸ Video: the video File whose frame-selection dialog is open, or null.
  const importVideoFile = ref(null)
  // Band math / stretch for a multi-band raster. Holds the raster id, not the
  // record — the record is replaced wholesale by a restyle's re-decode.
  const rasterStyleId = ref(null)
  // Symbology for a computed DEM / ortho or a cloud (its id).
  const symbologyProductId = ref(null)
  const symbologyCloudId = ref(null)
  // Import ▸ SfM project: choose files or a folder before the import session opens.
  const sfmSourceOpen = ref(false)
  // Import ▸ Project into this project: choose which other project (useProjectMerge).
  const importProjectOpen = ref(false)
  const infoImageId = ref(null)
  // Show information on a product: { cloudId } (sparse, dense, mesh) or { productId } (a DEM / ortho).
  const infoProduct = ref(null)
  // Automatic fiducial measurement on film scans. Holds the sensor id, not the
  // record — the modal reads the live sensor back out of the sensors store.
  const fiducialDetectOpen = ref(false)
  const reseauOpen = ref(false)
  const panoramicOpen = ref(false)
  const fiducialDetectSensorId = ref(null)
  const fiducialCalibrateOpen = ref(false)
  const fiducialCalibrateSensorId = ref(null)
  // Evaluate tab — the Quality Report hub (PLAN-eval-quality-hub). One modal, opened
  // on a given section; the old per-view flags collapsed into these two.
  const qualityOpen = ref(false)
  const qualitySection = ref('overview')
  // Debug ▸ Project Summary — compact copy-pasteable reconstruction-health digest.
  const debugSummaryOpen = ref(false)

  return {
    settingsOpen,
    projectSettingsOpen,
    aboutOpen,
    systemInfoOpen,
    shortcutsOpen,
    whatsNewOpen,
    projectPickerOpen,
    newProjectOpen,
    newProjectCanCancel,
    saveProjectOpen,
    workflowBuilderOpen,
    detectFeaturesOpen,
    matchFeaturesOpen,
    imageTableOpen,
    poseTableOpen,
    maskManagerOpen,
    autoMaskOpen,
    sensorTableOpen,
    gcpTableOpen,
    matchListOpen,
    reconstructOpen,
    findGcpsOpen,
    georeferenceOpen,
    scaleBarsOpen,
    depthMapsOpen,
    denseOpen,
    demOpen,
    orthoOpen,
    meshOpen,
    cropCloudOpen,
    filterCloudOpen,
    mergeCloudsOpen,
    filterCloudPreset,
    toolModal,
    gcpImportOpen,
    gcpImportText,
    gcpImportName,
    gcpImportGeojson,
    gcpImportCrs,
    footprintImportOpen,
    footprintImportData,
    footprintFromPosesOpen,
    cameraImportOpen,
    cameraImportText,
    cameraImportName,
    cameraImportMode,
    importKindDeclared,
    fiducialImportData,
    importKindOpen,
    importKindFile,
    importCloudOpen,
    importCloudData,
    importRasterOpen,
    importRasterData,
    importVideoFile,
    rasterStyleId,
    symbologyProductId,
    symbologyCloudId,
    sfmSourceOpen,
    importProjectOpen,
    infoImageId,
    infoProduct,
    fiducialDetectOpen,
    reseauOpen,
    panoramicOpen,
    fiducialDetectSensorId,
    fiducialCalibrateOpen,
    fiducialCalibrateSensorId,
    qualityOpen,
    qualitySection,
    debugSummaryOpen,
  }
})
