import { ref, computed } from 'vue'

// imageById: (id: string) => image | null — from useImages
export function useModals(imageById) {
  const settingsOpen        = ref(false)
  const aboutOpen           = ref(false)
  const projectPickerOpen   = ref(false)
  const newProjectOpen      = ref(false)
  const newProjectCanCancel = ref(true)
  const detectFeaturesOpen  = ref(false)
  const matchFeaturesOpen   = ref(false)
  const imageTableOpen      = ref(false)
  const sensorTableOpen     = ref(false)
  const gcpTableOpen        = ref(false)
  const matchListOpen       = ref(false)
  const reconstructOpen     = ref(false)
  const gcpImportOpen       = ref(false)
  const gcpImportText       = ref('')
  const gcpImportName       = ref('')
  const gcpImportGeojson    = ref(null)   // pre-parsed GCPs from a GeoJSON points file, or null
  const gcpImportCrs        = ref(null)   // CRS detected from the GeoJSON, or null
  const footprintImportOpen = ref(false)
  const footprintImportData = ref(null)   // { features, propertyKeys, detectedCrs, fileName }
  const cameraImportOpen    = ref(false)
  const cameraImportText    = ref('')
  const cameraImportName    = ref('')
  const cameraImportMode    = ref('pose') // sniffed default: 'sensor' | 'pose'
  const infoImageId         = ref(null)
  const infoImage           = computed(() => infoImageId.value ? imageById(infoImageId.value) : null)

  return {
    settingsOpen,
    aboutOpen,
    projectPickerOpen,
    newProjectOpen,
    newProjectCanCancel,
    detectFeaturesOpen,
    matchFeaturesOpen,
    imageTableOpen,
    sensorTableOpen,
    gcpTableOpen,
    matchListOpen,
    reconstructOpen,
    gcpImportOpen,
    gcpImportText,
    gcpImportName,
    gcpImportGeojson,
    gcpImportCrs,
    footprintImportOpen,
    footprintImportData,
    cameraImportOpen,
    cameraImportText,
    cameraImportName,
    cameraImportMode,
    infoImageId,
    infoImage,
  }
}
