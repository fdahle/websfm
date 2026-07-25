import { ref } from 'vue'
import { buildPosesCsv, buildSensorsCsv, downloadCsv } from '../utils/exportCsv.js'
import { cloudToPly, meshToPly, meshToGlb, meshToObj, meshToStl, reconstructionToJson, demToAsciiGrid, demToGeoTiff, orthoToGeoTiff, rasterWorldFile, prepareCloudForExport } from '../core/products/exporters.js'
import { cloudToLas } from '../core/io/las.js'
import { cloudToXyz } from '../core/io/cloudText.js'
import { buildColmapModel, serializeColmapModel, serializeColmapModelBin } from '../core/io/colmapModel.js'
import { buildTransformsJson } from '../core/io/transforms.js'
import { epsgToWkt } from '../core/products/wkt.js'
import { useLog } from './useLog.js'
import { distortionOf } from '../core/sfm/distortion.js'
import { downloadBlob, dataUrlToBlob } from '../utils/download.js'
import { zipStore } from '../utils/zip.js'
import { showToast } from './useToasts.js'

// Camera-params + product export funnel, lifted out of App.vue. Owns `exportKind`
// (which export dialog is open); the Ribbon command dispatch sets it and the
// template's ExportModal binds to it. The reactive state it reads is injected as
// refs so the composable stays free of store wiring. Injected deps (all refs):
//   poses, sensors, images, matchStore, clouds, selectedCloud, mainSparseCloud,
//   dem, ortho, georef, currentProjectName, currentCrs
export function useExports({
  poses, sensors, images, matchStore, clouds, selectedCloud, mainSparseCloud, dem, ortho,
  georef, currentProjectName, currentCrs,
}) {
  const { log } = useLog()
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
    setTimeout(() => URL.revokeObjectURL(url), 1000)
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

  async function onExportRun(settings) {
    const kind = exportKind.value
    exportKind.value = null
    try {
      if (kind === 'cloud') await doExportCloud(settings)
      else if (kind === 'mesh') await doExportMesh(settings)
      else if (kind === 'model') await doExportModel(settings)
      else if (kind === 'colmap') await doExportColmap(settings)
      else if (kind === 'dem') await doExportDem(settings)
      else if (kind === 'ortho') await doExportOrtho(settings)
    } catch (err) {
      const detail = String(err?.message ?? err)
      log(`Export failed: ${detail}`, 'error', 'Export')
      showToast('Export failed', { detail, kind: 'error', ms: 6000 })
    }
  }

  // The main sparse cloud (what downstream stages consume — MC), or the selected
  // cloud if it carries cameras. Shared by the two model exporters.
  function sparseCloud() {
    return mainSparseCloud.value
      ?? (selectedCloud.value?.cameras?.size ? selectedCloud.value : null)
  }

  // Point cloud (selected, else the first non-empty) → PLY / LAS / XYZ, with an
  // optional georeference transform (the stored Horn fit → project CRS) and an
  // optional voxel downsample (cell in target-frame units, applied after georef).
  const cloudHasPoints = (c) => c && (c.kind === 'dense' ? c.count > 0 : c.points?.length > 0)
  function doExportCloud({ format, includeColor, applyGeoref, downsampleCell }) {
    const cloud = cloudHasPoints(selectedCloud.value)
      ? selectedCloud.value
      : clouds.value.find(cloudHasPoints)
    if (!cloud) return
    // cloudToPly/Las/Xyz all accept either the sparse point-object array or the
    // dense flat shape; prepareCloudForExport normalizes when georef/downsample apply.
    const raw = cloud.kind === 'dense'
      ? { count: cloud.count, pos: cloud.pos, col: cloud.col, nrm: cloud.nrm }
      : cloud.points
    const g = applyGeoref ? georef?.value : null
    const src = prepareCloudForExport(raw, {
      sim: g?.sim ?? null,
      cell: downsampleCell > 0 ? downsampleCell : 0,
      onLog: log,
    })
    if (g) log(`Cloud export: georeferenced to ${g.crs}`, 'info', 'Export')
    const base = `${projectBase()}-${cloud.kind}`
    if (format === 'las') {
      const m = g ? /EPSG:(\d+)/i.exec(g.crs) : null
      const las = cloudToLas(src, {
        crsCode: m ? Number(m[1]) : null,
        geographic: m ? Number(m[1]) === 4326 : false,
        onLog: log,
      })
      downloadBlob(`${base}.las`, las, 'application/octet-stream')
    } else if (format === 'xyz') {
      downloadBlob(`${base}.xyz`, cloudToXyz(src, { color: includeColor }), 'text/plain;charset=utf-8')
    } else {
      const binary = format !== 'ply-ascii'
      const ply = cloudToPly(src, { binary, color: includeColor })
      downloadBlob(`${base}.ply`, ply, binary ? 'application/octet-stream' : 'text/plain;charset=utf-8')
    }
  }

  // Mesh (screened Poisson) → PLY (faces) or GLB. Uses the selected mesh cloud, else
  // the first mesh cloud.
  function doExportMesh({ format, includeColor }) {
    const cloud = selectedCloud.value?.kind === 'mesh'
      ? selectedCloud.value
      : clouds.value.find((c) => c.kind === 'mesh' && c.count > 0)
    if (!cloud) return
    const mesh = { nVerts: cloud.nVerts, count: cloud.count, pos: cloud.pos, idx: cloud.idx, col: cloud.col }
    if (format === 'glb') {
      downloadBlob(`${projectBase()}-mesh.glb`, meshToGlb(mesh, { color: includeColor }), 'model/gltf-binary')
    } else if (format === 'obj') {
      downloadBlob(`${projectBase()}-mesh.obj`, meshToObj(mesh, { color: includeColor }), 'text/plain;charset=utf-8')
    } else if (format === 'stl') {
      downloadBlob(`${projectBase()}-mesh.stl`, meshToStl(mesh), 'model/stl')
    } else {
      const binary = format !== 'ply-ascii'
      const ply = meshToPly(mesh, { binary, color: includeColor })
      downloadBlob(`${projectBase()}-mesh.ply`, ply, binary ? 'application/octet-stream' : 'text/plain;charset=utf-8')
    }
  }

  // SfM cameras → websfm JSON (cameras + optional tracks), or a NeRF/3DGS
  // transforms.json (camera-to-world OpenGL poses + intrinsics). Both use the
  // sparse cloud; transforms.json needs each camera's loaded image (width/height).
  function doExportModel({ format, includeTracks }) {
    const cloud = sparseCloud()
    if (!cloud) return
    if (format === 'transforms') {
      const imgByUuid = new Map(images.value.map((im) => [im.uuid, im]))
      const transformImages = [...cloud.cameras.entries()]
        .map(([uuid, cam]) => {
          const im = imgByUuid.get(uuid)
          if (!im || !cam.K || !im.meta?.width || !im.meta?.height) return null
          return { name: im.name, R: cam.R, t: cam.t, K: cam.K, width: im.meta.width, height: im.meta.height }
        })
        .filter(Boolean)
      if (!transformImages.length) return
      saveJson(buildTransformsJson({ images: transformImages }), `${projectBase()}-transforms.json`)
      log(`transforms.json export: ${transformImages.length} camera(s)`, 'success', 'Export')
      return
    }
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
  function doExportColmap({ format } = {}) {
    const cloud = sparseCloud()
    if (!cloud) return
    const imgByUuid = new Map(images.value.map((im) => [im.uuid, im]))
    const sensorById = new Map(sensors.value.map((sensor) => [sensor.id, sensor]))

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
        const sensor = sensorById.get(im?.sensorId)
        return sensor?.kind === 'film' || !!distortionOf(sensor)
      })
      if (risky) {
        throw new Error('This legacy model has no BA-frame observations, but its sensors use '
          + 'lens distortion or film coordinates. Re-run reconstruction before COLMAP export.')
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

    const model = buildColmapModel({ images: exportImages, points })
    // Binary (.bin) or text (.txt) — both share the ColmapModel struct; only the
    // encoding differs. Binary files are already Uint8Array; text is UTF-8 encoded.
    const files = format === 'bin' ? serializeColmapModelBin(model) : serializeColmapModel(model)
    const entries = Object.entries(files).map(([name, data]) => ({
      name, data: typeof data === 'string' ? new TextEncoder().encode(data) : data,
    }))
    downloadBlob(`${projectBase()}-colmap-${format === 'bin' ? 'bin' : 'txt'}.zip`, zipStore(entries), 'application/zip')
    log(`COLMAP export: ${exportImages.length} cameras, ${points.length} points → ${format === 'bin' ? '.bin' : '.txt'} zip`, 'success', 'Export')
  }

  // zlib-DEFLATE a byte buffer via the browser-native CompressionStream (DOM/
  // worker-only — hence injected into the pure GeoTIFF writer rather than living
  // in it). Produces a zlib stream, exactly what TIFF Adobe DEFLATE (tag 8) wants.
  async function deflateBytes(bytes) {
    const cs = new CompressionStream('deflate')
    const stream = new Blob([bytes]).stream().pipeThrough(cs)
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }

  // `.prj` contents for a CRS: real OGC WKT1 when we can build a correct one for
  // the EPSG code (WGS84 geographic / UTM zones), else the raw proj4/EPSG string.
  function prjText(info) {
    const wkt = epsgToWkt(info.code)
    if (wkt) return wkt
    log(`.prj: no WKT template for ${info.crs} — writing the raw proj4/EPSG string`, 'info', 'Export')
    return info.crs
  }

  // Re-encode a data: URL (a canvas PNG) to a JPEG/PNG Blob at the given quality.
  async function reencodeDataUrl(dataUrl, mime = 'image/jpeg', quality = 0.9) {
    const img = await new Promise((resolve, reject) => {
      const el = new Image(); el.onload = () => resolve(el); el.onerror = reject; el.src = dataUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
    canvas.getContext('2d').drawImage(img, 0, 0)
    return new Promise((resolve) => canvas.toBlob(resolve, mime, quality))
  }

  // DEM → GeoTIFF (optional DEFLATE), ESRI ASCII grid, or hillshade PNG — each
  // with a .prj sidecar carrying the CRS (real WKT where possible).
  async function doExportDem({ format, nodata, compression }) {
    if (!dem.value) return
    const info = crsInfo(dem.value)
    if (format === 'geotiff') {
      const deflate = compression === 'deflate' ? deflateBytes : null
      const tif = await demToGeoTiff(dem.value, { crs: info, nodata, deflate })
      downloadBlob(`${projectBase()}-dem.tif`, tif, 'image/tiff')
      log(`DEM export: GeoTIFF${deflate ? ' (DEFLATE)' : ''}`, 'success', 'Export')
      return
    }
    if (format === 'png') {
      // Hillshade PNG — the DEM's hillshaded preview canvas + world file + .prj.
      if (!dem.value.previewDataUrl) { log('DEM: no hillshade preview to export', 'warn', 'Export'); return }
      downloadBlob(`${projectBase()}-dem-hillshade.png`, await dataUrlToBlob(dem.value.previewDataUrl))
      downloadBlob(`${projectBase()}-dem-hillshade.wld`, rasterWorldFile(dem.value), 'text/plain;charset=utf-8')
      if (info.crs) downloadBlob(`${projectBase()}-dem-hillshade.prj`, prjText(info), 'text/plain;charset=utf-8')
      log('DEM export: hillshade PNG + world file', 'success', 'Export')
      return
    }
    downloadBlob(`${projectBase()}-dem.asc`, demToAsciiGrid(dem.value, { nodata }), 'text/plain;charset=utf-8')
    if (info.crs) downloadBlob(`${projectBase()}-dem.prj`, prjText(info), 'text/plain;charset=utf-8')
  }

  // Ortho → GeoTIFF (optional DEFLATE), or PNG/JPEG + world file (.wld) + .prj.
  // Shares the DEM's geotransform.
  async function doExportOrtho({ format, compression, jpegQuality }) {
    if (!ortho.value || !dem.value) return
    const info = crsInfo(dem.value)
    if (format === 'geotiff') {
      const deflate = compression === 'deflate' ? deflateBytes : null
      const tif = await orthoToGeoTiff(ortho.value, dem.value, { crs: info, deflate })
      downloadBlob(`${projectBase()}-ortho.tif`, tif, 'image/tiff')
      log(`Ortho export: GeoTIFF${deflate ? ' (DEFLATE)' : ''}`, 'success', 'Export')
      return
    }
    if (!ortho.value.previewDataUrl) return
    const jpeg = format === 'jpeg'
    const ext = jpeg ? 'jpg' : 'png'
    const blob = jpeg
      ? await reencodeDataUrl(ortho.value.previewDataUrl, 'image/jpeg', jpegQuality ?? 0.9)
      : await dataUrlToBlob(ortho.value.previewDataUrl)
    downloadBlob(`${projectBase()}-ortho.${ext}`, blob)
    // World file extension mirrors the image (.wld works for both; .jgw/.pgw are the
    // strict siblings — .wld is universally accepted, so keep it simple).
    downloadBlob(`${projectBase()}-ortho.wld`, rasterWorldFile(dem.value), 'text/plain;charset=utf-8')
    if (info.crs) downloadBlob(`${projectBase()}-ortho.prj`, prjText(info), 'text/plain;charset=utf-8')
    log(`Ortho export: ${jpeg ? 'JPEG' : 'PNG'} + world file`, 'success', 'Export')
  }

  return { exportKind, exportPoses, exportSensors, exportKeypoints, exportMatches, onExportRun }
}
