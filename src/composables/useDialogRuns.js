import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useModalsStore } from '../stores/useModalsStore.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { sectionCloud, sectionToCsv, sectionToDxf } from '../core/products/cloudSection.js'
import { downloadBlob } from '../utils/download.js'
import { terminateAll } from '../workers/computeClient.js'
import { useImageViewSettings } from './useImageViewSettings.js'
import { useLog } from './useLog.js'
import { showToast } from './useToasts.js'

// What each run-style dialog does on Run, lifted out of App.vue: close the dialog,
// then hand the settings to the pipeline (usePipeline) — and, for the few that
// need it, the follow-up (refit the georeference, close retired product tabs,
// download a section profile).
//
// Injected: `pipeline` (usePipeline's runners + its progress contract as
// `exportProgress`), `closeProductTabs` / `openImageTab` (useTabs),
// `refreshGcpReport` (useGcpEditing), `requestRemoveImages` (useConfirmations).
export function useDialogRuns({ pipeline, closeProductTabs, openImageTab, refreshGcpReport, requestRemoveImages }) {
  const {
    runDetect, runMatch, runReconstruct, runComputeDepthMaps, runDensify,
    runGenerateDem, runGenerateOrtho, runGenerateMesh, runEditClouds, runTextureMesh, exportProgress,
  } = pipeline
  const { log } = useLog()
  const imagesStore = useImagesStore()
  const { images } = storeToRefs(imagesStore)
  const reconstructionStore = useReconstructionStore()
  const { reconStatus } = storeToRefs(reconstructionStore)
  const { georeference } = reconstructionStore
  const { currentProjectName } = storeToRefs(useProjectsStore())
  const {
    detectFeaturesOpen, matchFeaturesOpen, reconstructOpen, georeferenceOpen, maskManagerOpen,
    depthMapsOpen, denseOpen, demOpen, orthoOpen, meshOpen, cropCloudOpen, filterCloudOpen, filterCloudPreset,
    mergeCloudsOpen, toolModal,
  } = storeToRefs(useModalsStore())
  const { imageViewPrefs, patchImageView } = useImageViewSettings()

  function onDetectRun(settings)      { detectFeaturesOpen.value = false;  runDetect(settings)      }
  function onMatchRun(settings)       { matchFeaturesOpen.value  = false;  runMatch(settings)       }
  // A Georeference request may hand off to the normal reconstruction dialog so the
  // user retains control over its settings. Only after a successful sparse run do we
  // fit the final SfM→project-CRS similarity.
  const georeferenceAfterReconstruct = ref(false)
  function closeReconstructModal() {
    reconstructOpen.value = false
    georeferenceAfterReconstruct.value = false
  }
  async function onReconstructRun(settings) {
    const finishGeoreference = georeferenceAfterReconstruct.value
    reconstructOpen.value = false
    georeferenceAfterReconstruct.value = false
    await runReconstruct(settings)
    if (finishGeoreference && reconStatus.value === 'done') {
      await georeference()
      await refreshGcpReport()
    }
    if (reconStatus.value === 'done') {
      // The store retired products tied to the previous camera solution; do not leave
      // tabs open with a null backing raster.
      closeProductTabs()
    }
  }

  async function onGeoreferenceRun({ mode }) {
    georeferenceOpen.value = false
    if (mode === 'adjust') {
      georeferenceAfterReconstruct.value = true
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
  function onDepthMapsRun(settings)   { depthMapsOpen.value      = false;  runComputeDepthMaps(settings) }
  function onDenseRun(settings)       { denseOpen.value          = false;  runDensify(settings) }
  // Products: generation just produces the product; the user opens it via the
  // Products sidebar section (double-click / "Open in tab") when they want to inspect it.
  async function onDemRun(settings)   { demOpen.value = false;   await runGenerateDem(settings) }
  async function onOrthoRun(settings) { orthoOpen.value = false; await runGenerateOrtho(settings) }
  async function onMeshRun(settings)  { meshOpen.value = false;  await runGenerateMesh(settings) }
  // Cloud editing. Each modal emits a ready-made request ({ sourceIds, settings, name });
  // the mode is fixed by which modal sent it. Always adds a new cloud — non-destructive.
  async function onCropCloudRun(req)   { cropCloudOpen.value = false;   await runEditClouds({ ...req, mode: 'crop' }) }
  async function onFilterCloudRun(req) {
    filterCloudOpen.value = false
    filterCloudPreset.value = null
    await runEditClouds({ ...req, mode: 'filter' })
  }
  // Sparse gradual selection (Tools ▸ Model ▾): retires the model's computed
  // dependents, so their open product tabs close with it.
  async function onGradualSelectionRun(req) {
    toolModal.value = null
    const result = await runEditClouds({ ...req, mode: 'sparse' })
    if (result.ok) {
      closeProductTabs()
    }
  }
  async function onMergeCloudsRun(req) { mergeCloudsOpen.value = false; await runEditClouds({ ...req, mode: 'merge' }) }
  // 3D-viewer rectangle/lasso selection: one masked edit per selected cloud. The
  // store refines a derived cloud in place and forks a derived copy of anything else.
  async function onEditSelection({ edits, keepSelected }) {
    for (const { cloudId, mask } of edits) {
      // Cancel terminates the worker for this cloud; it must also stop the rest.
      const result = await runEditClouds({ mode: 'mask', sourceIds: [cloudId], settings: { mask, keepSelected } })
      if (result?.cancelled) break
    }
  }


  async function onOptimizeCamerasRun(req) {
    toolModal.value = null
    const result = await runEditClouds({ ...req, mode: 'optimize' })
    if (result.ok) {
      closeProductTabs()
    }
  }

  // Image quality: scoring runs behind the shared progress bar; the dialog stays open
  // underneath and fills in as the scores land.
  async function onImageQualityEstimate(ids) {
    const total = ids?.length ?? images.value.length
    exportProgress.open('Scoring Image Quality', total, () => terminateAll('image quality cancelled'), { unit: 'images' })
    try {
      await imagesStore.estimateImageQuality(ids, { onProgress: (d, t) => exportProgress.report(d, t, 'Scoring images') })
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
    if (toolModal.value === 'texture-mesh') { toolModal.value = null; await runTextureMesh(req); return }
    const mode = TOOL_EDIT_MODES[toolModal.value]
    toolModal.value = null
    if (mode === 'distance') req = { ...req, style: distanceStyle(req.settings.signed) }
    if (mode === 'classify-ground') req = await groundRequest(req)
    if (mode && req) await runEditClouds({ ...req, mode })
  }
  // Classify ground works in metres along the product vertical, so it needs the
  // frame a DEM would be built in (THE resolver: georeference > scale bars). A
  // computed cloud in model units is refused: the cloth's lengths would mean
  // nothing. An imported cloud is classified as it is (its own z is up, in its
  // file units, taken as metres). The result opens coloured by class.
  async function groundRequest(req) {
    const source = reconstructionStore.clouds.find((c) => c.id === req.sourceIds?.[0])
    if (!source) return null
    let frame = null, metresPerUnit = 1, unitLabel = 'm'
    if (source.imported) {
      log('Ground filter: an imported cloud is classified in its own coordinates (z up, lengths taken as metres)', 'info', 'Products')
    } else {
      const resolved = await reconstructionStore.effectiveFrameSpec({})
      if (resolved.unit === 'model') {
        const why = 'the model has no real-world scale — georeference it or add scale bars first'
        log(`Ground filter: ${why}`, 'error', 'Products')
        showToast('Classify ground needs metres', { detail: why, kind: 'error', ms: 6000 })
        return null
      }
      frame = resolved.frameSpec
      metresPerUnit = resolved.frameSpec.metresPerUnit ?? 1
      unitLabel = resolved.unit
    }
    const cameras = [...(reconstructionStore.mainSparseCloud?.cameras ?? new Map()).values()]
      .map((cam) => ({ R: cam.R.map((r) => [...r]), t: [...cam.t] }))
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
      const m = stats?.p95Abs > 0 ? stats.p95Abs : (Math.max(Math.abs(stats?.min ?? 0), Math.abs(stats?.max ?? 0)) || 1)
      return signed
        ? { field: 'attribute:distance', ramp: 'rdbu', range: 'manual', min: -m, max: m }
        : { field: 'attribute:distance', ramp: 'viridis', range: 'manual', min: 0, max: m }
    }
  }
  // Section: the slice is added as a cloud, then its 2D profile downloaded. The
  // profile is recomputed from the (small) slice itself, so the worker result stays
  // a plain cloud like every other edit.
  async function onSectionRun({ download, ...req }) {
    toolModal.value = null
    const result = await runEditClouds({ ...req, mode: 'section' })
    if (!result.ok || download === 'none') return
    const slice = reconstructionStore.selectedCloud
    if (!slice?.count) return
    const section = sectionCloud(slice, { ...req.settings, thickness: req.settings.thickness * 1.000001 })
    const base = `${currentProjectName.value || 'project'}-section`
    if (download === 'dxf') downloadBlob(`${base}.dxf`, sectionToDxf(section), 'application/dxf')
    else downloadBlob(`${base}.csv`, sectionToCsv(section), 'text/csv;charset=utf-8')
  }
  async function onProductToolRun(fn, settings) {
    toolModal.value = null
    try { await fn(settings) } catch (err) {
      log(`${err?.message ?? err}`, 'error', 'Export')
      showToast('Export failed', { detail: String(err?.message ?? err), kind: 'error', ms: 6000 })
    }
  }

  return {
    onDetectRun, onMatchRun, georeferenceAfterReconstruct, closeReconstructModal, onReconstructRun, onGeoreferenceRun,
    editMask, onDepthMapsRun, onDenseRun, onDemRun, onOrthoRun, onMeshRun,
    onCropCloudRun, onFilterCloudRun, onGradualSelectionRun, onMergeCloudsRun, onEditSelection, onOptimizeCamerasRun,
    onImageQualityEstimate, onImageQualityGroup, onImageQualityRemove, onToolEditRun, onSectionRun, onProductToolRun,
  }
}
