import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { crsInfo } from '../core/crs.js'
import { BASEMAPS, basemapReason } from '../core/basemaps.js'
import { useMapSettings } from './useMapSettings.js'
import { useViewerSettings } from './useViewerSettings.js'

// The views' display toggles and ribbon-entered modes, lifted out of App.vue, plus
// the one object the ribbon's View tab reads to show what is on. Session state
// (not persisted), unlike the point size, camera scale and basemap it also reports.
//
// Injected from useMapProducts: mapMode, mapFrame (the map's current frame).
export function useViewState({ mapMode, mapFrame }) {
  const { currentCrs } = storeToRefs(useProjectsStore())

  // ── 3D scene display toggles ───────────────────────────────────────────────────
  const showCameras = ref(true)
  const showGrid = ref(true)
  const showLegend = ref(false)
  // ── Map display toggles ────────────────────────────────────────────────────────
  // The footprint layer master toggle (ribbon). Defaults on so a freshly computed
  // or imported shapefile set is visible immediately; per-set visibility is the
  // finer control (each set's `visible` flag, toggled from its sidebar row). The
  // layer only ever holds polygons from sets the user has kept on the map, so this
  // no longer clutters a bare basemap.
  const showFootprints = ref(true)
  const showMapGrid = ref(true)
  // Camera positions on the map: pose markers (imported / EXIF, or the SfM centres in
  // the model frame) and the GPS markers of images without a pose.
  const showMapCameras = ref(true)
  // Modes entered from the ribbon and left from there or the tool's floating
  // toolbox: the 3D selection tool (reported up by Viewer3D) and map GCP editing.
  const selectTool3d = ref(null) // null | 'rect' | 'lasso'
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
    mapModelFrame: mapMode.value === 'model',
    showFootprints: showFootprints.value,
    pointSize: pointSize.value,
    cameraScale: cameraScale.value,
    selectRect: selectTool3d.value === 'rect',
    selectLasso: selectTool3d.value === 'lasso',
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
    selectTool3d,
    mapGcpEdit,
    setPointSize,
    setCameraScale,
    setMapBasemap,
    ribbonViewState,
  }
}
