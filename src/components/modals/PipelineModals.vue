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
import { useAppContext } from '../../appContext.js'
import AlignIcpModal from '../modals/AlignIcpModal.vue'
import CleanMeshModal from '../modals/CleanMeshModal.vue'
import ClipRasterModal from '../modals/ClipRasterModal.vue'
import CloudDistanceModal from '../modals/CloudDistanceModal.vue'
import ContoursModal from '../modals/ContoursModal.vue'
import CropCloudModal from '../modals/CropCloudModal.vue'
import DecimateMeshModal from '../modals/DecimateMeshModal.vue'
import DemModal from '../modals/DemModal.vue'
import DenseModal from '../modals/DenseModal.vue'
import DepthMapsModal from '../modals/DepthMapsModal.vue'
import DetectFeaturesModal from '../modals/DetectFeaturesModal.vue'
import ExportModal from '../modals/ExportModal.vue'
import FilterCloudModal from '../modals/FilterCloudModal.vue'
import GeoreferenceModal from '../modals/GeoreferenceModal.vue'
import GradualSelectionModal from '../modals/GradualSelectionModal.vue'
import ImageQualityModal from '../modals/ImageQualityModal.vue'
import MatchFeaturesModal from '../modals/MatchFeaturesModal.vue'
import MergeCloudsModal from '../modals/MergeCloudsModal.vue'
import MeshMeasureModal from '../modals/MeshMeasureModal.vue'
import MeshModal from '../modals/MeshModal.vue'
import NormalsModal from '../modals/NormalsModal.vue'
import ClassifyGroundModal from '../modals/ClassifyGroundModal.vue'
import OptimizeCamerasModal from '../modals/OptimizeCamerasModal.vue'
import OrthoModal from '../modals/OrthoModal.vue'
import ReconstructModal from '../modals/ReconstructModal.vue'
import SampleMeshModal from '../modals/SampleMeshModal.vue'
import ScaleBarsModal from '../modals/ScaleBarsModal.vue'
import SectionModal from '../modals/SectionModal.vue'
import SmoothMeshModal from '../modals/SmoothMeshModal.vue'
import TerrainModal from '../modals/TerrainModal.vue'
import TransformCloudModal from '../modals/TransformCloudModal.vue'
const FindGcpsModal = defineAsyncComponent(() => import('../modals/FindGcpsModal.vue'))

// The pipeline and Tools-tab dialogs, lifted out of App.vue: each opens from a
// command (useCommandDispatch) and hands its settings to useDialogRuns on Run.
const { currentCrs } = storeToRefs(useProjectsStore())
const reconstructionStore = useReconstructionStore()
const { canGeoreference, canGeoreferenceGcps, clouds, crsSuggestion, dem, demSource, groundSource, denseSummary, depthSummary, georef, georeferenceBlocker, meshSource, meshSources, ortho, orthoSurfaces } = storeToRefs(reconstructionStore)
const { images } = storeToRefs(useImagesStore())
const { gcps } = storeToRefs(useGcpsStore())
const { poses } = storeToRefs(usePosesStore())
const { orthoRasters: referenceOrthos } = storeToRefs(useExternalStore())
const {
  cropCloudOpen, demOpen, denseOpen, depthMapsOpen, detectFeaturesOpen, filterCloudOpen,
  filterCloudPreset, findGcpsOpen, georeferenceOpen, matchFeaturesOpen, mergeCloudsOpen, meshOpen,
  orthoOpen, reconstructOpen, scaleBarsOpen, toolModal,
} = storeToRefs(useModalsStore())
const {
  applyCrsSuggestion, closeReconstructModal, detectedImageCount, detectedMaxKeypoints, editableClouds,
  exportClipped, exportContours, exportKind, exportTargetCloud, exportTerrain,
  footprintImageCount, georeferenceAfterReconstruct, matchSummaries, meshClouds, onCropCloudRun,
  onDemRun, onDenseRun, onDepthMapsRun, onDetectRun, onExportRun,
  onFilterCloudRun, onGeoreferenceRun, onGradualSelectionRun, onImageQualityEstimate, onImageQualityGroup,
  onImageQualityRemove, onMatchRun, onMergeCloudsRun, onMeshRun, onOptimizeCamerasRun,
  onOrthoRun, onProductToolRun, onReconstructRun, onSectionRun, onToolEditRun,
  posedImageCount, startMarkingPoint,
} = useAppContext()
// Is the fitted scale still describing the current model + measurements? Read at
// render time (not cached) because it depends on the marks, which the user edits
// while the app is open. `scaleFitStatus` is the single owner of that rule.
const scaleFitValid = computed(() => reconstructionStore.scaleFitStatus().valid)
// A tool dialog starts on the cloud/mesh the user has selected, when it fits.
const toolInitialId = computed(() => reconstructionStore.selectedCloudId)
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
      @mark-point="(id) => { scaleBarsOpen = false; startMarkingPoint(id) }"
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
      :subject="exportTargetCloud?.name ?? ''"
      @close="exportKind = null"
      @run="onExportRun"
    />
  </Teleport>


  <Teleport to="body">
    <DepthMapsModal
      v-if="depthMapsOpen"
      @close="depthMapsOpen = false"
      @run="onDepthMapsRun"
    />
  </Teleport>


  <Teleport to="body">
    <DenseModal
      v-if="denseOpen"
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
      :clouds="editableClouds"
      :initial-id="toolInitialId"
      :merge-cell="denseSummary?.mergeCell ?? 0"
      :start-method="filterCloudPreset"
      @close="filterCloudOpen = false; filterCloudPreset = null"
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
    <NormalsModal v-if="toolModal === 'estimate-normals'" :clouds="editableClouds" :initial-id="toolInitialId"
      :cameras="reconstructionStore.mainSparseCloud?.cameras ?? null" @close="toolModal = null" @run="onToolEditRun" />
    <ClassifyGroundModal v-else-if="toolModal === 'classify-ground'" :clouds="editableClouds" :initial-id="toolInitialId"
      :frame-signature="reconstructionStore.currentFrameSignature" @close="toolModal = null" @run="onToolEditRun" />
    <TransformCloudModal v-else-if="toolModal === 'transform-cloud'" :clouds="editableClouds" :initial-id="toolInitialId"
      @close="toolModal = null" @run="onToolEditRun" />
    <AlignIcpModal v-else-if="toolModal === 'align-icp'" :clouds="editableClouds" :references="[...editableClouds, ...meshClouds]"
      :initial-id="toolInitialId" @close="toolModal = null" @run="onToolEditRun" />
    <CloudDistanceModal v-else-if="toolModal === 'cloud-distance'" :clouds="editableClouds" :references="[...editableClouds, ...meshClouds]"
      :initial-id="toolInitialId" @close="toolModal = null" @run="onToolEditRun" />
    <SectionModal v-else-if="toolModal === 'cloud-section'" :clouds="editableClouds" :initial-id="toolInitialId"
      :frame-signature="reconstructionStore.currentFrameSignature" @close="toolModal = null" @run="onSectionRun" />
    <CleanMeshModal v-else-if="toolModal === 'clean-mesh'" :meshes="meshClouds" :initial-id="toolInitialId"
      @close="toolModal = null" @run="onToolEditRun" />
    <SmoothMeshModal v-else-if="toolModal === 'smooth-mesh'" :meshes="meshClouds" :initial-id="toolInitialId"
      @close="toolModal = null" @run="onToolEditRun" />
    <DecimateMeshModal v-else-if="toolModal === 'decimate-mesh'" :meshes="meshClouds" :initial-id="toolInitialId"
      @close="toolModal = null" @run="onToolEditRun" />
    <CropCloudModal v-else-if="toolModal === 'crop-mesh'" mesh :clouds="meshClouds" :initial-id="toolInitialId"
      @close="toolModal = null" @run="onToolEditRun" />
    <SampleMeshModal v-else-if="toolModal === 'mesh-to-points'" :meshes="meshClouds" :initial-id="toolInitialId"
      @close="toolModal = null" @run="onToolEditRun" />
    <MeshMeasureModal v-else-if="toolModal === 'mesh-measure'" :meshes="meshClouds" :initial-id="toolInitialId"
      :frame-signature="reconstructionStore.currentFrameSignature" @close="toolModal = null" />
    <ContoursModal v-else-if="toolModal === 'dem-contours'" :dem="dem"
      @close="toolModal = null" @run="(s) => onProductToolRun(exportContours, s)" />
    <TerrainModal v-else-if="toolModal === 'dem-derivatives'" :dem="dem"
      @close="toolModal = null" @run="(s) => onProductToolRun(exportTerrain, s)" />
    <OptimizeCamerasModal v-else-if="toolModal === 'optimize-cameras'" :cloud="reconstructionStore.mainSparseCloud"
      :gcp-count="gcps.length" @close="toolModal = null" @run="onOptimizeCamerasRun" />
    <ImageQualityModal v-else-if="toolModal === 'image-quality'" :images="images"
      @close="toolModal = null" @estimate="onImageQualityEstimate" @group="onImageQualityGroup" @remove="onImageQualityRemove" />
    <ClipRasterModal v-else-if="toolModal === 'clip-raster'" :dem="dem" :ortho="ortho" :measurements="measurementsStore.records"
      @close="toolModal = null" @run="(s) => onProductToolRun(exportClipped, s)" />
  </Teleport>


  <Teleport to="body">
    <CropCloudModal
      v-if="cropCloudOpen"
      :clouds="editableClouds"
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
