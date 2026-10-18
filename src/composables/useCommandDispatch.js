import { nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import { useGlossaryStore } from '../stores/useGlossaryStore.js'
import { useGuideStore } from '../stores/useGuideStore.js'
import { useModalsStore } from '../stores/useModalsStore.js'
import { useExternalStore } from '../stores/useExternalStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { FILE_PICKERS, pickFiles } from '../utils/pickFiles.js'
import { useImageViewSettings } from './useImageViewSettings.js'
import { useTheme } from './useTheme.js'

// The one command dispatch, lifted out of App.vue: every ribbon button, console
// verb, viewer menu and interactive workflow block arrives here as a command id
// (core/help/ribbonTabs.js, core/help/commands.js). Commands that only open a
// dialog are tables; everything else is a case below. ribbonTabs.test.js reads the
// handled ids out of this file, so a ribbon button with no handler fails a test.
//
// Injected, grouped by where it lives in App.vue:
//   tabs     — useTabs: activateTab, activeView, activeTab, activeImageTab
//   viewers  — the 3D / map / image viewer refs, and the raster tab in front
//   view     — useViewState's toggles and setters
//   map      — useMapProducts: toggleModelFrame, setMapMeasureTarget
//   tools    — feature openers (model tools, fiducials, GCP report, quality hub)
//   exports  — useExports
//   removals — the confirm-first removals (useConfirmations, useRasterTabs)
//   imports  — useImportRouting's pick handlers, cameraPickMode, addImagesRouted,
//              and useProjectLifecycle's onProjectFilePick
//   consoleOpen — App's console toggle
export function useCommandDispatch({ tabs, viewers, view, map, tools, exports, removals, imports, consoleOpen }) {
  const { activateTab, activeView, activeTab, activeImageTab, openProductTab } = tabs
  const { viewerRef, mapViewerRef, imageViewerRefs, activeProductViewer, activeRasterTab } = viewers
  const {
    showCameras, showGrid, showLegend, showFootprints, showMapGrid, selectTool3d, mapGcpEdit,
    setPointSize, setCameraScale, setMapBasemap,
  } = view
  const { toggleModelFrame, setMapMeasureTarget } = map
  const {
    openRegionTool, openOrientTool, openAlignPairs, openFiducialDetect, openFiducialCalibrate,
    refreshGcpReport, openQuality,
  } = tools
  const {
    exportKind, exportPoses, exportSensors, exportCameraFiducials, exportImageFiducials,
    exportKeypoints, exportMatches, downloadRasterOriginal, openMeasurementExport,
  } = exports
  const { confirmRemoveRaster, confirmRemoveProduct, requestRemoveImages } = removals
  const {
    cameraPickMode, addImagesRouted, onGcpPick, onCameraPick, onFiducialObsPick, onFiducialMarksPick,
    onColmapPick, onCloudPick, onRasterPick, onVideoPick, onProjectFilePick,
  } = imports
  const {
    saveProjectOpen, workflowBuilderOpen, imageTableOpen, poseTableOpen, maskManagerOpen, autoMaskOpen,
    sensorTableOpen, matchListOpen, detectFeaturesOpen, matchFeaturesOpen, reconstructOpen, findGcpsOpen,
    georeferenceOpen, scaleBarsOpen, depthMapsOpen, denseOpen, demOpen, orthoOpen, meshOpen,
    filterCloudOpen, cropCloudOpen, mergeCloudsOpen, footprintFromPosesOpen, settingsOpen,
    projectSettingsOpen, aboutOpen, systemInfoOpen, debugSummaryOpen, filterCloudPreset, toolModal,
    gcpTableOpen, projectPickerOpen, rasterStyleId, infoImageId, symbologyProductKind, sfmSourceOpen,
  } = storeToRefs(useModalsStore())
  const glossaryStore = useGlossaryStore()
  const guideStore = useGuideStore()
  const { setRasterVisible } = useExternalStore()
  const { setProductVisible } = useReconstructionStore()
  const { cycleTheme } = useTheme()
  const { imageViewPrefs, patchImageView } = useImageViewSettings()

  // A picked GeoTIFF DEM arrives as `image/tiff`; addImagesRouted applies the same
  // georeference fork as the drop path, so it lands as reference data.
  function onRibbonPick(event) {
    const files = [...event.target.files].filter((f) => f.type.startsWith('image/'))
    if (files.length) addImagesRouted(files)
  }
  // The choosers the template opens itself (Import ▸ SfM project's two buttons and
  // the project picker's "Open file…").
  function pickSfmFiles() { pickFiles(FILE_PICKERS.sfmFiles, (e) => { sfmSourceOpen.value = false; onColmapPick(e) }) }
  function pickSfmFolder() { pickFiles(FILE_PICKERS.sfmFolder, (e) => { sfmSourceOpen.value = false; onColmapPick(e) }) }
  function pickProjectFile() { pickFiles(FILE_PICKERS.project, onProjectFilePick) }

  // Commands whose entire effect is "open this modal", as data rather than 22
  // identical switch cases. A new pipeline modal is one line here. Anything with a
  // guard, a toggle, or a side effect (open-gcp-table also refreshes the report;
  // open-project-picker toggles) stays an explicit case below — the table is for the
  // trivial ones only, so it never hides behaviour.
  const MODAL_COMMANDS = {
    'save-project-file':     saveProjectOpen,
    'workflow-builder':      workflowBuilderOpen,
    'open-image-table':      imageTableOpen,
    'open-pose-table':       poseTableOpen,
    'open-mask-manager':     maskManagerOpen,
    'auto-mask':             autoMaskOpen,
    'open-sensor-table':     sensorTableOpen,
    'open-match-list':       matchListOpen,
    'detect-features':       detectFeaturesOpen,
    'match-features':        matchFeaturesOpen,
    'reconstruct':           reconstructOpen,
    'find-gcps':             findGcpsOpen,
    'georeference':          georeferenceOpen,
    'scale-bars':            scaleBarsOpen,
    'compute-depth':         depthMapsOpen,
    'dense':                 denseOpen,
    'gen-dem':               demOpen,
    'gen-ortho':             orthoOpen,
    'gen-mesh':              meshOpen,
    'filter-cloud':          filterCloudOpen,
    'crop-cloud':            cropCloudOpen,
    'merge-clouds':          mergeCloudsOpen,
    'footprints-from-poses': footprintFromPosesOpen,
    'open-settings':         settingsOpen,
    'open-project-settings': projectSettingsOpen,
    'open-about':            aboutOpen,
    'open-system-info':      systemInfoOpen,
    'open-debug-summary':    debugSummaryOpen,
  }

  // Quality Report hub deep-links: each ribbon id opens the hub on its section.
  const EVAL_SECTIONS = {
    'eval-overview':       'overview',
    'eval-reconstruction': 'sparse',
    'eval-calibration':    'calibration',
    'eval-gcps':           'accuracy',
    'eval-match-graph':    'matching',
    'eval-coverage':       'coverage',
    'eval-depth-coverage': 'dense',
    'eval-dem-reference':  'products',
  }

  // Tools-tab dialogs that share the one `toolModal` slot (see useModalsStore): the
  // command id IS the slot value, and the template mounts the matching dialog.
  const TOOL_MODALS = new Set([
    'gradual-selection',
    // Point Cloud ▾
    'estimate-normals', 'classify-ground', 'cloud-section', 'transform-cloud', 'align-icp', 'cloud-distance',
    // Mesh ▾
    'clean-mesh', 'smooth-mesh', 'decimate-mesh', 'crop-mesh', 'mesh-to-points', 'texture-mesh', 'mesh-measure',
    // Products ▾
    'dem-contours', 'dem-derivatives', 'clip-raster',
    // Images ▾
    'image-quality',
    // Model ▾
    'optimize-cameras',
  ])

  // Filter Cloud deep links: the same dialog, starting on one method.
  const FILTER_DEEP_LINKS = { 'cloud-outliers': 'sor', 'cloud-subsample': 'voxel' }

  // Tools ▸ Point Cloud ▾ ▸ Select: the rows show whether a tool is on, so a click in
  // the 3D view toggles it. From another view it brings the 3D view forward with
  // that tool on — never off, which would read as the click doing nothing.
  function chooseSelectTool(kind) {
    const fromElsewhere = activeView.value !== 'viewer'
    activateTab('viewer')
    if (fromElsewhere && selectTool3d.value === kind) return
    viewerRef.value?.toggleSelectTool(kind)
  }

  // `value` is set by a ribbon stepper (the new display value), and by the callers of
  // the few commands that take an argument (export-measurements' list scope).
  function handleCommand(id, value) {
    // A deep link's starting method must not leak into a plain "Filter…" (Escape
    // closes the dialog without passing through its @close handler).
    if (id === 'filter-cloud') filterCloudPreset.value = null
    const modal = MODAL_COMMANDS[id]
    if (modal) { modal.value = true; return }
    if (TOOL_MODALS.has(id)) { toolModal.value = id; return }
    if (FILTER_DEEP_LINKS[id]) { filterCloudPreset.value = FILTER_DEEP_LINKS[id]; filterCloudOpen.value = true; return }
    if (EVAL_SECTIONS[id]) { openQuality(EVAL_SECTIONS[id]); return }
    // 3D view presets: 'view-preset-top' → setView('top').
    if (id.startsWith('view-preset-')) { viewerRef.value?.setView(id.slice('view-preset-'.length)); return }
    // Measure groups: 'measure-length' → the ruler of the viewer in front (a raster
    // tab, or the 2D map), etc. The map also picks which raster it measures.
    if (id.startsWith('measure-target:')) { setMapMeasureTarget(id.slice('measure-target:'.length)); return }
    if (id.startsWith('map-basemap:')) { setMapBasemap(id.slice('map-basemap:'.length)); return }
    // DEM of difference: the DEM's Volume tool with a reference DEM as the base.
    if (id === 'dem-difference') {
      openProductTab?.('dem')
      // The tab's viewer mounts asynchronously; wait for it (≤ 2 s) before starting.
      let tries = 0
      const start = () => {
        const v = activeProductViewer()
        if (v?.setMeasureTool) v.setMeasureTool('volume', { base: 'reference' })
        else if (++tries < 40) setTimeout(start, 50)
      }
      nextTick(start)
      return
    }
    // Measure in 3D: the 3D view's own tool (before the raster measure-* prefix).
    if (id === 'measure-3d') { activateTab('viewer'); viewerRef.value?.toggleMeasureTool('distance'); return }
    const measureHost = activeView.value === 'map' ? mapViewerRef.value : activeProductViewer()
    if (id === 'measure-saved') { measureHost?.toggleSavedMeasurements(); return }
    if (id.startsWith('measure-')) { measureHost?.setMeasureTool(id.slice('measure-'.length)); return }

    switch (id) {
      case 'import-images':        pickFiles(FILE_PICKERS.images, onRibbonPick); break
      case 'import-video':         pickFiles(FILE_PICKERS.video, onVideoPick); break
      case 'import-gcps':          pickFiles(FILE_PICKERS.gcps, onGcpPick); break
      case 'import-camera-list':   cameraPickMode.value = 'pose';   pickFiles(FILE_PICKERS.cameras, onCameraPick); break
      case 'import-calib':         cameraPickMode.value = 'sensor'; pickFiles(FILE_PICKERS.cameras, onCameraPick); break
      case 'import-image-fiducials':  pickFiles(FILE_PICKERS.imageFiducials, onFiducialObsPick); break
      case 'import-camera-fiducials': pickFiles(FILE_PICKERS.cameraFiducials, onFiducialMarksPick); break
      case 'import-colmap':        sfmSourceOpen.value = true; break
      case 'import-cloud':         pickFiles(FILE_PICKERS.cloud, onCloudPick); break
      case 'import-raster':        pickFiles(FILE_PICKERS.raster, onRasterPick); break
      case 'export-cameras':       exportPoses(); break
      case 'export-sensors':       exportSensors(); break
      case 'export-camera-fiducials': exportCameraFiducials(); break
      case 'export-image-fiducials':  exportImageFiducials(); break
      case 'export-cloud':         exportKind.value = 'cloud'; break
      case 'export-mesh':          exportKind.value = 'mesh'; break
      case 'export-model':         exportKind.value = 'model'; break
      case 'export-colmap':        exportKind.value = 'colmap'; break
      case 'export-undistorted':   exportKind.value = 'undistorted'; break
      case 'export-tiles3d':       exportKind.value = 'tiles3d'; break
      case 'export-dem':           exportKind.value = 'dem'; break
      case 'export-ortho':         exportKind.value = 'ortho'; break
      case 'export-keypoints':     exportKeypoints(); break
      case 'export-matches':       exportMatches(); break
      // `value` from a saved-measurements list: { ids, label } exports just its records.
      case 'export-measurements':  openMeasurementExport(value); break
      case 'view-viewer':          activateTab('viewer'); break
      case 'view-map':             activateTab('map'); break
      case 'reset-view':           viewerRef.value?.resetView(); break
      case 'view-toggle-cameras':  showCameras.value = !showCameras.value; break
      case 'view-toggle-grid': showGrid.value = !showGrid.value; break
      case 'view-toggle-legend': showLegend.value = !showLegend.value; break
      case 'map-fit-view':         mapViewerRef.value?.fitView(); break
      case 'map-toggle-grid': showMapGrid.value = !showMapGrid.value; break
      case 'map-toggle-footprints': showFootprints.value = !showFootprints.value; break
      // Tools ▸ Georeferencing ▸ Edit GCPs: the mode of the view in front.
      case 'edit-gcps':
        if (activeView.value === 'map') mapGcpEdit.value = !mapGcpEdit.value
        else handleCommand('img-gcp-edit')
        break
      case 'map-toggle-model-frame': toggleModelFrame(); break
      case 'set-region':           openRegionTool(); break
      case 'orient-model':         openOrientTool(); break
      case 'align-points':         openAlignPairs(); break
      case 'view-point-size':      setPointSize(value); break
      case 'view-camera-scale':    setCameraScale(value); break
      case 'view-select-rect':     chooseSelectTool('rect'); break
      case 'view-select-lasso':    chooseSelectTool('lasso'); break
      case 'img-fit':              if (activeImageTab.value) imageViewerRefs[activeImageTab.value.id]?.fit(); break
      case 'img-zoom-in':          if (activeImageTab.value) imageViewerRefs[activeImageTab.value.id]?.zoomIn(); break
      case 'img-zoom-out':         if (activeImageTab.value) imageViewerRefs[activeImageTab.value.id]?.zoomOut(); break
      case 'detect-fiducials':     openFiducialDetect(); break
      case 'calibrate-fiducials':  openFiducialCalibrate(); break
      case 'open-gcp-table':       gcpTableOpen.value = true; refreshGcpReport(); break
      case 'open-glossary':        glossaryStore.openHome(); break
      case 'open-guide':           guideStore.openHome(); break
      case 'open-project-picker':  projectPickerOpen.value = !projectPickerOpen.value; break
      case 'toggle-console':       consoleOpen.value = !consoleOpen.value; break
      case 'toggle-theme':         cycleTheme(); break
      case 'raster-fit':           activeProductViewer()?.fit(); break
      case 'raster-zoom-in':       activeProductViewer()?.zoomBy(1.4); break
      case 'raster-zoom-out':      activeProductViewer()?.zoomBy(1 / 1.4); break
      case 'raster-style':         if (activeRasterTab.value?.rasterId) rasterStyleId.value = activeRasterTab.value.rasterId; break
      case 'raster-toggle-map': {
        const r = activeRasterTab.value
        if (r?.rasterId) setRasterVisible(r.rasterId, !r.visible)
        else if (r && !r.imported) setProductVisible(r.kind, !r.visible)
        break
      }
      case 'raster-symbology':     if (activeRasterTab.value && !activeRasterTab.value.imported) symbologyProductKind.value = activeRasterTab.value.kind; break
      case 'raster-download':      if (activeRasterTab.value?.rasterId) downloadRasterOriginal(activeRasterTab.value.rasterId); break
      case 'raster-remove': {
        const r = activeRasterTab.value
        if (r?.rasterId) confirmRemoveRaster(r.rasterId)
        else if (r && !r.imported) confirmRemoveProduct(r.kind)
        break
      }
      case 'img-show-info':        if (activeImageTab.value) infoImageId.value = activeImageTab.value.id; break
      case 'img-remove':           if (activeImageTab.value) requestRemoveImages(activeImageTab.value.id); break
      case 'img-toggle-keypoints': {
        // The toggle is global, but the overlay only draws on detected images
        // (showKeypointsFor), so flipping it here reads the preference, not the gate.
        if (activeTab.value?.type === 'image') patchImageView({ showKeypoints: !imageViewPrefs.value.showKeypoints })
        break
      }
      case 'img-toggle-mask': {
        // Mask and depth overlays are mutually exclusive — turning one on clears the other.
        if (activeTab.value?.type === 'image') {
          const on = !imageViewPrefs.value.showMask
          patchImageView({ showMask: on, ...(on ? { showDepth: false } : {}) })
        }
        break
      }
      case 'img-toggle-depth': {
        if (activeTab.value?.type === 'image') {
          const on = !imageViewPrefs.value.showDepth
          patchImageView({ showDepth: on, ...(on ? { showMask: false } : {}) })
        }
        break
      }
      case 'img-toggle-gcps': {
        if (activeTab.value?.type === 'image') patchImageView({ showGcps: !imageViewPrefs.value.showGcps })
        break
      }
      case 'img-toggle-residuals': {
        if (activeTab.value?.type === 'image') patchImageView({ showResiduals: !imageViewPrefs.value.showResiduals })
        break
      }
      case 'img-toggle-fiducials': {
        if (activeTab.value?.type === 'image') patchImageView({ showFiducials: !imageViewPrefs.value.showFiducials })
        break
      }
      case 'img-mask-edit': {
        if (activeTab.value?.type === 'image') {
          const on = !imageViewPrefs.value.maskEdit
          // Mask-edit mode always renders the mask overlay itself (ViewerImage keys
          // it on `showMask || maskEdit`), so don't touch the user's showMask toggle
          // here — just make sure depth (mutually exclusive) is off while editing.
          patchImageView({ maskEdit: on, ...(on ? { showDepth: false, gcpEdit: false } : {}) })
        }
        break
      }
      case 'img-gcp-edit': {
        if (activeTab.value?.type === 'image') {
          const on = !imageViewPrefs.value.gcpEdit
          // GCP-edit needs the markers visible and is mutually exclusive with mask
          // editing; leave depth alone (GCPs draw over it fine).
          patchImageView({ gcpEdit: on, ...(on ? { showGcps: true, maskEdit: false } : {}) })
        }
        break
      }
    }
  }


  function onRibbonPick(event) {
    const files = [...event.target.files].filter((f) => f.type.startsWith('image/'))
    // Same georeference fork as the drop path: a picked GeoTIFF DEM is reference
    // data, not a source photo, and it arrives here as `image/tiff`.
    if (files.length) addImagesRouted(files)
    event.target.value = ''
  }

  return { handleCommand, pickSfmFiles, pickSfmFolder, pickProjectFile }
}
