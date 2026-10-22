import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { crsInfo } from '../core/crs.js'
import { BASEMAPS, basemapReason } from '../core/basemaps.js'
import { useMapSettings } from './useMapSettings.js'
import { useViewerSettings } from './useViewerSettings.js'

// The views' display toggles and ribbon-entered modes, lifted out of App.vue, plus
// the one object the ribbon's View tab reads to show what is on. Session state
// (not persisted), unlike the point size, camera scale, basemap and Photos layer it
// also reports.
//
// Injected from useMapProducts: mapMode, mapFrame (the map's current frame).
export function useViewState({ mapMode, mapFrame }) {
  const { currentCrs } = storeToRefs(useProjectsStore())
  const { imageLayer } = storeToRefs(useReconstructionStore())

  // ── 3D scene display toggles ───────────────────────────────────────────────────
  const showCameras = ref(true)
  const showGrid = ref(true)
  const showLegend = ref(false)
  // ── Map display toggles ────────────────────────────────────────────────────────
  // The image footprints overlay (ribbon). Defaults on so freshly computed footprints
  // are visible at once. Contour and polygon layers are not footprints: they are
  // shown and hidden as layers (View ▸ Map ▸ Layers).
  const showFootprints = ref(true)
  const showMapGrid = ref(true)
  // Camera positions on the map: pose markers (imported / EXIF, or the SfM centres in
  // the model frame) and the GPS markers of images without a pose.
  const showMapCameras = ref(true)
  // GCP and marker symbols on the map (shown while GCPs are being edited regardless).
  const showMapGcps = ref(true)
  // The map's floating Layers panel (View ▸ Map ▸ Layers).
  const mapLayersPanel = ref(false)
  // Modes entered from the ribbon and left from there or the tool's floating
  // toolbox: the 3D selection tool and the turntable (both reported up by Viewer3D),
  // and map GCP editing.
  const selectTool3d = ref(null) // null | 'rect' | 'lasso'
  const turntable3d = ref(false)
  const mapGcpEdit = ref(false)
  const { pointSize, setPointSize, cameraScale, setCameraScale } = useViewerSettings()
  const { basemap: mapBasemap, setBasemap: setMapBasemap } = useMapSettings()
  // Why each base layer is unavailable in the map's current frame ('' = available).
  const mapBasemapReasons = computed(() => {
    const info = mapFrame.value ? null : crsInfo(currentCrs.value)
    return Object.fromEntries(BASEMAPS.map((b) => [b.value, basemapReason(b.value, info)]))
  })
  // Everything the ribbon's View tab shows as on / as a stepper value.
  const ribbonViewState = computed(() => ({
    showCameras: showCameras.value,
    showGrid: showGrid.value,
    showLegend: showLegend.value,
    showMapGrid: showMapGrid.value,
    showMapCameras: showMapCameras.value,
    showMapGcps: showMapGcps.value,
    mapLayersPanel: mapLayersPanel.value,
    mapModelFrame: mapMode.value === 'model',
    showFootprints: showFootprints.value,
    // A layer of the stack, persisted with the project (useReconstructionStore).
    showMapPhotos: !!imageLayer.value?.visible,
    pointSize: pointSize.value,
    cameraScale: cameraScale.value,
    selectRect: selectTool3d.value === 'rect',
    selectLasso: selectTool3d.value === 'lasso',
    turntable: turntable3d.value,
    mapGcpEdit: mapGcpEdit.value,
    mapBasemap: mapBasemap.value,
    mapBasemapReasons: mapBasemapReasons.value,
  }))

  return {
    showCameras,
    showGrid,
    showLegend,
    showFootprints,
    showMapGrid,
    showMapCameras,
    showMapGcps,
    mapLayersPanel,
    selectTool3d,
    turntable3d,
    mapGcpEdit,
    setPointSize,
    setCameraScale,
    setMapBasemap,
    ribbonViewState,
  }
}
