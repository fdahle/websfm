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
export function useModalEscape({
  pendingImageDelete, exportKind, onCancelNewProject,
  workflowRunning, onCloseWorkflow,
}) {
  const glossaryStore = useGlossaryStore()
  const guideStore = useGuideStore()
  const { currentProjectId } = storeToRefs(useProjectsStore())
  const {
    settingsOpen, projectSettingsOpen, aboutOpen, systemInfoOpen,
    projectPickerOpen, newProjectOpen, newProjectCanCancel, saveProjectOpen, workflowBuilderOpen,
    detectFeaturesOpen, matchFeaturesOpen,
    imageTableOpen, poseTableOpen, maskManagerOpen, autoMaskOpen, sensorTableOpen, gcpTableOpen, matchListOpen, reconstructOpen,
    findGcpsOpen, georeferenceOpen,
    depthMapsOpen, denseOpen, demOpen, orthoOpen, meshOpen, scaleBarsOpen,
    cropCloudOpen, filterCloudOpen, mergeCloudsOpen, toolModal,
    gcpImportOpen, gcpImportText, gcpImportName, gcpImportGeojson, gcpImportCrs,
    footprintImportOpen, footprintImportData, footprintFromPosesOpen,
    cameraImportOpen,
    importKindOpen, importKindFile,
    importCloudOpen, importCloudData, importRasterOpen, importRasterData, rasterStyleId,
    fiducialDetectOpen, fiducialDetectSensorId, fiducialCalibrateOpen, fiducialCalibrateSensorId,
    qualityOpen, debugSummaryOpen,
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
      // Help browsers can be opened on top of any action dialog.
      [glossaryStore.isOpen,     () => glossaryStore.close()],
      [guideStore.isOpen,        () => guideStore.close()],
      [qualityOpen.value,        () => { qualityOpen.value = false }],
      [debugSummaryOpen.value,   () => { debugSummaryOpen.value = false }],
      [fiducialDetectOpen.value, () => { fiducialDetectOpen.value = false; fiducialDetectSensorId.value = null }],
      [fiducialCalibrateOpen.value, () => { fiducialCalibrateOpen.value = false; fiducialCalibrateSensorId.value = null }],
      [rasterStyleId.value,      () => { rasterStyleId.value = null }],
      [importRasterOpen.value,   () => { importRasterOpen.value = false; importRasterData.value = null }],
      [importCloudOpen.value,    () => { importCloudOpen.value = false; importCloudData.value = null }],
      [importKindOpen.value,     () => { importKindOpen.value = false; importKindFile.value = null }],
      [exportKind.value,         () => { exportKind.value = null }],
      [infoImageId.value,        () => { infoImageId.value = null }],
      // Consume Escape while a workflow is running; closing its builder would hide
      // the only workflow-level Stop control and expose a modal underneath.
      [workflowBuilderOpen.value, () => { if (!workflowRunning?.value) onCloseWorkflow?.() }],
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
      [scaleBarsOpen.value,      () => { scaleBarsOpen.value = false }],
      [cropCloudOpen.value,      () => { cropCloudOpen.value = false }],
      [filterCloudOpen.value,    () => { filterCloudOpen.value = false }],
      [mergeCloudsOpen.value,    () => { mergeCloudsOpen.value = false }],
      [toolModal.value,          () => { toolModal.value = null }],
      [findGcpsOpen.value,       () => { findGcpsOpen.value = false }],
      [georeferenceOpen.value,   () => { georeferenceOpen.value = false }],
      [imageTableOpen.value,     () => { imageTableOpen.value = false }],
      [poseTableOpen.value,      () => { poseTableOpen.value = false }],
      [maskManagerOpen.value,    () => { maskManagerOpen.value = false }],
      [autoMaskOpen.value,       () => { autoMaskOpen.value = false }],
      [sensorTableOpen.value,    () => { sensorTableOpen.value = false }],
      [gcpTableOpen.value,       () => { gcpTableOpen.value = false }],
      [matchListOpen.value,      () => { matchListOpen.value = false }],
      [saveProjectOpen.value,    () => { saveProjectOpen.value = false }],
      [projectSettingsOpen.value, () => { projectSettingsOpen.value = false }],
      [systemInfoOpen.value,     () => { systemInfoOpen.value = false }],
      [settingsOpen.value,       () => { settingsOpen.value = false }],
      [aboutOpen.value,          () => { aboutOpen.value = false }],
      [newProjectOpen.value && newProjectCanCancel.value, () => onCancelNewProject()],
      [projectPickerOpen.value && !!currentProjectId.value, () => { projectPickerOpen.value = false }],
    ]
    const hit = closers.find(([open]) => open)
    if (hit) hit[1]()
    return !!hit
  }

  return { closeTopModal }
}
