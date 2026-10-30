<script setup>
import { computed, defineAsyncComponent } from 'vue'
import { storeToRefs } from 'pinia'
import { useProjectsStore } from '../../stores/useProjectsStore.js'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'
import { useImagesStore } from '../../stores/useImagesStore.js'
import { useGcpsStore } from '../../stores/useGcpsStore.js'
import { usePosesStore } from '../../stores/usePosesStore.js'
import { useExternalStore } from '../../stores/useExternalStore.js'
import { useModalsStore } from '../../stores/useModalsStore.js'
import { useMeasurementsStore } from '../../stores/useMeasurementsStore.js'
import { useMatchesStore } from '../../stores/useMatchesStore.js'
import { useSensorsStore } from '../../stores/useSensorsStore.js'
import { useFootprintsStore } from '../../stores/useFootprintsStore.js'
import { useAppContext } from '../../appContext.js'
import { tilesSubject } from '../../core/products/tiles3d.js'
import AlignIcpModal from './cloud/AlignIcpModal.vue'
import CleanMeshModal from './mesh/CleanMeshModal.vue'
import ClipRasterModal from './products/ClipRasterModal.vue'
import CloudDistanceModal from './cloud/CloudDistanceModal.vue'
import ContoursModal from './products/ContoursModal.vue'
import CropCloudModal from './cloud/CropCloudModal.vue'
import DecimateMeshModal from './mesh/DecimateMeshModal.vue'
import TextureMeshModal from './mesh/TextureMeshModal.vue'
import DemModal from './products/DemModal.vue'
import DenseModal from './pipeline/DenseModal.vue'
import DepthMapsModal from './pipeline/DepthMapsModal.vue'
import DetectFeaturesModal from './pipeline/DetectFeaturesModal.vue'
import ExportModal from './products/ExportModal.vue'
import FilterCloudModal from './cloud/FilterCloudModal.vue'
import GeoreferenceModal from './georef/GeoreferenceModal.vue'
import GradualSelectionModal from './model/GradualSelectionModal.vue'
import ImageQualityModal from './images/ImageQualityModal.vue'
import MatchFeaturesModal from './pipeline/MatchFeaturesModal.vue'
import MergeCloudsModal from './cloud/MergeCloudsModal.vue'
import MeshMeasureModal from './mesh/MeshMeasureModal.vue'
import MeshModal from './mesh/MeshModal.vue'
import NormalsModal from './cloud/NormalsModal.vue'
import ClassifyGroundModal from './cloud/ClassifyGroundModal.vue'
import OptimizeCamerasModal from './model/OptimizeCamerasModal.vue'
import OrthoModal from './products/OrthoModal.vue'
import ReconstructModal from './pipeline/ReconstructModal.vue'
import SampleMeshModal from './mesh/SampleMeshModal.vue'
import ScaleBarsModal from './georef/ScaleBarsModal.vue'
import SectionModal from './cloud/SectionModal.vue'
import SmoothMeshModal from './mesh/SmoothMeshModal.vue'
import TerrainModal from './products/TerrainModal.vue'
import TransformCloudModal from './cloud/TransformCloudModal.vue'
import { extensionBlocker } from '../../core/sfm/extendModel.js'
const FindGcpsModal = defineAsyncComponent(() => import('./georef/FindGcpsModal.vue'))

// The pipeline and Tools-tab dialogs, lifted out of App.vue: each opens from a
// command (useCommandDispatch) and hands its settings to useDialogRuns on Run.
const { currentCrs, currentSceneType } = storeToRefs(useProjectsStore())
const reconstructionStore = useReconstructionStore()
const {
  canGeoreference,
  canGeoreferenceGcps,
  clouds,
  crsSuggestion,
  dem,
  demSource,
  groundSource,
  denseSummary,
  depthSummary,
  georef,
  georeferenceBlocker,
  meshSource,
  meshSources,
  ortho,
  orthoSurfaces,
} = storeToRefs(reconstructionStore)
const { images } = storeToRefs(useImagesStore())
const { sensors } = storeToRefs(useSensorsStore())
// What Sparse Reconstruction can build on: the usable matched pairs and the images
// they link (the same filter as the store's usableMatchCount).
const { matchStore } = storeToRefs(useMatchesStore())
const matchedLinks = computed(() => {
  const ids = new Set()
  let pairs = 0
  for (const e of matchStore.value.values()) {
    if (e.status !== 'done' || e.enabled === false || !(e.inlierCount > 0)) continue
    pairs++
    ids.add(e.idA)
    ids.add(e.idB)
  }
  return { images: ids.size, pairs }
})
// Sparse Model ▸ Add to the model: the main model, the images with features it lacks,
// and whether anything was built from its cameras (core/sfm/extendModel.js).
const extendState = computed(() => {
  const model = reconstructionStore.mainSparseCloud
  const cams = model?.cameras
  const newImages = images.value.filter((im) => im.kpStatus === 'done' && im.kpCount > 0 && !cams?.has(im.uuid)).length
  return {
    modelCameras: cams?.size ?? 0,
    newImages,
    hasProducts: reconstructionStore.hasSparseProducts(),
    blocker: extensionBlocker(model, newImages),
  }
})
// Match only new pairs: the pairs with a result, and the images with features in none
// of them (photos added since the last match).
const matchedState = computed(() => {
  const inPair = new Set()
  let pairs = 0
  for (const e of matchStore.value.values()) {
    if (e.status !== 'done') continue
    pairs++
    inPair.add(e.idA)
    inPair.add(e.idB)
  }
  const unpaired = images.value.filter((im) => im.kpStatus === 'done' && im.kpCount > 0 && !inPair.has(im.uuid))
  return { pairs, unpairedImages: unpaired.length }
})
// Crop, filter and classify ground also take a streamed cloud (core/lod/streamed.js):
// crop copies a box out of the octree into a resident cloud (or, inverted, rewrites the
// octree); filter and classify run tile by tile into a new streamed cloud; Align to
// Reference aligns a sample of it and moves every point into a new streamed cloud.
const croppableClouds = computed(() =>
  clouds.value.filter((c) => c.kind === 'dense' && c.count > 0 && (c.pos || c.lod)),
)
const { gcps } = storeToRefs(useGcpsStore())
const { poses } = storeToRefs(usePosesStore())
const { orthoRasters: referenceOrthos } = storeToRefs(useExternalStore())
const {
  cropCloudOpen,
  demOpen,
  denseOpen,
  depthMapsOpen,
  detectFeaturesOpen,
  filterCloudOpen,
  filterCloudPreset,
  findGcpsOpen,
  footprintFromPosesOpen,
  georeferenceOpen,
  matchFeaturesOpen,
  mergeCloudsOpen,
  meshOpen,
  orthoOpen,
  reconstructOpen,
  scaleBarsOpen,
  toolModal,
} = storeToRefs(useModalsStore())
const {
  applyCrsSuggestion,
  closeReconstructModal,
  detectedImageCount,
  detectedMaxKeypoints,
  editableClouds,
  exportClipped,
  exportContours,
  exportKind,
  exportMeasurementScope,
  exportNameBase,
  exportTargetCloud,
  exportTargetProduct,
  exportTargetVectorSet,
  exportTerrain,
  footprintImageCount,
  georeferenceAfterReconstruct,
  matchSummaries,
  measurementExportCrs,
  meshClouds,
  onCropCloudRun,
  onDemRun,
  onDenseRun,
  onDepthMapsRun,
  onDetectRun,
  onExportRun,
  onFilterCloudRun,
  onGeoreferenceRun,
  onGradualSelectionRun,
  onImageQualityEstimate,
  onImageQualityGroup,
  onImageQualityRemove,
  onMatchRun,
  onMergeCloudsRun,
  onMeshRun,
  onOptimizeCamerasRun,
  onOrthoRun,
  onProductToolRun,
  onReconstructRun,
  onSectionRun,
  onToolEditRun,
  posedImageCount,
  startMarkingPoint,
} = useAppContext()
// Is the fitted scale still describing the current model + measurements? Read at
// render time (not cached) because it depends on the marks, which the user edits
// while the app is open. `scaleFitStatus` is the single owner of that rule.
const scaleFitValid = computed(() => reconstructionStore.scaleFitStatus().valid)
// A DEM / ortho's own CRS for the export's reprojection ('' = the local frame, no CRS).
const rasterCrsOf = (r) => (r?.crs && r.crs !== 'local' ? r.crs : '')
// The DEM / ortho a 'dem' / 'ortho' export writes: the one it was opened for, else the main one.
const exportRaster = computed(() =>
  exportKind.value === 'dem'
    ? (exportTargetProduct.value ?? dem.value)
    : exportKind.value === 'ortho'
      ? (exportTargetProduct.value ?? ortho.value)
      : null,
)
// A tool dialog starts on the cloud/mesh the user has selected, when it fits.
const toolInitialId = computed(() => reconstructionStore.selectedCloudId)
// The mesh a mesh or 3D Tiles export writes: the sidebar's target, else the selected
// mesh, else (mesh export only) the first mesh — as exports/clouds.js picks it.
const exportMeshCloud = computed(() => {
  const target = exportTargetCloud.value,
    sel = reconstructionStore.selectedCloud
  if (target) return target.kind === 'mesh' ? target : null
  if (sel?.kind === 'mesh') return sel
  return exportKind.value === 'mesh'
    ? (reconstructionStore.clouds.find((c) => c.kind === 'mesh' && c.count > 0) ?? null)
    : null
})
// What a 3D Tiles export writes, with its size (exports/clouds.js picks it the same way).
const exportTilesSubject = computed(() => {
  if (exportKind.value !== 'tiles3d') return null
  const s = tilesSubject(reconstructionStore.selectedCloud, reconstructionStore.clouds)
  return s ? { kind: s.kind, count: s.count, streamed: s.streamed, textured: s.textured } : null
})
const measurementsStore = useMeasurementsStore()
// Camera poses / calibration: how many cameras each source of the export has.
const exportSources = computed(() => {
  const estimated = reconstructionStore.mainSparseCloud?.cameras?.size ?? 0
  if (exportKind.value === 'poses') return { imported: poses.value.length, estimated }
  if (exportKind.value === 'sensors') return { entered: sensors.value.length, estimated }
  return {}
})
const footprintsStore = useFootprintsStore()
const exportingFootprints = computed(
  () => !!exportTargetVectorSet.value && exportTargetVectorSet.value.id === footprintsStore.footprintSet?.id,
)
</script>

<template>
  <Teleport to="body">
    <DetectFeaturesModal
      v-if="detectFeaturesOpen"
      :images="images"
      @close="detectFeaturesOpen = false"
      @run="onDetectRun"
    />
  </Teleport>

  <Teleport to="body">
    <MatchFeaturesModal
      v-if="matchFeaturesOpen"
      :detected-max-keypoints="detectedMaxKeypoints"
      :detected-image-count="detectedImageCount"
      :posed-image-count="posedImageCount"
      :footprint-image-count="footprintImageCount"
      :matched-pairs="matchedState.pairs"
      :unpaired-images="matchedState.unpairedImages"
      @close="matchFeaturesOpen = false"
      @run="onMatchRun"
    />
  </Teleport>

  <Teleport to="body">
    <ReconstructModal
      v-if="reconstructOpen"
      :ground-control-adjustment="georeferenceAfterReconstruct"
      :linked-images="matchedLinks.images"
      :pairs="matchedLinks.pairs"
      :sensors="sensors.length"
      :model-cameras="extendState.modelCameras"
      :new-images="extendState.newImages"
      :has-products="extendState.hasProducts"
      :extend-blocker="extendState.blocker"
      @close="closeReconstructModal"
      @run="onReconstructRun"
    />
  </Teleport>

  <Teleport to="body">
    <FindGcpsModal
      v-if="findGcpsOpen"
      :has-relative-ortho="!!ortho"
      :reference-orthos="referenceOrthos"
      @close="findGcpsOpen = false"
      @compute-footprints="footprintFromPosesOpen = true"
    />
  </Teleport>

  <Teleport to="body">
    <GeoreferenceModal
      v-if="georeferenceOpen"
      :can-adjust-with-gcps="canGeoreferenceGcps && canGeoreference"
      :can-transform="canGeoreference"
      :has-matches="matchSummaries.length > 0"
      :gcp-count="gcps.length"
      :pose-count="poses.length"
      :project-crs="currentCrs"
      @close="georeferenceOpen = false"
      @run="onGeoreferenceRun"
    />
  </Teleport>

  <Teleport to="body">
    <!-- Scale bars read/write their stores directly (like the Quality hub), so
         this is one MODAL_COMMANDS line plus this block. The one thing it needs
         App.vue for is handing a freshly created marker to the image view. -->
    <ScaleBarsModal
      v-if="scaleBarsOpen"
      @close="scaleBarsOpen = false"
      @mark-point="
        (id) => {
          scaleBarsOpen = false
          startMarkingPoint(id)
        }
      "
    />
  </Teleport>

  <Teleport to="body">
    <ExportModal
      v-if="exportKind"
      :kind="exportKind"
      :has-georef="!!georef"
      :has-scale="scaleFitValid || georef?.crs === currentCrs"
      :has-orientation="reconstructionStore.orientationState.active"
      :ortho-cells="exportRaster && exportKind === 'ortho' ? exportRaster.width * exportRaster.height : 0"
      :subject="
        exportTargetCloud?.name ??
        exportTargetProduct?.name ??
        (exportingFootprints ? null : exportTargetVectorSet?.name) ??
        exportMeasurementScope?.label ??
        ''
      "
      :textured="!!exportMeshCloud?.texture"
      :measurement-crs="
        exportKind === 'measurements'
          ? (measurementExportCrs(exportMeasurementScope?.ids ?? null, georef?.crs === currentCrs) ?? '')
          : ''
      "
      :raster-crs="exportRaster ? rasterCrsOf(exportRaster) : ''"
      :tiles-subject="exportTilesSubject"
      :name-base="exportNameBase"
      :sources="exportSources"
      :project-crs="currentCrs && currentCrs !== 'local' ? currentCrs : ''"
      :footprints="exportingFootprints"
      @close="exportKind = null"
      @run="onExportRun"
    />
  </Teleport>

  <Teleport to="body">
    <DepthMapsModal
      v-if="depthMapsOpen"
      :images="images"
      :registered="reconstructionStore.mainSparseCloud?.cameras?.size ?? 0"
      :saved-maps="reconstructionStore.depthMapsMeta"
      :saved-maps-key="reconstructionStore.depthMapsKey"
      :camera-keys="reconstructionStore.depthCameraKeys()"
      :model="reconstructionStore.mainSparseCloud"
      :scene-type="currentSceneType"
      @close="depthMapsOpen = false"
      @run="onDepthMapsRun"
    />
  </Teleport>

  <Teleport to="body">
    <DenseModal
      v-if="denseOpen"
      :maps="reconstructionStore.depthMapCount"
      :output="reconstructionStore.outputPlan('dense')"
      @close="denseOpen = false"
      @run="onDenseRun"
    />
  </Teleport>

  <Teleport to="body">
    <DemModal
      v-if="demOpen"
      :can-georeference="canGeoreference"
      :has-scale="scaleFitValid || georef?.crs === currentCrs"
      :georeference-blocker="georeferenceBlocker"
      :crs-suggestion="crsSuggestion"
      @apply-crs-suggestion="applyCrsSuggestion"
      :project-crs="currentCrs"
      :source="demSource"
      :ground-source="groundSource"
      :estimate-size="(s) => reconstructionStore.estimateRasterSize('dem', s)"
      :output="reconstructionStore.outputPlan('dem')"
      @close="demOpen = false"
      @run="onDemRun"
    />
  </Teleport>

  <Teleport to="body">
    <OrthoModal
      v-if="orthoOpen"
      :surfaces="orthoSurfaces"
      :depth-settings="depthSummary?.settings ?? null"
      :can-georeference="canGeoreference"
      :has-scale="scaleFitValid || georef?.crs === currentCrs"
      :dem-unit="dem?.unit ?? null"
      :georeference-blocker="georeferenceBlocker"
      :crs-suggestion="crsSuggestion"
      @apply-crs-suggestion="applyCrsSuggestion"
      :project-crs="currentCrs"
      :estimate-size="(s) => reconstructionStore.estimateRasterSize('ortho', s)"
      :output="reconstructionStore.outputPlan('ortho')"
      @close="orthoOpen = false"
      @run="onOrthoRun"
    />
  </Teleport>

  <Teleport to="body">
    <MeshModal
      v-if="meshOpen"
      :has-dense="clouds.some((c) => c.kind === 'dense' && c.count > 0)"
      :sources="meshSources"
      :default-source-id="meshSource?.id ?? null"
      :output="reconstructionStore.outputPlan('mesh')"
      @close="meshOpen = false"
      @run="onMeshRun"
    />
  </Teleport>

  <Teleport to="body">
    <FilterCloudModal
      v-if="filterCloudOpen"
      :clouds="croppableClouds"
      :initial-id="toolInitialId"
      :merge-cell="denseSummary?.mergeCell ?? 0"
      :start-method="filterCloudPreset"
      @close="
        () => {
          filterCloudOpen = false
          filterCloudPreset = null
        }
      "
      @run="onFilterCloudRun"
    />
  </Teleport>

  <Teleport to="body">
    <GradualSelectionModal
      v-if="toolModal === 'gradual-selection' && reconstructionStore.mainSparseCloud"
      :cloud="reconstructionStore.mainSparseCloud"
      @close="toolModal = null"
      @run="onGradualSelectionRun"
    />
  </Teleport>

  <!-- Tools ▸ Point Cloud ▾ / Mesh ▾ / Products ▾ — one shared slot (toolModal). -->
  <Teleport to="body">
    <NormalsModal
      v-if="toolModal === 'estimate-normals'"
      :clouds="editableClouds"
      :initial-id="toolInitialId"
      :cameras="reconstructionStore.mainSparseCloud?.cameras ?? null"
      @close="toolModal = null"
      @run="onToolEditRun"
    />
    <ClassifyGroundModal
      v-else-if="toolModal === 'classify-ground'"
      :clouds="croppableClouds"
      :initial-id="toolInitialId"
      :frame-signature="reconstructionStore.currentFrameSignature"
      @close="toolModal = null"
      @run="onToolEditRun"
    />
    <TransformCloudModal
      v-else-if="toolModal === 'transform-cloud'"
      :clouds="croppableClouds"
      :initial-id="toolInitialId"
      @close="toolModal = null"
      @run="onToolEditRun"
    />
    <AlignIcpModal
      v-else-if="toolModal === 'align-icp'"
      :clouds="croppableClouds"
      :references="[...croppableClouds, ...meshClouds]"
      :initial-id="toolInitialId"
      @close="toolModal = null"
      @run="onToolEditRun"
    />
    <CloudDistanceModal
      v-else-if="toolModal === 'cloud-distance'"
      :clouds="editableClouds"
      :references="[...croppableClouds, ...meshClouds]"
      :initial-id="toolInitialId"
      @close="toolModal = null"
      @run="onToolEditRun"
    />
    <SectionModal
      v-else-if="toolModal === 'cloud-section'"
      :clouds="editableClouds"
      :initial-id="toolInitialId"
      :frame-signature="reconstructionStore.currentFrameSignature"
      @close="toolModal = null"
      @run="onSectionRun"
    />
    <CleanMeshModal
      v-else-if="toolModal === 'clean-mesh'"
      :meshes="meshClouds"
      :initial-id="toolInitialId"
      @close="toolModal = null"
      @run="onToolEditRun"
    />
    <SmoothMeshModal
      v-else-if="toolModal === 'smooth-mesh'"
      :meshes="meshClouds"
      :initial-id="toolInitialId"
      @close="toolModal = null"
      @run="onToolEditRun"
    />
    <DecimateMeshModal
      v-else-if="toolModal === 'decimate-mesh'"
      :meshes="meshClouds"
      :initial-id="toolInitialId"
      @close="toolModal = null"
      @run="onToolEditRun"
    />
    <TextureMeshModal
      v-else-if="toolModal === 'texture-mesh'"
      :meshes="meshClouds"
      :initial-id="toolInitialId"
      :camera-count="reconstructionStore.mainSparseCloud?.cameras?.size ?? 0"
      @close="toolModal = null"
      @run="onToolEditRun"
    />
    <CropCloudModal
      v-else-if="toolModal === 'crop-mesh'"
      mesh
      :clouds="meshClouds"
      :initial-id="toolInitialId"
      @close="toolModal = null"
      @run="onToolEditRun"
    />
    <SampleMeshModal
      v-else-if="toolModal === 'mesh-to-points'"
      :meshes="meshClouds"
      :initial-id="toolInitialId"
      @close="toolModal = null"
      @run="onToolEditRun"
    />
    <MeshMeasureModal
      v-else-if="toolModal === 'mesh-measure'"
      :meshes="meshClouds"
      :initial-id="toolInitialId"
      :frame-signature="reconstructionStore.currentFrameSignature"
      @close="toolModal = null"
    />
    <ContoursModal
      v-else-if="toolModal === 'dem-contours'"
      :dem="dem"
      @close="toolModal = null"
      @run="(s) => onProductToolRun(exportContours, s)"
    />
    <TerrainModal
      v-else-if="toolModal === 'dem-derivatives'"
      :dem="dem"
      @close="toolModal = null"
      @run="(s) => onProductToolRun(exportTerrain, s)"
    />
    <OptimizeCamerasModal
      v-else-if="toolModal === 'optimize-cameras'"
      :cloud="reconstructionStore.mainSparseCloud"
      :gcp-count="gcps.length"
      @close="toolModal = null"
      @run="onOptimizeCamerasRun"
    />
    <ImageQualityModal
      v-else-if="toolModal === 'image-quality'"
      :images="images"
      @close="toolModal = null"
      @estimate="onImageQualityEstimate"
      @group="onImageQualityGroup"
      @remove="onImageQualityRemove"
    />
    <ClipRasterModal
      v-else-if="toolModal === 'clip-raster'"
      :dem="dem"
      :ortho="ortho"
      :measurements="measurementsStore.records"
      @close="toolModal = null"
      @run="(s) => onProductToolRun(exportClipped, s)"
    />
  </Teleport>

  <Teleport to="body">
    <CropCloudModal
      v-if="cropCloudOpen"
      :clouds="croppableClouds"
      :initial-id="toolInitialId"
      @close="cropCloudOpen = false"
      @run="onCropCloudRun"
    />
  </Teleport>

  <Teleport to="body">
    <MergeCloudsModal
      v-if="mergeCloudsOpen"
      :clouds="editableClouds"
      :merge-cell="denseSummary?.mergeCell ?? 0"
      @close="mergeCloudsOpen = false"
      @run="onMergeCloudsRun"
    />
  </Teleport>
</template>
