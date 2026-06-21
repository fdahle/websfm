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
  const metadataOpen        = ref(false)
  const matchListOpen       = ref(false)
  const reconstructOpen     = ref(false)
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
    metadataOpen,
    matchListOpen,
    reconstructOpen,
    infoImageId,
    infoImage,
  }
}
