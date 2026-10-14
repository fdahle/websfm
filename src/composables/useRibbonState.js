import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useExternalStore } from '../stores/useExternalStore.js'
import { useGcpsStore } from '../stores/useGcpsStore.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useMatchesStore } from '../stores/useMatchesStore.js'
import { usePosesStore } from '../stores/usePosesStore.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { useImageViewSettings } from './useImageViewSettings.js'

// The state the ribbon renders from, lifted out of App.vue: `commandState`, the
// fields the one shared prerequisite table reads (core/help/commands.js NEED_CHECKS
// — the DevConsole guards on the same object), and the active image tab's overlay
// state for the ribbon's contextual Image tab.
//
// Injected: `tabs` (useTabs), `workspace` (useWorkspaceState's readiness flags),
// filmSensors / sensorForImage (useFiducialTools), activeImageGcps (useGcpEditing),
// mapMode / mapMeasureTargets (useMapProducts).
export function useRibbonState({ tabs, workspace, filmSensors, sensorForImage, activeImageGcps, mapMode, mapMeasureTargets }) {
  const { activeTab, activeView } = tabs
  const {
    imagesLoading, selected, kpImageCount, footprintCount, sparseReady, cloudReady, denseReady,
    editableClouds, demReady, meshReady, orthoReady, productReady,
  } = workspace
  const imagesStore = useImagesStore()
  const { images } = storeToRefs(imagesStore)
  const { imageById } = imagesStore
  const { currentProjectId, currentSceneType } = storeToRefs(useProjectsStore())
  const { usableMatchCount } = storeToRefs(useMatchesStore())
  const { gcps } = storeToRefs(useGcpsStore())
  const { poses } = storeToRefs(usePosesStore())
  const { sensors } = storeToRefs(useSensorsStore())
  const { depthMapCount } = storeToRefs(useReconstructionStore())
  const { hasReferenceDem } = storeToRefs(useExternalStore())
  const { imageViewPrefs, showKeypointsFor } = useImageViewSettings()

  // Guard state for BOTH the ribbon and the DevConsole command line: the fields the
  // one shared prerequisite table reads (core/help/commands.js NEED_CHECKS).
  // 'image' | 'raster' (a DEM/ortho tab) | 'map' | 'viewer' | '' (tables, inspectors).
  const frontView = computed(() => {
    const type = activeTab.value?.type
    if (type === 'image') return 'image'
    if (type === 'product' || type === 'raster') return 'raster'
    return activeView.value === 'map' || activeView.value === 'viewer' ? activeView.value : ''
  })
  const commandState = computed(() => ({
    projectReady:  !!currentProjectId.value,
    imageCount:    images.value.length,
    imagesLoading: imagesLoading.value,
    hasSelection:  !!selected.value,
    kpImageCount:  kpImageCount.value,
    matchCount:    usableMatchCount.value,
    gcpCount:      gcps.value.length,
    poseCount:     poses.value.length,
    footprintCount: footprintCount.value,
    sensorCount:   sensors.value.length,
    filmSensorCount: filmSensors.value.length,
    fiducialImageCount: images.value.filter((i) => i.fiducialDetections?.length).length,
    fiducialMarkSensorCount: sensors.value.filter((s) => s.fiducialCalibration?.marks?.length).length,
    sparseReady:   sparseReady.value,
    depthMapCount: depthMapCount.value,
    cloudReady:    cloudReady.value,
    denseReady:    denseReady.value,
    editableCloudCount: editableClouds.value.length,
    demReady:      demReady.value,
    meshReady:     meshReady.value,
    orthoReady:    orthoReady.value,
    productReady:  productReady.value,
    // The index, never the hydrated planes (useExternalStore invariant 1).
    referenceDemReady: hasReferenceDem.value,
    mapModelFrame: mapMode.value === 'model',
    // The view in front, for the tools that act on one (NEED_CHECKS imageView /
    // gcpView / measureHost), and the scene type the console's aerial-only check reads.
    frontView: frontView.value,
    mapRasterCount: mapMeasureTargets.value.length,
    sceneType: currentSceneType.value,
  }))

  // The active image tab's overlay toggles and counts, for the ribbon's Image tab.
  const activeImageViewState = computed(() => {
    const tab = activeTab.value
    if (!tab || tab.type !== 'image') return null
    const img = imageById(tab.imageId)
    if (!img) return null
    const prefs = imageViewPrefs.value
    return {
      showKeypoints: showKeypointsFor(img),
      showMask:      prefs.showMask,
      showDepth:     prefs.showDepth,
      showGcps:      prefs.showGcps,
      showResiduals: prefs.showResiduals,
      showFiducials: prefs.showFiducials,
      isFilm:        sensorForImage(tab.imageId)?.kind === 'film',
      maskEdit:      prefs.maskEdit,
      gcpEdit:       prefs.gcpEdit,
      kpStatus:      img.kpStatus,
      kpCount:       img.kpCount,
      hasMask:       !!img.mask,
      hasDepth:      !!img.depth,
      gcpCount:      activeImageGcps.value.length,
      fidCount:      (img.fiducialDetections?.length || 0),
    }
  })

  return { commandState, activeImageViewState }
}
