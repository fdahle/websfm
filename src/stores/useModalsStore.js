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
  const settingsOpen        = ref(false)
  const aboutOpen           = ref(false)
  const projectPickerOpen   = ref(false)
  const newProjectOpen      = ref(false)
  const newProjectCanCancel = ref(true)
  const detectFeaturesOpen  = ref(false)
  const matchFeaturesOpen   = ref(false)
  const imageTableOpen      = ref(false)
  const maskManagerOpen     = ref(false)
  const autoMaskOpen        = ref(false)
  const sensorTableOpen     = ref(false)
  const gcpTableOpen        = ref(false)
  const matchListOpen       = ref(false)
  const reconstructOpen     = ref(false)
  const depthMapsOpen       = ref(false)
  const denseOpen           = ref(false)
  const demOpen             = ref(false)
  const orthoOpen           = ref(false)
  const gcpImportOpen       = ref(false)
  const gcpImportText       = ref('')
  const gcpImportName       = ref('')
  const gcpImportGeojson    = ref(null)   // pre-parsed GCPs from a GeoJSON points file, or null
  const gcpImportCrs        = ref(null)   // CRS detected from the GeoJSON, or null
  const footprintImportOpen = ref(false)
  const footprintImportData = ref(null)   // { features, propertyKeys, detectedCrs, fileName }
  const footprintFromPosesOpen = ref(false)
  const cameraImportOpen    = ref(false)
  const cameraImportText    = ref('')
  const cameraImportName    = ref('')
  const cameraImportMode    = ref('pose') // sniffed default: 'sensor' | 'pose'
  const importKindOpen      = ref(false)  // "what is this dropped file?" chooser
  const importKindFile      = ref(null)   // the File awaiting a kind choice, or null
  const infoImageId         = ref(null)

  return {
    settingsOpen,
    aboutOpen,
    projectPickerOpen,
    newProjectOpen,
    newProjectCanCancel,
    detectFeaturesOpen,
    matchFeaturesOpen,
    imageTableOpen,
    maskManagerOpen,
    autoMaskOpen,
    sensorTableOpen,
    gcpTableOpen,
    matchListOpen,
    reconstructOpen,
    depthMapsOpen,
    denseOpen,
    demOpen,
    orthoOpen,
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
    importKindOpen,
    importKindFile,
    infoImageId,
  }
})
