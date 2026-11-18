import { ref, computed, watch } from 'vue'
import { createRasterExports } from './exports/rasters.js'
import { createSfmProjectExports } from './exports/sfmProject.js'
import { createMetashapeExport } from './exports/metashape.js'
import { createCloudExports } from './exports/clouds.js'
import { createTabularExports } from './exports/tabular.js'
import { createMeasurementExports } from './exports/measurements.js'
import { crsTagInfo } from '../core/products/geotiff.js'
import { useLog } from './useLog.js'
import { downloadBlob } from '../utils/download.js'
import { showToast } from './useToasts.js'
import * as opfs from '../utils/opfs.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useMatchesStore } from '../stores/useMatchesStore.js'
import { useExternalStore } from '../stores/useExternalStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useFootprintsStore } from '../stores/useFootprintsStore.js'
import { useGcpsStore } from '../stores/useGcpsStore.js'
import { useScaleBarsStore } from '../stores/useScaleBarsStore.js'
import { storeToRefs } from 'pinia'
import { polygonSetToGeoJson } from '../core/io/geojson.js'
import { vectorSetToKml } from '../core/io/kml.js'
import { ensureProjection, transform } from '../core/crs.js'
import { similarityForExport } from '../core/products/exportFrame.js'
import { pluralize } from '../core/textFormat.js'
import { fileSafe, exportFileName } from '../core/exportNames.js'
import { georefFrameOf } from '../core/products/frameSpec.js'
import { photoGridBuilder } from '../core/products/photoGrid.js'
import { annotationPage, georeferenceAnnotation, iiifImageUri } from '../core/io/allmaps.js'
import { PHOTO_GRID_TUNING } from '../core/tuning.js'

// Camera-params + product export funnel, lifted out of App.vue. Owns `exportKind`
// (which export dialog is open); the Ribbon command dispatch sets it and the
// template's ExportModal binds to it. The exporters themselves live in exports/
// (tabular, clouds, sfmProject, rasters); this keeps the dialog state, the run
// dispatch and the "download the original" actions. The reactive state it reads is injected as
// refs so the composable stays free of store wiring. Injected deps (all refs):
//   poses, sensors, images, matchStore, clouds, selectedCloud, mainSparseCloud,
//   dem, ortho, georef, currentProjectName, currentCrs, summary
// plus `effectiveFrameSpec` — THE unit resolver (useReconstructionStore). Export
// must not decide independently what a coordinate means.
// plus `progress` — usePipeline's progress handle, for the one export (undistorted
// images) that is minutes of work rather than a serialization.
export function useExports({
  poses,
  sensors,
  images,
  matchStore,
  clouds,
  selectedCloud,
  mainSparseCloud,
  dem,
  ortho,
  georef,
  currentProjectName,
  currentCrs,
  summary,
  progress,
  effectiveFrameSpec,
}) {
  const { log } = useLog()
  const projects = useProjectsStore()
  // Keypoints and matches are read from disk on demand (TODO ▸ SC-2/SC-3).
  const imagesStore = useImagesStore()
  const matchesStore = useMatchesStore()
  const external = useExternalStore()
  const recon = useReconstructionStore()
  const footprints = useFootprintsStore()

  // File naming, shared by every exporter.
  const projectBase = () => currentProjectName.value || 'project'
  // A cloud's own name in its file name, so two exported clouds never collide.
  // "Imported (south.laz)" → "Imported_south": the source extension would read as
  // the export's format (core/exportNames.js fileSafe).
  const cloudFileBase = (cloud, target) =>
    target && fileSafe(cloud.name) ? `${projectBase()}-${fileSafe(cloud.name)}` : `${projectBase()}-${cloud.kind}`
  // Parse the current DEM's CRS into an EPSG code + geographic flag for GeoTIFF /
  // .prj. The working CRS is a proj4 string or "EPSG:xxxx"; only the latter yields a
  // code (else the geotransform is still written, without a CRS).
  const crsInfo = crsTagInfo

  // The similarity a cloud/mesh/measurement export applies, from THE resolver
  // (core/products/exportFrame.js holds the rule).
  async function exportSimilarity() {
    return similarityForExport(await effectiveFrameSpec?.())
  }
  // Poses, calibration, fiducials, keypoints, matches (exports/tabular.js).
  const {
    doExportPoses,
    doExportSensors,
    doExportCameraFiducials,
    doExportImageFiducials,
    saveJson,
    doExportKeypoints,
    doExportMatches,
    swapPairs,
  } = createTabularExports({
    currentCrs,
    exportSimilarity,
    images,
    imagesStore,
    log,
    matchStore,
    matchesStore,
    poses,
    projectBase,
    sensors,
    sparseCloud: () => mainSparseCloud.value,
    summary,
  })

  // Which export dialog is open ('cloud' | 'model' | 'colmap' | 'undistorted' | 'dem' |
  // 'ortho' | 'measurements' | 'poses' | 'sensors' | 'vectors' …), or null.
  const exportKind = ref(null)
  // The cloud a sidebar "Download…" opened the dialog for (its id), or null for the
  // ribbon's "the selected cloud, else the first"; for 'vectors', the layer's id.
  // Cleared whenever the dialog closes, so a later ribbon export never inherits it.
  const exportTarget = ref(null)
  watch(exportKind, (kind) => {
    if (!kind) exportTarget.value = null
  })
  const exportTargetCloud = computed(() => clouds.value.find((c) => c.id === exportTarget.value) ?? null)
  // For 'dem' / 'ortho': the product a sidebar Download… (or its tab's Export) opened
  // the dialog for; null for the ribbon's, which exports the main one.
  const exportTargetProduct = computed(() =>
    exportKind.value === 'dem' || exportKind.value === 'ortho'
      ? (recon.rasterProducts.find((p) => p.id === exportTarget.value) ?? null)
      : null,
  )
  const exportTargetVectorSet = computed(() =>
    exportKind.value === 'vectors' ? (footprints.sets.find((s) => s.id === exportTarget.value) ?? null) : null,
  )
  // Export ▸ Measurements from a saved-measurements list: that list's records
  // ({ ids, label }), or null for every saved measurement. Cleared with the dialog too.
  const exportMeasurementScope = ref(null)
  watch(exportKind, (kind) => {
    if (kind !== 'measurements') exportMeasurementScope.value = null
  })
  function openMeasurementExport(scope = null) {
    exportKind.value = 'measurements'
    exportMeasurementScope.value = scope?.ids ? { ids: [...scope.ids], label: scope.label ?? '' } : null
  }

  // Sidebar ▸ right-click ▸ Download… on a cloud or mesh: the same dialog as the
  // ribbon, aimed at that one cloud.
  function openCloudExport(id) {
    const cloud = clouds.value.find((c) => c.id === id)
    if (!cloud) return
    exportKind.value = cloud.kind === 'mesh' ? 'mesh' : 'cloud'
    exportTarget.value = id
  }

  // Sidebar ▸ Download… on a DEM / orthophoto, main or not: its export dialog.
  function openProductExport(id) {
    const product = recon.rasterProducts.find((p) => p.id === id)
    if (!product) return
    exportKind.value = product.kind
    exportTarget.value = id
  }

  // Sidebar ▸ Download… on an imported reference raster: the file as imported.
  async function downloadRasterOriginal(id) {
    const meta = external.rasters.find((r) => r.id === id)
    const file = await external.originalFile(id).catch(() => null)
    if (!file) {
      log(
        `${meta?.name ?? 'Raster'}: the original file is not stored in this project — re-import it to download it`,
        'warn',
        'Export',
      )
      return
    }
    downloadBlob(file.name || meta?.name || 'raster.tif', file)
  }

  // Sidebar ▸ Download original on a source image: the bytes as imported (the OPFS
  // copy is the authority; an in-session image falls back to its blob: URL).
  async function downloadImageOriginal(id) {
    const img = images.value.find((i) => i.id === id)
    if (!img) return
    let blob = await opfs.loadImageBlob(projects.currentProjectId, img.uuid).catch(() => null)
    if (!blob && img.url)
      blob = await fetch(img.url)
        .then((r) => r.blob())
        .catch(() => null)
    if (!blob) {
      log(`${img.name}: the image file is no longer available`, 'warn', 'Export')
      return
    }
    downloadBlob(img.name || `${img.uuid}.jpg`, blob)
  }

  // Download… on a vector layer's sidebar row, and Export ▸ Footprints for the image
  // footprints: the export dialog for that layer.
  function openVectorExport(id) {
    if (!footprints.sets.some((s) => s.id === id)) return
    exportKind.value = 'vectors'
    exportTarget.value = id
  }
  function openFootprintExport() {
    if (footprints.footprintSet) openVectorExport(footprints.footprintSet.id)
  }

  // A vector layer as GeoJSON (project CRS, or WGS 84 with `coords` 'wgs84') or KML
  // (always WGS 84), its polygons or lines as stored.
  async function doExportVectors({ format, coords, fileName }, set) {
    if (!set) return
    const crs = currentCrs.value && currentCrs.value !== 'local' ? currentCrs.value : null
    const wgs84 = crs && (format === 'kml' || coords === 'wgs84')
    if ((format === 'kml' || coords === 'wgs84') && !crs) throw new Error('the project has no CRS to convert from')
    if (wgs84) await ensureProjection(crs)
    const toLonLat = wgs84 ? (c) => transform(c, crs, 'EPSG:4326') : null
    const name = exportFileName(fileName, fileSafe(set.name) || 'polygons')
    if (format === 'kml') {
      downloadBlob(`${name}.kml`, vectorSetToKml(set, { toLonLat }), 'application/vnd.google-earth.kml+xml')
    } else {
      const fc = polygonSetToGeoJson(set, { crs, reproject: toLonLat })
      downloadBlob(`${name}.geojson`, JSON.stringify(fc), 'application/geo+json')
    }
    const noun = set.kind === 'lines' ? 'line' : 'polygon'
    log(
      `Exported ${pluralize(set.footprints.length, noun)} of "${set.name}" as ${format === 'kml' ? 'KML' : 'GeoJSON'}` +
        (wgs84 ? ' in WGS 84' : crs ? ` in ${crs}` : ''),
      'success',
      'Export',
    )
  }

  // Export ▸ Allmaps: each aligned photo as a Georeference Annotation (core/io/allmaps.js),
  // its control points the photo's ground grid in the georeferenced model, the same one
  // the map's Photos layer draws (core/products/photoGrid.js). On the main thread: a
  // grid is ~0.3 ms a photo.
  async function doExportAllmaps({ fileName, iiifTemplate, iiifVersion }) {
    const t0 = performance.now()
    const frame = georefFrameOf(recon.currentFrameSignature)
    const cloud = mainSparseCloud.value
    if (!frame || !cloud?.cameras?.size) throw new Error('the sparse model is not georeferenced')
    const crs = currentCrs.value
    await ensureProjection(crs)
    const toLonLat = (c) => transform(c, crs, 'EPSG:4326')
    const gridFor = photoGridBuilder({
      cameras: cloud.cameras,
      pos: cloud.points?.pos,
      toMap: frame.fromSfm,
      frameModel: recon.frameModelFor,
    })
    const aligned = images.value.filter((img) => img.uuid && cloud.cameras.has(img.uuid))
    log(
      `Allmaps: ${pluralize(aligned.length, 'aligned photo')} of ${images.value.length.toLocaleString('en')}, ` +
        `IIIF images at ${iiifTemplate.trim()} (Image API ${iiifVersion}); control points: each photo's ` +
        `${PHOTO_GRID_TUNING.gridCells + 1} × ${PHOTO_GRID_TUNING.gridCells + 1} rays cast onto the tie points ` +
        `from ${crs}, written in WGS 84, thin plate spline`,
      'info',
      'Export',
    )
    const annotations = []
    const noGrid = []
    for (const img of aligned) {
      const grid = gridFor(img)
      const annotation = grid
        ? georeferenceAnnotation({
            grid,
            width: img.meta.width,
            height: img.meta.height,
            uri: iiifImageUri(iiifTemplate, img.name),
            version: iiifVersion,
            toLonLat,
          })
        : null
      if (annotation) annotations.push(annotation)
      else noGrid.push(img.name)
    }
    if (noGrid.length) {
      log(
        `${pluralize(noGrid.length, 'aligned photo')} left out, with no ground under enough of the photo ` +
          `(a camera below the tie points, a view past the horizon, or no image size): ${noGrid.slice(0, 5).join(', ')}` +
          (noGrid.length > 5 ? ' …' : ''),
        'warn',
        'Export',
      )
    }
    if (!annotations.length) throw new Error('no aligned photo could be placed on the ground')
    const name = `${exportFileName(fileName, `${projectBase()}-allmaps`)}.json`
    downloadBlob(name, JSON.stringify(annotationPage(annotations)), 'application/json')
    // The project keeps the address for its next export.
    recon.setIiifImages({ template: iiifTemplate, version: iiifVersion })
    const skipped = images.value.length - aligned.length
    log(
      `Exported ${pluralize(annotations.length, 'photo')} as Georeference Annotations for Allmaps ("${name}")` +
        (skipped ? `; ${pluralize(skipped, 'photo')} not in the sparse model` : '') +
        ` in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
      'success',
      'Export',
    )
  }

  async function onExportRun(settings) {
    const kind = exportKind.value,
      target = exportTargetCloud.value,
      product = exportTargetProduct.value,
      vectorSet = exportTargetVectorSet.value
    const measurementIds = exportMeasurementScope.value?.ids ?? null
    exportKind.value = null
    try {
      if (kind === 'cloud') await doExportCloud(settings, target)
      else if (kind === 'mesh') await doExportMesh(settings, target)
      else if (kind === 'model') await doExportModel(settings)
      else if (kind === 'colmap') await doExportColmap(settings)
      else if (kind === 'undistorted') await doExportUndistorted(settings)
      else if (kind === 'tiles3d') await doExportTiles3d(settings)
      else if (kind === 'dem') await doExportDem(settings, product)
      else if (kind === 'ortho') await doExportOrtho(settings, product)
      else if (kind === 'measurements') await doExportMeasurements({ ...settings, ids: measurementIds })
      else if (kind === 'poses') await doExportPoses(settings)
      else if (kind === 'sensors') doExportSensors(settings)
      else if (kind === 'cameraFiducials') doExportCameraFiducials(settings)
      else if (kind === 'imageFiducials') doExportImageFiducials(settings)
      else if (kind === 'keypoints') await doExportKeypoints(settings)
      else if (kind === 'matches') await doExportMatches(settings)
      else if (kind === 'vectors') await doExportVectors(settings, vectorSet)
      else if (kind === 'allmaps') await doExportAllmaps(settings)
    } catch (err) {
      const detail = String(err?.message ?? err)
      log(`Export failed: ${detail}`, 'error', 'Export')
      showToast('Export failed', { detail, kind: 'error', ms: 6000 })
    }
  }

  // Clouds, meshes, the model JSON and 3D Tiles (exports/clouds.js).
  const { sparseCloud, doExportCloud, doExportMesh, doExportModel, doExportTiles3d, cloudExportBase } =
    createCloudExports({
      cloudFileBase,
      clouds,
      currentCrs,
      effectiveFrameSpec,
      exportSimilarity,
      images,
      log,
      mainSparseCloud,
      projectBase,
      saveJson,
      selectedCloud,
      sensors,
      summary,
    })

  // COLMAP / interchange projects and undistorted images (exports/sfmProject.js).
  const { doExportMetashape } = createMetashapeExport({
    currentCrs,
    images,
    sensors,
    sparseCloud,
    summary,
    gcps: storeToRefs(useGcpsStore()).gcps,
    scaleBars: storeToRefs(useScaleBarsStore()).bars,
    effectiveFrameSpec,
    log,
    projectBase,
  })
  const { doExportColmap, doExportUndistorted } = createSfmProjectExports({
    doExportModel,
    doExportMetashape,
    images,
    imagesStore,
    log,
    matchStore,
    matchesStore,
    progress,
    projectBase,
    projects,
    saveJson,
    sensors,
    sparseCloud,
    summary,
    swapPairs,
  })

  // DEM / orthophoto files and the Products ▾ derivatives (exports/rasters.js).
  const { doExportDem, doExportOrtho, exportContours, exportTerrain, exportClipped } = createRasterExports({
    addLineSet: footprints.addLineSet,
    crsInfo,
    dem,
    log,
    ortho,
    projectBase,
  })

  // Saved measurements as CSV / GeoJSON (exports/measurements.js).
  const { doExportMeasurements, exportCrsFor: measurementExportCrs } = createMeasurementExports({
    currentCrs,
    effectiveFrameSpec,
    exportSimilarity,
    log,
    projectBase,
  })

  // What the open export dialog's names start from (core/exportNames.js
  // defaultExportName): the cloud's or mesh's own export name, else the project's.
  const exportNameBase = computed(() => {
    const kind = exportKind.value
    if (kind === 'cloud' || kind === 'mesh') return cloudExportBase(kind, exportTargetCloud.value)
    if (kind === 'vectors') return fileSafe(exportTargetVectorSet.value?.name) || 'polygons'
    return projectBase()
  })

  return {
    exportKind,
    exportNameBase,
    exportTargetCloud,
    exportTargetProduct,
    exportTargetVectorSet,
    exportMeasurementScope,
    openMeasurementExport,
    measurementExportCrs,
    onExportRun,
    openCloudExport,
    openProductExport,
    downloadRasterOriginal,
    downloadImageOriginal,
    openVectorExport,
    openFootprintExport,
    exportContours,
    exportTerrain,
    exportClipped,
  }
}
