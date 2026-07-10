import { ref } from 'vue'
import { buildPosesCsv, buildSensorsCsv, downloadCsv } from '../utils/exportCsv.js'
import { cloudToPly, reconstructionToJson, demToAsciiGrid, demToGeoTiff, orthoToGeoTiff, rasterWorldFile } from '../core/products/exporters.js'
import { buildColmapModel, serializeColmapModel } from '../core/io/colmapModel.js'
import { distortionOf } from '../core/sfm/distortion.js'
import { downloadBlob, dataUrlToBlob } from '../utils/download.js'
import { zipStore } from '../utils/zip.js'

// Camera-params + product export funnel, lifted out of App.vue. Owns `exportKind`
// (which export dialog is open); the Ribbon command dispatch sets it and the
// template's ExportModal binds to it. The reactive state it reads is injected as
// refs so the composable stays free of store wiring. Injected deps (all refs):
//   poses, sensors, images, matchStore, clouds, selectedCloud, mainSparseCloud,
//   dem, ortho, currentProjectName, currentCrs
export function useExports({
  poses, sensors, images, matchStore, clouds, selectedCloud, mainSparseCloud, dem, ortho,
  currentProjectName, currentCrs,
}) {
  function exportPoses() {
    if (!poses.value.length) return
    downloadCsv(`${currentProjectName.value || 'project'}-poses.csv`, buildPosesCsv(poses.value, currentCrs.value))
  }

  function exportSensors() {
    if (!sensors.value.length) return
    downloadCsv(`${currentProjectName.value || 'project'}-sensors.csv`, buildSensorsCsv(sensors.value))
  }

  function saveJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  function exportKeypoints() {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    const data = images.value
      .filter(img => img.kpStatus === 'done' && img.keypoints?.length)
      .map(img => ({
        image: img.name,
        uuid: img.uuid,
        kpCount: img.kpCount,
        keypoints: img.keypoints.map(kp => ({ x: kp.x, y: kp.y, scale: kp.scale, response: kp.response })),
      }))
    saveJson(data, `keypoints-${stamp}.json`)
  }

  function exportMatches() {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    const byUuid = Object.fromEntries(images.value.map(img => [img.uuid, img.name]))
    const data = []
    for (const [, entry] of matchStore.value) {
      if (entry.status !== 'done') continue
      data.push({
        imageA: byUuid[entry.idA] ?? entry.idA,
        imageB: byUuid[entry.idB] ?? entry.idB,
        rawCount: entry.rawCount,
        inlierCount: entry.inlierCount,
        matches: entry.matches,
      })
    }
    saveJson(data, `matches-${stamp}.json`)
  }

  const projectBase = () => currentProjectName.value || 'project'

  // Which export dialog is open ('cloud' | 'model' | 'colmap' | 'dem' | 'ortho'), or null.
  const exportKind = ref(null)

  // Parse the current DEM's CRS into an EPSG code + geographic flag for GeoTIFF /
  // .prj. The working CRS is a proj4 string or "EPSG:xxxx"; only the latter yields a
  // code (else the geotransform is still written, without a CRS).
  function crsInfo(source) {
    const crs = source?.crs
    if (!crs || crs === 'local') return { crs: null, code: null, geographic: false }
    const m = /EPSG:(\d+)/i.exec(crs)
    const code = m ? Number(m[1]) : null
    const geographic = code === 4326 || /degree|deg\b/i.test(source.unit || '')
    return { crs, code, geographic }
  }

  function onExportRun(settings) {
    const kind = exportKind.value
    exportKind.value = null
    if (kind === 'cloud') doExportCloud(settings)
    else if (kind === 'model') doExportModel(settings)
    else if (kind === 'colmap') doExportColmap(settings)
    else if (kind === 'dem') doExportDem(settings)
    else if (kind === 'ortho') doExportOrtho(settings)
  }

  // The main sparse cloud (what downstream stages consume — MC), or the selected
  // cloud if it carries cameras. Shared by the two model exporters.
  function sparseCloud() {
    return mainSparseCloud.value
      ?? (selectedCloud.value?.cameras?.size ? selectedCloud.value : null)
  }

  // Point cloud (selected, else the first non-empty) → PLY.
  function doExportCloud({ format, includeColor }) {
    const cloud = selectedCloud.value?.points?.length
      ? selectedCloud.value
      : clouds.value.find((c) => c.points.length > 0)
    if (!cloud) return
    const binary = format !== 'ply-ascii'
    const ply = cloudToPly(cloud.points, { binary, color: includeColor })
    downloadBlob(`${projectBase()}-${cloud.kind}.ply`, ply, binary ? 'application/octet-stream' : 'text/plain;charset=utf-8')
  }

  // SfM cameras (+ optional tracks) → JSON interchange (uses the sparse cloud).
  function doExportModel({ includeTracks }) {
    const cloud = sparseCloud()
    if (!cloud) return
    const cams = [...cloud.cameras.entries()].map(([uuid, c]) => ({ uuid, R: c.R, t: c.t, K: c.K }))
    const pts = cloud.points.map((p) => ({
      x: p.x, y: p.y, z: p.z, color: p.color,
      views: includeTracks && p.views ? [...p.views.entries()] : [],
    }))
    saveJson(reconstructionToJson(cams, pts, currentCrs.value), `${projectBase()}-model.json`)
  }

  // Sparse model → COLMAP text model (cameras/images/points3D.txt) zipped into
  // one download. One PINHOLE camera per image. The exported K/R/t are in the
  // BA (pinhole) frame, so the 2D observations MUST be too: prefer the cloud's
  // `viewsPx` (uuid→[x,y] BA-frame pixels the SfM run baked in — undistorted /
  // fiducial-canonical / self-cal-folded), and fall back to the store keypoints
  // only when it's absent (pure pinhole with no self-cal, where the two frames are
  // identical, or a legacy cloud persisted before viewsPx existed — which we warn
  // about, since a distorted/film/self-cal project would export inconsistently).
  // Only cameras with a matching loaded image + resolved K are exported (COLMAP
  // needs width/height/name). Output is in the local SfM frame.
  function doExportColmap() {
    const cloud = sparseCloud()
    if (!cloud) return
    const imgByUuid = new Map(images.value.map((im) => [im.uuid, im]))

    const exportImages = [...cloud.cameras.entries()]
      .map(([uuid, cam]) => {
        const im = imgByUuid.get(uuid)
        if (!im || !cam.K || !im.meta?.width || !im.meta?.height) return null
        return { uuid, name: im.name, width: im.meta.width, height: im.meta.height, K: cam.K, R: cam.R, t: cam.t }
      })
      .filter(Boolean)
    if (!exportImages.length) return
    const exported = new Set(exportImages.map((im) => im.uuid))

    // Warn if we're about to fall back to raw store keypoints for a project whose BA
    // frame differs from scan/distorted space (distortion, film, or self-cal) but no
    // viewsPx is present — those observations won't match the exported cameras.
    const anyViewsPx = cloud.points.some((p) => p.viewsPx && p.viewsPx.size)
    if (!anyViewsPx) {
      const risky = exportImages.some(({ uuid }) => {
        const im = imgByUuid.get(uuid)
        return im?.sensor?.kind === 'film' || !!distortionOf(im?.sensor)
      })
      if (risky) {
        console.warn('[COLMAP export] No BA-frame pixels (viewsPx) available and this project '
          + 'uses lens distortion or film scans — 2D observations may not match the exported '
          + 'cameras. Re-run reconstruction to regenerate the model with coherent observations.')
      }
    }

    const points = cloud.points.map((p) => ({
      xyz: [p.x, p.y, p.z],
      color: p.color,
      views: p.views
        ? [...p.views.entries()]
            .map(([uuid, kpIdx]) => {
              if (!exported.has(uuid)) return null
              const px = p.viewsPx?.get(uuid)
              if (px) return { uuid, x: px[0], y: px[1] }
              const kp = imgByUuid.get(uuid)?.keypoints?.[kpIdx]
              return kp ? { uuid, x: kp.x, y: kp.y } : null
            })
            .filter(Boolean)
        : [],
    }))

    const files = serializeColmapModel(buildColmapModel({ images: exportImages, points }))
    const entries = Object.entries(files).map(([name, text]) => ({ name, data: new TextEncoder().encode(text) }))
    downloadBlob(`${projectBase()}-colmap.zip`, zipStore(entries), 'application/zip')
  }

  // DEM → GeoTIFF, or ESRI ASCII grid (+ .prj sidecar carrying the CRS).
  function doExportDem({ format, nodata }) {
    if (!dem.value) return
    const info = crsInfo(dem.value)
    if (format === 'geotiff') {
      downloadBlob(`${projectBase()}-dem.tif`, demToGeoTiff(dem.value, { crs: info, nodata }), 'image/tiff')
      return
    }
    downloadBlob(`${projectBase()}-dem.asc`, demToAsciiGrid(dem.value, { nodata }), 'text/plain;charset=utf-8')
    if (info.crs) downloadBlob(`${projectBase()}-dem.prj`, info.crs, 'text/plain;charset=utf-8')
  }

  // Ortho → GeoTIFF, or PNG + world file (.wld) + .prj. Shares the DEM's geotransform.
  async function doExportOrtho({ format }) {
    if (!ortho.value || !dem.value) return
    const info = crsInfo(dem.value)
    if (format === 'geotiff') {
      downloadBlob(`${projectBase()}-ortho.tif`, orthoToGeoTiff(ortho.value, dem.value, { crs: info }), 'image/tiff')
      return
    }
    if (!ortho.value.previewDataUrl) return
    downloadBlob(`${projectBase()}-ortho.png`, await dataUrlToBlob(ortho.value.previewDataUrl))
    downloadBlob(`${projectBase()}-ortho.wld`, rasterWorldFile(dem.value), 'text/plain;charset=utf-8')
    if (info.crs) downloadBlob(`${projectBase()}-ortho.prj`, info.crs, 'text/plain;charset=utf-8')
  }

  return { exportKind, exportPoses, exportSensors, exportKeypoints, exportMatches, onExportRun }
}
