import { storeToRefs } from 'pinia'
import { useModalsStore } from '../stores/useModalsStore.js'
import { useGlossaryStore } from '../stores/useGlossaryStore.js'
import { useGuideStore } from '../stores/useGuideStore.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'

// Escape-closes-the-top-most-open-modal, lifted out of App.vue. One ordered list
// of [is-open, close] pairs, most-transient (stacked-on-top) first; Escape
// dismisses the first that's open and stops. Modal state lives in the stores
// (pulled in here); the handful of App-local refs/handlers are injected:
//   pendingImageDelete  — ref, the batch-delete confirm
//   exportKind          — ref (from useExports), which export dialog is open
//   onCancelNewProject  — fn, cancels the (cancellable) New Project dialog
export function useModalEscape({ pendingImageDelete, exportKind, onCancelNewProject }) {
  const glossaryStore = useGlossaryStore()
  const guideStore = useGuideStore()
  const { currentProjectId } = storeToRefs(useProjectsStore())
  const {
    settingsOpen, aboutOpen,
    projectPickerOpen, newProjectOpen, newProjectCanCancel, saveProjectOpen,
    detectFeaturesOpen, matchFeaturesOpen,
    imageTableOpen, maskManagerOpen, autoMaskOpen, sensorTableOpen, gcpTableOpen, matchListOpen, reconstructOpen,
    depthMapsOpen, denseOpen, demOpen, orthoOpen, meshOpen,
    gcpImportOpen, gcpImportText, gcpImportName, gcpImportGeojson, gcpImportCrs,
    footprintImportOpen, footprintImportData, footprintFromPosesOpen,
    cameraImportOpen,
    importKindOpen, importKindFile,
    infoImageId,
  } = storeToRefs(useModalsStore())

  // Most-transient (stacked-on-top) first; Escape dismisses the first that's open.
  // Modals with their own overlay Escape handling (glossary/guide) are included so
  // it works even when focus isn't inside the overlay. Blocking dialogs stay open
  // unless dismissible (ProgressModal is never here; NewProject/ProjectPicker only
  // when cancellable). Returns whether anything was closed, so the caller can fall
  // through to non-modal Escape behaviour (e.g. exiting mask-edit mode).
  function closeTopModal() {
    const closers = [
      [pendingImageDelete.value, () => { pendingImageDelete.value = null }],
      [importKindOpen.value,     () => { importKindOpen.value = false; importKindFile.value = null }],
      [exportKind.value,         () => { exportKind.value = null }],
      [infoImageId.value,        () => { infoImageId.value = null }],
      [gcpImportOpen.value,      () => { gcpImportOpen.value = false; gcpImportGeojson.value = null; gcpImportText.value = ''; gcpImportCrs.value = null }],
      [footprintImportOpen.value,   () => { footprintImportOpen.value = false; footprintImportData.value = null }],
      [footprintFromPosesOpen.value, () => { footprintFromPosesOpen.value = false }],
      [cameraImportOpen.value,   () => { cameraImportOpen.value = false }],
      [detectFeaturesOpen.value, () => { detectFeaturesOpen.value = false }],
      [matchFeaturesOpen.value,  () => { matchFeaturesOpen.value = false }],
      [reconstructOpen.value,    () => { reconstructOpen.value = false }],
      [depthMapsOpen.value,      () => { depthMapsOpen.value = false }],
      [denseOpen.value,          () => { denseOpen.value = false }],
      [demOpen.value,            () => { demOpen.value = false }],
      [orthoOpen.value,          () => { orthoOpen.value = false }],
      [meshOpen.value,           () => { meshOpen.value = false }],
      [imageTableOpen.value,     () => { imageTableOpen.value = false }],
      [maskManagerOpen.value,    () => { maskManagerOpen.value = false }],
      [autoMaskOpen.value,       () => { autoMaskOpen.value = false }],
      [sensorTableOpen.value,    () => { sensorTableOpen.value = false }],
      [gcpTableOpen.value,       () => { gcpTableOpen.value = false }],
      [matchListOpen.value,      () => { matchListOpen.value = false }],
      [saveProjectOpen.value,    () => { saveProjectOpen.value = false }],
      [settingsOpen.value,       () => { settingsOpen.value = false }],
      [aboutOpen.value,          () => { aboutOpen.value = false }],
      [glossaryStore.isOpen,     () => glossaryStore.close()],
      [guideStore.isOpen,        () => guideStore.close()],
      [newProjectOpen.value && newProjectCanCancel.value, () => onCancelNewProject()],
      [projectPickerOpen.value && !!currentProjectId.value, () => { projectPickerOpen.value = false }],
    ]
    const hit = closers.find(([open]) => open)
    if (hit) hit[1]()
    return !!hit
  }

  return { closeTopModal }
}
