<script setup>
import { computed, defineAsyncComponent } from 'vue'
import { storeToRefs } from 'pinia'
import { useProjectsStore } from '../../stores/useProjectsStore.js'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'
import { useImagesStore } from '../../stores/useImagesStore.js'
import { useGcpsStore } from '../../stores/useGcpsStore.js'
import { useSensorsStore } from '../../stores/useSensorsStore.js'
import { usePosesStore } from '../../stores/usePosesStore.js'
import { useMatchesStore } from '../../stores/useMatchesStore.js'
import { useExternalStore } from '../../stores/useExternalStore.js'
import { useModalsStore } from '../../stores/useModalsStore.js'
import { useAppContext } from '../../appContext.js'
import AutoMaskModal from './images/AutoMaskModal.vue'
import CameraImportModal from './import/CameraImportModal.vue'
import FiducialImportModal from './import/FiducialImportModal.vue'
import CameraPoseTableModal from './inspect/CameraPoseTableModal.vue'
import CloudSymbologyModal from './cloud/CloudSymbologyModal.vue'
import FiducialCalibrateModal from './images/FiducialCalibrateModal.vue'
import FiducialDetectModal from './images/FiducialDetectModal.vue'
import ReseauModal from './images/ReseauModal.vue'
import PanoramicModal from './images/PanoramicModal.vue'
import FootprintFromPosesModal from './model/FootprintFromPosesModal.vue'
import FootprintImportModal from './import/FootprintImportModal.vue'
import GcpImportModal from './import/GcpImportModal.vue'
import GcpTableModal from './inspect/GcpTableModal.vue'
import ImageInfoModal from './inspect/ImageInfoModal.vue'
import ImageTableModal from './inspect/ImageTableModal.vue'
import ImportCloudModal from './import/ImportCloudModal.vue'
import ImportKindModal from './import/ImportKindModal.vue'
import ImportRasterModal from './import/ImportRasterModal.vue'
import ImportVideoModal from './import/ImportVideoModal.vue'
import InteropImportModal from './import/InteropImportModal.vue'
import InteropSourceModal from './import/InteropSourceModal.vue'
import MaskManagerModal from './inspect/MaskManagerModal.vue'
import MatchListModal from './inspect/MatchListModal.vue'
import ProductSymbologyModal from './products/ProductSymbologyModal.vue'
import RasterStyleModal from './products/RasterStyleModal.vue'
import SensorTableModal from './inspect/SensorTableModal.vue'
const QualityReportModal = defineAsyncComponent(() => import('./eval/QualityReportModal.vue'))

// The data dialogs, lifted out of App.vue: imports, the image / sensor / GCP /
// pose / match tables, fiducials, symbology and the Quality Report hub.
const { currentCrs, currentSceneType } = storeToRefs(useProjectsStore())
const reconstructionStore = useReconstructionStore()
const { cameras, clouds, dem, ortho, sparseCameras } = storeToRefs(reconstructionStore)
const { setCloudStyle, setProductStyle } = reconstructionStore
const imagesStore = useImagesStore()
const { images, selectedId } = storeToRefs(imagesStore)
const { selectImage } = imagesStore
const { importDefaults: gcpImportDefaults, gcps } = storeToRefs(useGcpsStore())
const { addPoint, setGcpAccuracy, setGcpName, setGcpPosition, setGcpVerticalDatum, setObservationAccuracy } = useGcpsStore()
const { sensors } = storeToRefs(useSensorsStore())
const { applyFilmFormat, assignSensor, setFiducialMarks, toggleSensorFixed, updateSensor } = useSensorsStore()
const { poses } = storeToRefs(usePosesStore())
const { matchStore } = storeToRefs(useMatchesStore())
const { setPairEnabled } = useMatchesStore()
const { hasReferenceDem } = storeToRefs(useExternalStore())
const { setRasterKind, setRasterAccuracy } = useExternalStore()
const {
  autoMaskOpen, cameraImportMode, cameraImportName, cameraImportOpen, cameraImportText, fiducialCalibrateOpen,
  fiducialCalibrateSensorId, fiducialDetectOpen, fiducialDetectSensorId, fiducialImportData, footprintFromPosesOpen, footprintImportData, footprintImportOpen,
  gcpImportCrs, gcpImportGeojson, gcpImportName, gcpImportOpen, gcpImportText, gcpTableOpen,
  imageTableOpen, importCloudData, importCloudOpen, importKindDeclared, importKindFile, importKindOpen,
  importRasterData, importRasterOpen, importVideoFile, infoImageId, maskManagerOpen, matchListOpen, poseTableOpen,
  qualityOpen, qualitySection, rasterStyleId, sensorTableOpen, sfmSourceOpen, symbologyCloudId,
  symbologyProductKind, reseauOpen, panoramicOpen,
} = storeToRefs(useModalsStore())
const {
  alignedUuids, changeGcpRole, checkGcpZAgainstReferenceDem, closeSfmImport, commitSfmImport, convertGcpHeightsTo,
  confirmRemoveGcp, confirmRemoveSensor, editMask, fiducialCalibrateImages, fiducialCalibrateSensor,
  fiducialDetectImages, fiducialDetectSensor, fillGcpZFromReferenceDem, gcpReport, hasSparse,
  matchNodePositions, matchSummaries, onCameraImport, onCloudImport, onFootprintFromPoses,
  onFiducialImport, onFootprintImport, onGcpImport, onImportKindChosen, onImportSwitchKind, onRasterImportAsImage,
  onRasterStyleApply, onVideoImport, openImageTab, openImageWithResiduals, pickSfmFiles, pickSfmFolder,
  rasterBeingStyled, refreshGcpReport, selectGcp, selectedGcpId, sfmImportSession,
  usedKeysOf,
} = useAppContext()
const symbologyProduct = computed(() => (symbologyProductKind.value === 'dem' ? dem.value
  : symbologyProductKind.value === 'ortho' ? ortho.value : null))
const symbologyCloud = computed(() => clouds.value.find((c) => c.id === symbologyCloudId.value) ?? null)
const infoImage = computed(() => (infoImageId.value ? imagesStore.imageById(infoImageId.value) : null))
</script>

<template>

  <Teleport to="body">
    <InteropSourceModal
      v-if="sfmSourceOpen"
      @close="sfmSourceOpen = false"
      @files="pickSfmFiles"
      @folder="pickSfmFolder"
    />
  </Teleport>


  <Teleport to="body">
    <InteropImportModal
      v-if="sfmImportSession"
      :session="sfmImportSession"
      @close="closeSfmImport"
      @run="commitSfmImport"
    />
  </Teleport>


  <Teleport to="body">
    <GcpImportModal
      v-if="gcpImportOpen"
      :raw-text="gcpImportText"
      :file-name="gcpImportName"
      :project-crs="currentCrs"
      :geojson-gcps="gcpImportGeojson"
      :detected-crs="gcpImportCrs"
      :accuracy-defaults="gcpImportDefaults"
      :existing-gcps="gcps"
      :kind-declared="importKindDeclared"
      @close="() => { gcpImportOpen = false; gcpImportGeojson = null; gcpImportText = ''; gcpImportCrs = null }"
      @import="onGcpImport"
      @switch-kind="onImportSwitchKind"
    />
  </Teleport>


  <Teleport to="body">
    <ImportKindModal
      v-if="importKindOpen && importKindFile"
      :file-name="importKindFile.name"
      @close="() => { importKindOpen = false; importKindFile = null }"
      @select="onImportKindChosen"
    />
  </Teleport>

  <Teleport to="body">
    <FiducialImportModal
      v-if="fiducialImportData"
      :data="fiducialImportData"
      :images="images"
      :sensors="sensors"
      @close="fiducialImportData = null"
      @import="onFiducialImport"
    />
  </Teleport>


  <Teleport to="body">
    <ImportCloudModal
      v-if="importCloudOpen && importCloudData"
      :data="importCloudData"
      @close="() => { importCloudOpen = false; importCloudData = null }"
      @run="onCloudImport"
    />
  </Teleport>


  <Teleport to="body">
    <ImportVideoModal
      v-if="importVideoFile"
      :key="importVideoFile.name + importVideoFile.size + importVideoFile.lastModified"
      :file="importVideoFile"
      @close="importVideoFile = null"
      @run="onVideoImport"
    />
  </Teleport>


  <Teleport to="body">
    <ImportRasterModal
      v-if="importRasterOpen && importRasterData"
      :data="importRasterData"
      @close="() => { importRasterOpen = false; importRasterData = null }"
      @set-kind="({ id, kind }) => setRasterKind(id, kind)"
      @set-accuracy="({ id, ...v }) => setRasterAccuracy(id, v)"
      @import-as-image="onRasterImportAsImage"
    />
  </Teleport>


  <Teleport to="body">
    <ProductSymbologyModal v-if="symbologyProduct" :key="symbologyProductKind" :kind="symbologyProductKind" :product="symbologyProduct"
      @close="symbologyProductKind = null" @apply="({ kind, style }) => setProductStyle(kind, style)" />
    <CloudSymbologyModal v-if="symbologyCloud" :key="symbologyCloud.id" :cloud="symbologyCloud" :clouds="clouds"
      @close="symbologyCloudId = null" @apply="({ id, style }) => setCloudStyle(id, style)" />
    <RasterStyleModal
      v-if="rasterBeingStyled"
      :raster="rasterBeingStyled"
      @close="rasterStyleId = null"
      @apply="onRasterStyleApply"
    />
  </Teleport>


  <Teleport to="body">
    <FootprintImportModal
      v-if="footprintImportOpen && footprintImportData"
      :features="footprintImportData.features"
      :property-keys="footprintImportData.propertyKeys"
      :detected-crs="footprintImportData.detectedCrs"
      :file-name="footprintImportData.fileName"
      :project-crs="currentCrs"
      :images="images"
      @close="() => { footprintImportOpen = false; footprintImportData = null }"
      @import="onFootprintImport"
    />
  </Teleport>


  <Teleport to="body">
    <FootprintFromPosesModal
      v-if="footprintFromPosesOpen"
      :poses="poses"
      :sensors="sensors"
      :images="images"
      :project-crs="currentCrs"
      @close="footprintFromPosesOpen = false"
      @run="onFootprintFromPoses"
    />
  </Teleport>


  <Teleport to="body">
    <CameraImportModal
      v-if="cameraImportOpen"
      :raw-text="cameraImportText"
      :file-name="cameraImportName"
      :project-crs="currentCrs"
      :detected-mode="cameraImportMode"
      :kind-declared="importKindDeclared"
      :sensors="sensors"
      :images="images"
      @close="cameraImportOpen = false"
      @import="onCameraImport"
      @switch-kind="onImportSwitchKind"
    />
  </Teleport>


  <Teleport to="body">
    <ImageTableModal
      v-if="imageTableOpen"
      :images="images"
      :sensors="sensors"
      :poses="poses"
      :cameras="cameras"
      :crs="currentCrs"
      :selected-id="selectedId"
      @close="imageTableOpen = false"
      @select="selectImage"
      @open="(id) => { openImageTab(id); imageTableOpen = false }"
      @assign-sensor="({ imageId, sensorId }) => assignSensor(imageId, sensorId)"
      @open-sensor-table="() => { imageTableOpen = false; sensorTableOpen = true }"
    />

    <CameraPoseTableModal
      v-if="poseTableOpen"
      :poses="poses"
      :crs="currentCrs"
      @close="poseTableOpen = false"
    />

    <MaskManagerModal
      v-if="maskManagerOpen"
      @close="maskManagerOpen = false"
      @edit="editMask"
    />
    <AutoMaskModal
      v-if="autoMaskOpen"
      @close="autoMaskOpen = false"
    />
  </Teleport>


  <Teleport to="body">
    <SensorTableModal
      v-if="sensorTableOpen"
      :sensors="sensors"
      :images="images"
      :cameras="sparseCameras"
      @close="sensorTableOpen = false"
      @update="({ id, field, value }) => updateSensor(id, field, value)"
      @apply-film-format="({ id, widthMm, reason }) => applyFilmFormat(id, widthMm, reason)"
      @toggle-fixed="({ id, field }) => toggleSensorFixed(id, field)"
      @set-fiducial-marks="({ id, marks }) => setFiducialMarks(id, marks)"
      @detect-fiducials="(id) => { fiducialDetectSensorId = id; fiducialDetectOpen = true }"
      @calibrate-fiducials="(id) => { fiducialCalibrateSensorId = id; fiducialCalibrateOpen = true }"
      @remove="confirmRemoveSensor"
    />
  </Teleport>


  <Teleport to="body">
    <FiducialCalibrateModal
      v-if="fiducialCalibrateOpen && fiducialCalibrateSensor"
      :sensor="fiducialCalibrateSensor"
      :images="fiducialCalibrateImages"
      @close="fiducialCalibrateOpen = false"
      @detect="() => { fiducialCalibrateOpen = false; fiducialDetectSensorId = fiducialCalibrateSensor.id; fiducialDetectOpen = true }"
    />
  </Teleport>


  <Teleport to="body">
    <FiducialDetectModal
      v-if="fiducialDetectOpen && fiducialDetectSensor"
      :sensor="fiducialDetectSensor"
      :images="fiducialDetectImages"
      @close="fiducialDetectOpen = false"
      @open-image="(id) => { openImageTab(id); fiducialDetectOpen = false; sensorTableOpen = false }"
    />
  </Teleport>

  <Teleport to="body">
    <ReseauModal v-if="reseauOpen" @close="reseauOpen = false" />
    <PanoramicModal v-if="panoramicOpen" @close="panoramicOpen = false" />
  </Teleport>


  <Teleport to="body">
    <GcpTableModal
      v-if="gcpTableOpen"
      :gcps="gcps"
      :crs="currentCrs"
      :report="gcpReport"
      :selected-gcp-id="selectedGcpId"
      :has-reference-dem="hasReferenceDem"
      :scene-type="currentSceneType"
      @fill-z="fillGcpZFromReferenceDem"
      @check-z="checkGcpZAgainstReferenceDem"
      @convert-heights="convertGcpHeightsTo"
      @close="gcpTableOpen = false"
      @remove="confirmRemoveGcp"
      @update-accuracy="({ id, kind, value }) => setGcpAccuracy(id, kind, value)"
      @update-observation-accuracy="({ gcpId, imageId, axis, value }) => setObservationAccuracy(gcpId, imageId, axis, value)"
      @update-name="({ id, name }) => setGcpName(id, name)"
      @update-role="changeGcpRole"
      @update-vertical-datum="({ id, verticalDatum }) => setGcpVerticalDatum(id, verticalDatum)"
      @update-position="({ id, axis, value }) => setGcpPosition(id, axis, value)"
      @refresh-report="refreshGcpReport"
      @select="selectGcp"
      @add="(role) => addPoint({ role })"
    />
  </Teleport>


  <Teleport to="body">
    <MatchListModal
      v-if="matchListOpen"
      :match-summaries="matchSummaries"
      :images="images"
      :match-store="matchStore"
      :has-sparse="hasSparse"
      :aligned-uuids="alignedUuids"
      :used-keys-of="usedKeysOf"
      :node-positions="matchNodePositions"
      @set-pair-enabled="setPairEnabled"
      @close="matchListOpen = false"
    />
  </Teleport>


  <!-- Evaluate tab: the Quality Report hub (PLAN-eval-quality-hub) -->
  <Teleport to="body">
    <QualityReportModal
      v-if="qualityOpen"
      :section="qualitySection"
      @close="qualityOpen = false"
      @open-image="(id) => { openImageTab(id); qualityOpen = false }"
      @open-image-residuals="openImageWithResiduals"
      @open-match-list="() => { qualityOpen = false; matchListOpen = true }"
    />
  </Teleport>

  <Teleport to="body">
    <ImageInfoModal
      v-if="infoImage"
      :image="infoImage"
      @close="infoImageId = null"
    />
  </Teleport>
</template>
