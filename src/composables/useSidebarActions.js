import { nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import { useExternalStore } from '../stores/useExternalStore.js'
import { useFootprintsStore } from '../stores/useFootprintsStore.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useModalsStore } from '../stores/useModalsStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'

// The sidebar's context (components/layout/sidebar/sidebarContext.js), lifted out of
// App.vue: what each row action does, plus the App-level state the sections show.
// Most actions are the confirm-first removals, tab opens and exports App already
// composes; the few that only the sidebar needs (rename an image and its match
// tabs, the image-group ops, bringing a cloud / image / layer into view) live here.
//
// Injected: `tabs` (useTabs), `viewers` (the 3D / map viewer refs), `state` (App-level
// state the sections read), `actions` (handlers from the other composables).
export function useSidebarActions({ tabs, viewers, state, actions }) {
  const { tabs: tabList, activateTab, openImageTab, setTabTitle } = tabs
  const { viewerRef, mapViewerRef } = viewers
  const {
    addImagesRouted,
    openDroppedImport,
    confirmClearKeypoints,
    requestRemoveImages,
    downloadImageOriginal,
    convertImageToRaster,
    confirmRemoveSensor,
    confirmRemoveMatches,
    exportMatches,
    confirmRemoveGcp,
    selectGcp,
    jumpToImage,
    openGcpView,
    confirmRemoveShapefile,
    downloadShapefile,
    confirmRemoveCloud,
    openCloudExport,
    openComputedProductTab,
    confirmRemoveProduct,
    renameProductFromSidebar,
    exportKind,
    openRasterTab,
    confirmRemoveRaster,
    downloadRasterOriginal,
    renameRasterFromSidebar,
    onRasterImportAsImage,
  } = actions
  const imagesStore = useImagesStore()
  const { imageById, selectImage, renameImage } = imagesStore
  const { imageCount: sensorImageCount, mergeSensors } = useSensorsStore()
  const { selectCloud, setCloudVisible, renameCloud, setMainSparse, setProductVisible, setProductOpacity } =
    useReconstructionStore()
  const footprintsStore = useFootprintsStore()
  const { sets: shapefiles } = storeToRefs(footprintsStore)
  const { renameSet, setSetVisible } = footprintsStore
  const { setRasterKind, setRasterVisible, setRasterOpacity, rasterById } = useExternalStore()
  const {
    infoImageId,
    sensorTableOpen,
    matchListOpen,
    symbologyCloudId,
    symbologyProductKind,
    rasterStyleId,
    importRasterOpen,
    importRasterData,
  } = storeToRefs(useModalsStore())

  function renameImageFromSidebar({ id, name }) {
    if (!renameImage(id, name)) return
    setTabTitle(`img:${id}`, imageById(id).name)
    // Match tabs cache their pair label, so refresh any that mention this image.
    for (const tab of tabList.value) {
      if (tab.type !== 'match' || (tab.imageIdA !== id && tab.imageIdB !== id)) continue
      const nameA = imageById(tab.imageIdA)?.name ?? tab.imageIdA
      const nameB = imageById(tab.imageIdB)?.name ?? tab.imageIdB
      tab.title = `${nameA.replace(/\.[^.]+$/, '')} ↔ ${nameB.replace(/\.[^.]+$/, '')}`
    }
  }

  // Sidebar image-group edits (ImagesSection's 'image-group' event). Display-only:
  // nothing here touches tabs or any pipeline state.
  function onImageGroupAction(a) {
    switch (a.op) {
      case 'create':
        imagesStore.createImageGroup({ id: a.id, imageIds: a.imageIds })
        break
      case 'rename':
        imagesStore.renameImageGroup(a.id, a.name)
        break
      case 'remove':
        imagesStore.removeImageGroup(a.id)
        break
      case 'assign':
        imagesStore.setImagesGroup(a.imageIds, a.groupId)
        break
      case 'collapse':
        imagesStore.setImageGroupCollapsed(a.id, a.collapsed)
        break
      case 'move':
        imagesStore.moveImageGroup(a.id, a.delta)
        break
    }
  }

  // Clouds ▸ right-click ▸ Symbology…: the cloud comes forward in the 3D view.
  function openCloudSymbology(id) {
    selectCloud(id)
    activateTab('viewer')
    symbologyCloudId.value = id
  }

  // Selection chooses the active layer without hiding the others.
  function showCloud(id) {
    selectCloud(id)
    activateTab('viewer')
  }

  // Context-menu "Zoom to": show the cloud in the 3D viewer and re-frame the camera
  // on it (resetView frames the freshly-loaded bounding sphere).
  function zoomToCloud(id) {
    selectCloud(id)
    activateTab('viewer')
    setCloudVisible(id, true)
    nextTick(() => viewerRef.value?.zoomToCloud(id))
  }

  // Switch to the map and centre it on an image's position (pose or EXIF GPS).
  function zoomToImagePosition(imgId) {
    activateTab('map')
    nextTick(() => mapViewerRef.value?.zoomToImage(imgId))
  }

  // Switch to the map and fit the view to a shapefile set's extent.
  function zoomToShapefile(id) {
    const set = shapefiles.value.find((s) => s.id === id)
    if (!set) return
    activateTab('map')
    nextTick(() => mapViewerRef.value?.zoomToFootprints(set.footprints))
  }

  const context = {
    ...state,
    sensorImageCount,
    // Drops
    addImages: addImagesRouted,
    importFile: openDroppedImport,
    // Images
    selectImage,
    openImage: (id) => openImageTab(id),
    showInfo: (id) => {
      infoImageId.value = id
    },
    zoomToImage: zoomToImagePosition,
    deleteKeypoints: confirmClearKeypoints,
    removeImage: requestRemoveImages,
    renameImage: renameImageFromSidebar,
    downloadImage: downloadImageOriginal,
    convertImageToRaster,
    imageGroup: onImageGroupAction,
    // Sensors
    removeSensor: confirmRemoveSensor,
    mergeSensors: ({ target, source }) => mergeSensors(target, source),
    openSensor: () => {
      sensorTableOpen.value = true
    },
    // Matches
    openMatches: () => {
      matchListOpen.value = true
    },
    removeMatches: confirmRemoveMatches,
    downloadMatches: exportMatches,
    // GCPs
    removeGcp: confirmRemoveGcp,
    selectGcp,
    jumpToImage,
    openGcp: openGcpView,
    // Shapefiles
    removeShapefile: confirmRemoveShapefile,
    renameShapefile: ({ id, name }) => renameSet(id, name),
    setShapefileVisible: ({ id, visible }) => setSetVisible(id, visible),
    zoomToShapefile,
    downloadShapefile,
    // Clouds (Reconstruction, Products and Reference rows)
    selectCloud: showCloud,
    cloudSymbology: openCloudSymbology,
    cloudVisibility: ({ id, visible }) => setCloudVisible(id, visible),
    removeCloud: confirmRemoveCloud,
    renameCloud: ({ id, name }) => renameCloud(id, name),
    setMainCloud: setMainSparse,
    zoomToCloud,
    downloadCloud: openCloudExport,
    // Computed products
    openProduct: openComputedProductTab,
    removeProduct: confirmRemoveProduct,
    renameProduct: renameProductFromSidebar,
    setProductVisible: ({ kind, visible }) => setProductVisible(kind, visible),
    setProductOpacity: ({ kind, opacity }) => setProductOpacity(kind, opacity),
    productSymbology: (kind) => {
      symbologyProductKind.value = kind
    },
    downloadProduct: (kind) => {
      exportKind.value = kind
    },
    // Reference rasters
    openRaster: openRasterTab,
    removeRaster: confirmRemoveRaster,
    downloadRaster: downloadRasterOriginal,
    renameRaster: renameRasterFromSidebar,
    setRasterKind: ({ id, kind }) => setRasterKind(id, kind),
    styleRaster: (id) => {
      rasterStyleId.value = id
    },
    rasterAccuracy: (id) => {
      const raster = rasterById(id)
      if (!raster) return
      importRasterData.value = { raster, fileName: raster.name, mode: 'accuracy' }
      importRasterOpen.value = true
    },
    setRasterVisible: ({ id, visible }) => setRasterVisible(id, visible),
    setRasterOpacity: ({ id, opacity }) => setRasterOpacity(id, opacity),
    convertRasterToImage: (id) => onRasterImportAsImage({ id }),
  }

  return { context, zoomToShapefile }
}
