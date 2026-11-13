import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useModalsStore } from '../stores/useModalsStore.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { sectionCloud, sectionToCsv, sectionToDxf } from '../core/products/cloudSection.js'
import { downloadBlob } from '../utils/download.js'
import { cancelRun, isAbort } from '../workers/computeClient.js'
import { useImageViewSettings } from './useImageViewSettings.js'
import { useLog } from './useLog.js'
import { useDemCoregistration } from './useDemCoregistration.js'
import { showToast } from './useToasts.js'
import { defaultExportName, exportFileName } from '../core/exportNames.js'
import { useProjectMerge } from './useProjectMerge.js'
import { useDetectTargets } from './useDetectTargets.js'

// What each run-style dialog does on Run, lifted out of App.vue: close the dialog,
// then hand the settings to the pipeline (usePipeline) — and, for the few that
// need it, the follow-up (refit the georeference, close retired product tabs,
// download a section profile).
//
// Injected: `pipeline` (usePipeline's runners + its progress contract as
// `exportProgress`), `openImageTab` (useTabs), `refreshGcpReport` (useGcpEditing),
// `requestRemoveImages` (useConfirmations).
export function useDialogRuns({ pipeline, openImageTab, refreshGcpReport, requestRemoveImages }) {
  const {
    runDetect,
    runMatch,
    runReconstruct,
    runComputeDepthMaps,
    runDensify,
    runGenerateDem,
    runGenerateOrtho,
    runGenerateMesh,
    runEditClouds,
    runTextureMesh,
    exportProgress,
  } = pipeline
  const { log } = useLog()
  const imagesStore = useImagesStore()
  const { images } = storeToRefs(imagesStore)
  const reconstructionStore = useReconstructionStore()
  const { reconStatus } = storeToRefs(reconstructionStore)
  const { georeference } = reconstructionStore
  const { currentProjectName } = storeToRefs(useProjectsStore())
  const {
    detectFeaturesOpen,
    matchFeaturesOpen,
    reconstructOpen,
    georeferenceOpen,
    maskManagerOpen,
    depthMapsOpen,
    denseOpen,
    demOpen,
    orthoOpen,
    meshOpen,
    cropCloudOpen,
    filterCloudOpen,
    filterCloudPreset,
    mergeCloudsOpen,
    toolModal,
    coregisterInitial,
    importProjectOpen,
  } = storeToRefs(useModalsStore())
  const demCoregistration = useDemCoregistration()
  const { patchImageView } = useImageViewSettings()

  function onDetectRun(settings) {
    detectFeaturesOpen.value = false
    runDetect(settings)
  }
  function onMatchRun(settings) {
    matchFeaturesOpen.value = false
    runMatch(settings)
  }
  // A Georeference request may hand off to the normal reconstruction dialog so the
  // user retains control over its settings. Only after a successful sparse run do we
  // fit the final SfM→project-CRS similarity.
  const georeferenceAfterReconstruct = ref(false)
  // Georeference ▸ Hold to a reference DEM: { referenceId, stableSetId, sigma } for the
  // run the Reconstruct dialog starts (sparseRun.js demHoldInput), or null.
  const demHoldRequest = ref(null)
  function closeReconstructModal() {
    reconstructOpen.value = false
    georeferenceAfterReconstruct.value = false
    demHoldRequest.value = null
  }
  async function onReconstructRun(settings) {
    const finishGeoreference = georeferenceAfterReconstruct.value
    const demHold = demHoldRequest.value
    reconstructOpen.value = false
    georeferenceAfterReconstruct.value = false
    demHoldRequest.value = null
    await runReconstruct(demHold ? { ...settings, demHold } : settings)
    if (finishGeoreference && reconStatus.value === 'done') {
      await georeference()
      await refreshGcpReport()
    }
    // The products of the previous model stay (marked outdated), so their tabs stay too.
  }

  async function onGeoreferenceRun({ mode, demHold = null }) {
    georeferenceOpen.value = false
    if (mode === 'adjust' || mode === 'dem') {
      georeferenceAfterReconstruct.value = true
      demHoldRequest.value = mode === 'dem' ? demHold : null
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
  function onDepthMapsRun(settings) {
    depthMapsOpen.value = false
    runComputeDepthMaps(settings)
  }
  function onDenseRun(settings) {
    denseOpen.value = false
    runDensify(settings)
  }
  // Products: generation just produces the product; the user opens it via the
  // Products sidebar section (double-click / "Open in tab") when they want to inspect it.
  async function onDemRun(settings) {
    demOpen.value = false
    await runGenerateDem(settings)
  }
  async function onOrthoRun(settings) {
    orthoOpen.value = false
    await runGenerateOrtho(settings)
  }
  async function onMeshRun(settings) {
    meshOpen.value = false
    await runGenerateMesh(settings)
  }
  // Cloud editing. Each modal emits a ready-made request ({ sourceIds, settings, name });
  // the mode is fixed by which modal sent it. Always adds a new cloud — non-destructive.
  async function onCropCloudRun(req) {
    cropCloudOpen.value = false
    await runEditClouds({ ...req, mode: 'crop' })
  }
  async function onFilterCloudRun(req) {
    filterCloudOpen.value = false
    filterCloudPreset.value = null
    await runEditClouds({ ...req, mode: 'filter' })
  }
  // Sparse gradual selection (Tools ▸ Model ▾): the products built on the model stay,
  // marked outdated.
  async function onGradualSelectionRun(req) {
    toolModal.value = null
    await runEditClouds({ ...req, mode: 'sparse' })
  }
  async function onMergeCloudsRun(req) {
    mergeCloudsOpen.value = false
    await runEditClouds({ ...req, mode: 'merge' })
  }
  // 3D-viewer rectangle/lasso selection: one masked edit per selected cloud. The
  // store refines a derived cloud in place and forks a derived copy of anything else.
  async function onEditSelection({ edits, keepSelected, classValue = null }) {
    for (const { cloudId, mask, selection } of edits) {
      // Cancel terminates the worker for this cloud; it must also stop the rest.
      // With a class, the selection is reclassified instead of kept or deleted. A
      // streamed cloud's selection is its recorded shapes (core/lod/transform.js).
      const pick = selection ? { selection } : { mask }
      const result =
        classValue != null
          ? await runEditClouds({ mode: 'classify', sourceIds: [cloudId], settings: { ...pick, classValue } })
          : await runEditClouds({ mode: 'mask', sourceIds: [cloudId], settings: { ...pick, keepSelected } })
      if (result?.cancelled) break
    }
  }

  async function onOptimizeCamerasRun(req) {
    toolModal.value = null
    await runEditClouds({ ...req, mode: 'optimize' })
  }

  // Image quality: scoring runs behind the shared progress bar; the dialog stays open
  // underneath and fills in as the scores land.
  async function onImageQualityEstimate(ids) {
    const total = ids?.length ?? images.value.length
    exportProgress.open('Scoring Image Quality', total, () => cancelRun('image quality cancelled'), {
      unit: 'images',
    })
    try {
      await imagesStore.estimateImageQuality(ids, {
        onProgress: (d, t) => exportProgress.report(d, t, 'Scoring images'),
      })
    } finally {
      await exportProgress.close()
    }
  }
  function onImageQualityGroup(ids) {
    imagesStore.createImageGroup({ name: 'Low image quality', imageIds: ids })
  }
  function onImageQualityRemove(ids) {
    toolModal.value = null
    requestRemoveImages(ids)
  }

  // Tools-tab edits that run through the store's cloud-edit path: dialog id → edit
  // mode (core/products/* via workers/ops/cloud.js). Non-destructive, every one.
  const TOOL_EDIT_MODES = {
    'estimate-normals': 'normals',
    'classify-ground': 'classify-ground',
    'transform-cloud': 'transform',
    'align-icp': 'icp',
    'cloud-distance': 'distance',
    'clean-mesh': 'mesh-clean',
    'smooth-mesh': 'mesh-smooth',
    'decimate-mesh': 'mesh-decimate',
    'crop-mesh': 'mesh-crop',
    'mesh-to-points': 'mesh-sample',
  }
  async function onToolEditRun(req) {
    // Texture is a mesh tool, but it reads the photos: its own store run, not an edit.
    if (toolModal.value === 'texture-mesh') {
      toolModal.value = null
      await runTextureMesh(req)
      return
    }
    const mode = TOOL_EDIT_MODES[toolModal.value]
    toolModal.value = null
    if (mode === 'distance') req = { ...req, style: distanceStyle(req.settings.signed) }
    if (mode === 'classify-ground') req = await groundRequest(req)
    if (mode && req) await runEditClouds({ ...req, mode })
  }
  // Classify points works in metres along the product vertical, so it needs the
  // frame a DEM would be built in (THE resolver: georeference > scale bars). A
  // computed cloud in model units is refused: the cloth's lengths would mean
  // nothing. An imported cloud is classified as it is (its own z is up, in its
  // file units, taken as metres). The result opens coloured by class.
  async function groundRequest(req) {
    const source = reconstructionStore.clouds.find((c) => c.id === req.sourceIds?.[0])
    if (!source) return null
    let frame = null,
      metresPerUnit = 1,
      unitLabel = 'm'
    if (source.imported) {
      log(
        'Ground filter: an imported cloud is classified in its own coordinates (z up, lengths taken as metres)',
        'info',
        'Products',
      )
    } else {
      const resolved = await reconstructionStore.effectiveFrameSpec({})
      if (resolved.unit === 'model') {
        const why = 'the model has no real-world scale — georeference it or add scale bars first'
        log(`Ground filter: ${why}`, 'error', 'Products')
        showToast('Classify points needs metres', { detail: why, kind: 'error', ms: 6000 })
        return null
      }
      frame = resolved.frameSpec
      metresPerUnit = resolved.frameSpec.metresPerUnit ?? 1
      unitLabel = resolved.unit
    }
    const cameras = [...(reconstructionStore.mainSparseCloud?.cameras ?? new Map()).values()].map((cam) => ({
      R: cam.R.map((r) => [...r]),
      t: [...cam.t],
    }))
    return {
      ...req,
      settings: { ...req.settings, frame, metresPerUnit, unitLabel, cameras },
      style: { field: 'attribute:classification' },
    }
  }
  // A distance result opens coloured by distance: a signed one on the diverging ramp
  // with a symmetric range (white = no change), an unsigned one sequential from 0.
  // The range is the 95th-percentile magnitude so a few far points don't wash it out.
  function distanceStyle(signed) {
    return (stats) => {
      const m = stats?.p95Abs > 0 ? stats.p95Abs : Math.max(Math.abs(stats?.min ?? 0), Math.abs(stats?.max ?? 0)) || 1
      return signed
        ? { field: 'attribute:distance', ramp: 'rdbu', range: 'manual', min: -m, max: m }
        : { field: 'attribute:distance', ramp: 'viridis', range: 'manual', min: 0, max: m }
    }
  }
  // Section: the slice is added as a cloud, then its 2D profile downloaded. The
  // profile is recomputed from the (small) slice itself, so the worker result stays
  // a plain cloud like every other edit.
  async function onSectionRun({ download, fileName, ...req }) {
    toolModal.value = null
    const result = await runEditClouds({ ...req, mode: 'section' })
    if (!result.ok || download === 'none') return
    const slice = reconstructionStore.selectedCloud
    if (!slice?.count) return
    const section = sectionCloud(slice, { ...req.settings, thickness: req.settings.thickness * 1.000001 })
    const base = exportFileName(fileName, defaultExportName('section', { base: currentProjectName.value || 'project' }))
    if (download === 'dxf') downloadBlob(`${base}.dxf`, sectionToDxf(section), 'application/dxf')
    else downloadBlob(`${base}.csv`, sectionToCsv(section), 'text/csv;charset=utf-8')
  }
  async function onProductToolRun(fn, settings) {
    toolModal.value = null
    try {
      await fn(settings)
    } catch (err) {
      log(`${err?.message ?? err}`, 'error', 'Export')
      showToast('Export failed', { detail: String(err?.message ?? err), kind: 'error', ms: 6000 })
    }
  }

  // Products ▸ Reflectance map: behind the progress bar; the map lands in Reference Data.
  async function onReflectanceRun(settings) {
    toolModal.value = null
    exportProgress.open('Building Reflectance Map', 1, () => cancelRun('reflectance map cancelled'), {
      unit: 'blocks',
    })
    let record = null
    try {
      record = await reconstructionStore.generateReflectanceMap(settings, (d, t, label) =>
        exportProgress.report(d, t, label),
      )
    } finally {
      await exportProgress.close()
    }
    if (record)
      showToast(`Added "${record.name}"`, {
        detail: 'Reference Data ▸ Style bands… shows any band, a composite or an index such as NDVI.',
        ms: 8000,
      })
  }

  // Co-register DEM: close the dialog, co-register, and say how far the DEM moved.
  async function onCoregisterRun(settings) {
    toolModal.value = null
    coregisterInitial.value = null
    try {
      const { result, record, unit } = await demCoregistration.run(settings)
      const u = (v) => `${v.toFixed(2)}${unit ? ` ${unit}` : ''}`
      showToast(record ? `Added "${record.name}"` : 'Georeference co-registered', {
        detail:
          `NMAD on ${settings.stableSetId ? 'stable ground' : 'all cells'} ${u(result.before.nmad)} → ${u(result.after.nmad)}` +
          (record ? '' : '. Rebuild the DEM and orthophoto.'),
        ms: 8000,
      })
    } catch (err) {
      log(`${err?.message ?? err}`, 'error', 'Products')
      showToast('Co-registration failed', { detail: String(err?.message ?? err), kind: 'error', ms: 6000 })
    }
  }

  // Import ▸ Project into this project (useProjectMerge), behind the run progress bar.
  const { importProjectInto } = useProjectMerge()
  async function onImportProject(sourceId, options = {}) {
    importProjectOpen.value = false
    // Cancel stops between batches (no worker to terminate).
    exportProgress.open('Importing Project', 0, () => {}, { unit: 'photos' })
    let ok = false
    try {
      const r = await importProjectInto(sourceId, exportProgress.report, () => exportProgress.aborted.value, options)
      ok = !!r && !r.cancelled
    } finally {
      await exportProgress.close(ok)
    }
  }

  // Tools ▸ Images ▸ Detect targets (useDetectTargets), behind the run progress bar.
  const detectTargets = useDetectTargets()
  async function onDetectTargetsRun({ settings, plan }) {
    toolModal.value = null
    // Cancel stops taking photos and ends the workers' current ones (computeClient cancelRun).
    exportProgress.open('Detecting Targets', plan.photos.length, () => cancelRun('target detection cancelled'), {
      unit: 'photos',
    })
    let ok = false
    try {
      const r = await detectTargets.run(settings, plan, exportProgress.report, () => exportProgress.aborted.value)
      if (r.cancelled) return
      ok = r.found > 0
      showToast(r.found ? `${r.found} target marks placed` : 'No target found', {
        detail: r.found
          ? 'Check them in Edit GCPs, then georeference again.'
          : settings.kind === 'apriltag' || settings.kind === 'aruco'
            ? `No ${settings.kind === 'aruco' ? `ArUco ${settings.arucoDict.toUpperCase()}` : 'tag36h11'} tag was read: ` +
              'a tag needs about 2 px per cell and its white border.'
            : 'Try a larger search radius or a lower minimum score.',
        kind: r.found ? 'success' : 'warn',
      })
    } catch (err) {
      if (!isAbort(err)) {
        const detail = String(err?.message ?? err)
        log(`Detect targets failed: ${detail}`, 'error', 'GCP')
        showToast('Detect targets failed', { detail, kind: 'error', ms: 6000 })
      }
    } finally {
      await exportProgress.close(ok)
    }
  }

  return {
    onCoregisterRun,
    onImportProject,
    onDetectTargetsRun,
    onDetectRun,
    onMatchRun,
    georeferenceAfterReconstruct,
    closeReconstructModal,
    onReconstructRun,
    onGeoreferenceRun,
    editMask,
    onDepthMapsRun,
    onDenseRun,
    onDemRun,
    onOrthoRun,
    onMeshRun,
    onCropCloudRun,
    onFilterCloudRun,
    onGradualSelectionRun,
    onMergeCloudsRun,
    onEditSelection,
    onOptimizeCamerasRun,
    onImageQualityEstimate,
    onImageQualityGroup,
    onImageQualityRemove,
    onToolEditRun,
    onSectionRun,
    onProductToolRun,
    onReflectanceRun,
  }
}
