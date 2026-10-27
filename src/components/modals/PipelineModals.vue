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
      :ortho-cells="reconstructionStore.ortho ? reconstructionStore.ortho.width * reconstructionStore.ortho.height : 0"
      :subject="exportTargetCloud?.name ?? exportMeasurementScope?.label ?? ''"
      :textured="!!exportMeshCloud?.texture"
      :measurement-crs="
        exportKind === 'measurements'
          ? (measurementExportCrs(exportMeasurementScope?.ids ?? null, georef?.crs === currentCrs) ?? '')
          : ''
      "
      :raster-crs="exportKind === 'dem' ? rasterCrsOf(dem) : exportKind === 'ortho' ? rasterCrsOf(ortho) : ''"
      :tiles-subject="exportTilesSubject"
      :name-base="exportNameBase"
      @close="exportKind = null"
      @run="onExportRun"
    />
  </Teleport>

  <Teleport to="body">
    <DepthMapsModal
      v-if="depthMapsOpen"
      :images="images"
      :registered="reconstructionStore.mainSparseCloud?.cameras?.size ?? 0"
      :scene-type="currentSceneType"
      @close="depthMapsOpen = false"
      @run="onDepthMapsRun"
    />
  </Teleport>

  <Teleport to="body">
    <DenseModal
      v-if="denseOpen"
      :maps="reconstructionStore.depthMapCount"
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
