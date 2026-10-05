import { ref } from 'vue'
import { metresPerCrsUnit } from '../core/crs.js'
import { buildPosesCsv, buildSensorsCsv, downloadCsv } from '../utils/exportCsv.js'
import { cloudToPly, meshToPly, meshToGlb, meshToObj, meshToStl, reconstructionToJson, demToAsciiGrid, demToGeoTiff, demToCog, orthoToGeoTiff, orthoToCog, rasterWorldFile, prepareCloudForExport, prepareMeshForExport } from '../core/products/exporters.js'
import { cloudToLas } from '../core/io/las.js'
import { cloudToXyz } from '../core/io/cloudText.js'
import { buildColmapModel, serializeColmapModel, serializeColmapModelBin } from '../core/io/colmapModel.js'
import { imageIdsToPairId } from '../core/io/colmapDatabase.js'
import { exportColmapDatabase } from '../workers/colmapDbClient.js'
import { undistortImage, exportLazCloud } from '../workers/computeClient.js'
import { buildTransformsJson } from '../core/io/transforms.js'
import { buildNvm, buildOpenMvg } from '../core/io/sfmInterop.js'
import { epsgToWkt } from '../core/products/wkt.js'
import {
  ecefTransformFromProbes, boundingBox, buildTileset, cloudToGlbPoints,
  localBounds, cloudCentroid,
} from '../core/products/tiles3d.js'
import { transformAsync, ensureProjection } from '../core/crs.js'
import { useLog } from './useLog.js'
import { distortionOf } from '../core/sfm/distortion.js'
import { downloadBlob, dataUrlToBlob } from '../utils/download.js'
import { zipStore } from '../utils/zip.js'
import { showToast } from './useToasts.js'
import * as opfs from '../utils/opfs.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { siftDescNorm, toMatchSpace } from '../core/features/siftDescriptors.js'

// Camera-params + product export funnel, lifted out of App.vue. Owns `exportKind`
// (which export dialog is open); the Ribbon command dispatch sets it and the
// template's ExportModal binds to it. The reactive state it reads is injected as
// refs so the composable stays free of store wiring. Injected deps (all refs):
//   poses, sensors, images, matchStore, clouds, selectedCloud, mainSparseCloud,
//   dem, ortho, georef, currentProjectName, currentCrs, summary
// plus `effectiveFrameSpec` — THE unit resolver (useReconstructionStore). Export
// must not decide independently what a coordinate means.
// plus `progress` — usePipeline's progress handle, for the one export (undistorted
// images) that is minutes of work rather than a serialization.
export function useExports({
  poses, sensors, images, matchStore, clouds, selectedCloud, mainSparseCloud, dem, ortho,
  georef, currentProjectName, currentCrs, summary, progress, effectiveFrameSpec,
}) {
  const { log } = useLog()
  const projects = useProjectsStore()

  // The similarity a cloud/mesh export should apply, from THE resolver:
  //   georeference  → the full CRS similarity (scale + rotation + translation)
  //   scale bars    → a pure scale, no rotation, no origin shift
  //   neither       → null (raw SfM coordinates, up to scale)
  //
  // The scale case is deliberately scale-ONLY rather than the whole scaled local
  // frame. The orientation half of that frame is a *product* convention — DEM and
  // ortho need a vertical axis, so buildLocalFrame guesses one (camera viewing
  // dirs, else cloud PCA). For an object scan that guess is a PCA axis, and
  // silently re-orienting an exported cloud by it would change more than the unit
  // the user asked for. Metres in the model's own frame is the honest answer, and
  // it is the answer with NO CRS attached (see D9 / WS0.4).
  async function exportSimilarity() {
    const resolved = await effectiveFrameSpec?.()
    if (resolved?.source === 'georef') {
      return { sim: { scale: resolved.frameSpec.scale, R: resolved.frameSpec.R, t: resolved.frameSpec.t, local: resolved.frameSpec.local ?? null }, unit: resolved.unit, crs: resolved.crs, source: 'georef' }
    }
    if (resolved?.source === 'scalebars') {
      return {
        sim: { scale: resolved.scale, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] },
        unit: 'm', crs: null, source: 'scalebars',
      }
    }
    return { sim: null, unit: 'model', crs: null, source: null }
  }
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

  // Which export dialog is open ('cloud' | 'model' | 'colmap' | 'undistorted' | 'dem' |
  // 'ortho'), or null.
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
      else if (kind === 'undistorted') await doExportUndistorted(settings)
      else if (kind === 'tiles3d') await doExportTiles3d(settings)
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
  // Normalize either cloud shape to flat typed arrays for the worker. This
  // COPIES rather than handing over the store's own buffers: the worker call
  // transfers, and a detached store cloud would be a far worse outcome than one
  // extra buffer during an export the user asked for.
  function toFlatCloud(src) {
    if (src && src.pos) {
      const count = src.count ?? src.pos.length / 3
      return {
        count,
        pos: new Float64Array(src.pos.subarray(0, count * 3)),
        col: src.col ? new Uint8Array(src.col.subarray(0, count * 3)) : null,
      }
    }
    const n = src.length
    const pos = new Float64Array(n * 3)
    const col = new Uint8Array(n * 3)
    for (let i = 0; i < n; i++) {
      pos[i * 3] = src[i].x; pos[i * 3 + 1] = src[i].y; pos[i * 3 + 2] = src[i].z
      const c = src[i].color || [200, 200, 200]
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]
    }
    return { count: n, pos, col }
  }

  async function doExportCloud({ format, includeColor, applyGeoref, downsampleCell }) {
    const cloud = cloudHasPoints(selectedCloud.value)
      ? selectedCloud.value
      : clouds.value.find(cloudHasPoints)
    if (!cloud) return
    // cloudToPly/Las/Xyz all accept either the sparse point-object array or the
    // dense flat shape; prepareCloudForExport normalizes when georef/downsample apply.
    const raw = cloud.kind === 'dense'
      ? { count: cloud.count, pos: cloud.pos, col: cloud.col, nrm: cloud.nrm }
      : cloud.points
    const frame = applyGeoref ? await exportSimilarity() : { sim: null, unit: 'model', crs: null, source: null }
    const src = prepareCloudForExport(raw, {
      sim: frame.sim,
      cell: downsampleCell > 0 ? downsampleCell : 0,
      onLog: log,
    })
    if (frame.source === 'georef') log(`Cloud export: georeferenced to ${frame.crs}`, 'info', 'Export')
    else if (frame.source === 'scalebars') {
      log(`Cloud export: scaled to metres (×${frame.sim.scale.toPrecision(6)}) `
        + 'from the scale bars — metric coordinates, no CRS', 'info', 'Export')
    }
    const base = `${projectBase()}-${cloud.kind}`
    if (format === 'las' || format === 'laz') {
      // NEVER attach a CRS merely because the coordinates are metric: only a real
      // georeference names one.
      const m = frame.source === 'georef' && frame.crs ? /EPSG:(\d+)/i.exec(frame.crs) : null
      const crsCode = m ? Number(m[1]) : null
      const geographic = m ? Number(m[1]) === 4326 : false
      if (format === 'laz') {
        // LASzip runs in the worker (crates/lazcodec) — the arithmetic coder on a
        // multi-million-point cloud would freeze the UI thread.
        const { bytes } = await exportLazCloud(toFlatCloud(src), { crsCode, geographic, onLog: log })
        downloadBlob(`${base}.laz`, bytes, 'application/octet-stream')
        return
      }
      const las = cloudToLas(src, { crsCode, geographic, onLog: log })
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
  async function doExportMesh({ format, includeColor, applyGeoref }) {
    const cloud = selectedCloud.value?.kind === 'mesh'
      ? selectedCloud.value
      : clouds.value.find((c) => c.kind === 'mesh' && c.count > 0)
    if (!cloud) return
    const raw = { nVerts: cloud.nVerts, count: cloud.count, pos: cloud.pos, idx: cloud.idx, col: cloud.col }
    const frame = applyGeoref ? await exportSimilarity() : { sim: null, unit: 'model', crs: null, source: null }
    const mesh = prepareMeshForExport(raw, { sim: frame.sim })
    if (frame.source === 'georef') log(`Mesh export: georeferenced to ${frame.crs}`, 'info', 'Export')
    else if (frame.source === 'scalebars') {
      log(`Mesh export: scaled to metres (×${frame.sim.scale.toPrecision(6)}) `
        + 'from the scale bars — metric coordinates, no CRS', 'info', 'Export')
    }
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
  async function doExportColmap({ format, includeImages = false } = {}) {
    const cloud = sparseCloud()
    if (!cloud) return
    if (format === 'transforms') { doExportModel({ format: 'transforms' }); return }
    const imgByUuid = new Map(images.value.map((im) => [im.uuid, im]))
    const sensorById = new Map(sensors.value.map((sensor) => [sensor.id, sensor]))

    const exportImages = [...cloud.cameras.entries()]
      .map(([uuid, cam]) => {
        const im = imgByUuid.get(uuid)
        if (!im || !cam.K || !im.meta?.width || !im.meta?.height) return null
        return { uuid, name: im.name, width: im.meta.width, height: im.meta.height, K: cam.K, R: cam.R, t: cam.t, keypoints: im.keypoints ?? [], file: im.file ?? null }
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
              if (px) return { uuid, x: px[0], y: px[1], featureIdx: kpIdx }
              const kp = imgByUuid.get(uuid)?.keypoints?.[kpIdx]
              return kp ? { uuid, x: kp.x, y: kp.y, featureIdx: kpIdx } : null
            })
            .filter(Boolean)
        : [],
    }))

    const model = buildColmapModel({ images: exportImages, points })
    // Adapters share the deterministic COLMAP-like model so image, feature and
    // track ids remain stable across every export representation.
    model.images.forEach((im, i) => { im.R = exportImages[i].R; im.K = exportImages[i].K; im.width = exportImages[i].width; im.height = exportImages[i].height })
    if (format === 'nvm') {
      downloadBlob(`${projectBase()}.nvm`, buildNvm(model), 'text/plain;charset=utf-8')
      log(`NVM export: ${model.images.length} cameras, ${model.points3D.length} points`, 'success', 'Export')
      return
    }
    if (format === 'openmvg') {
      saveJson(buildOpenMvg(model), `${projectBase()}-sfm_data.json`)
      log(`OpenMVG export: ${model.images.length} cameras, ${model.points3D.length} points`, 'success', 'Export')
      return
    }
    if (format === 'database' || format === 'workspace') {
      const imageIdByUuid = new Map(model.images.map((im, i) => [exportImages[i].uuid, im.imageId]))
      // COLMAP stores RootSIFT ×512 as uint8. A saved project keeps descriptors only
      // in OPFS (detection drops the in-memory copy), so read them from there; legacy
      // L2 detections convert exactly as matching does.
      const features = await Promise.all(exportImages.map(async (im, i) => {
        const source = imgByUuid.get(im.uuid)
        let descriptors = null
        if (source && siftDescNorm(source) != null) {
          const stored = source.descriptors
            ?? (projects.isPersisting ? await opfs.loadDescriptors(projects.currentProjectId, im.uuid) : null)
          const root = toMatchSpace(stored, source)
          if (root?.length === im.keypoints.length * 128) {
            descriptors = new Uint8Array(root.length)
            for (let k = 0; k < root.length; k++) descriptors[k] = Math.max(0, Math.min(255, Math.round(root[k] * 512)))
          }
        }
        return { imageId: model.images[i].imageId, keypoints: im.keypoints, descriptors }
      }))
      const withDesc = features.filter((f) => f.descriptors).length
      if (withDesc < features.length) {
        log(`COLMAP database: descriptors for ${withDesc} of ${features.length} image(s) — the rest `
          + 'are not SIFT or were not found; COLMAP will need to re-extract them', 'warn', 'Export')
      }
      const pairs = []
      for (const [, pair] of matchStore.value) {
        const imageIdA = imageIdByUuid.get(pair.idA), imageIdB = imageIdByUuid.get(pair.idB)
        if (!imageIdA || !imageIdB || pair.status !== 'done' || !pair.matches?.length) continue
        const flip = imageIdA > imageIdB
        pairs.push({
          pairId: imageIdsToPairId(imageIdA, imageIdB),
          matches: flip ? pair.matches.map(([a, b]) => [b, a]) : pair.matches,
          F: flip && pair.F ? [[pair.F[0][0], pair.F[1][0], pair.F[2][0]], [pair.F[0][1], pair.F[1][1], pair.F[2][1]], [pair.F[0][2], pair.F[1][2], pair.F[2][2]]] : (pair.F ?? null),
          E: pair.E ?? null, H: pair.H ?? null,
        })
      }
      const database = await exportColmapDatabase({ cameras: model.cameras, images: model.images, features, pairs })
      if (format === 'database') {
        downloadBlob(`${projectBase()}-database.db`, database, 'application/vnd.sqlite3')
        log(`COLMAP database export: ${model.images.length} images, ${pairs.length} match pairs`, 'success', 'Export')
        return
      }
      const modelFiles = serializeColmapModelBin(model)
      const entries = [
        { name: 'database.db', data: database },
        ...Object.entries(modelFiles).map(([name, data]) => ({ name: `sparse/0/${name}`, data })),
      ]
      if (includeImages) {
        for (const im of exportImages) if (im.file) entries.push({ name: `images/${im.name}`, data: new Uint8Array(await im.file.arrayBuffer()) })
      }
      downloadBlob(`${projectBase()}-colmap-workspace.zip`, zipStore(entries), 'application/zip')
      log(`COLMAP workspace export: database + sparse model${includeImages ? ' + images' : ''}`, 'success', 'Export')
      return
    }
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
    if (format === 'cog') {
      // COG defaults to DEFLATE: an uncompressed tiled file is strictly larger
      // than the baseline one for no benefit, and the whole point of the format
      // is cheap partial reads.
      const deflate = compression === 'none' ? null : deflateBytes
      const tif = await demToCog(dem.value, { crs: info, nodata, deflate })
      downloadBlob(`${projectBase()}-dem-cog.tif`, tif, 'image/tiff')
      log(`DEM export: Cloud-Optimized GeoTIFF${deflate ? ' (DEFLATE)' : ''}`, 'success', 'Export')
      return
    }
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
  // The geotransform comes from the ORTHO, not the DEM: an ortho can now be built
  // over a mesh/plane surface and at its own GSD, so the two grids need not match.
  // Orthos written before that (persisted without gsd/originX) fall back to the DEM,
  // which is exactly the grid they were built on.
  async function doExportOrtho({ format, compression, jpegQuality }) {
    if (!ortho.value) return
    const geo = ortho.value.gsd != null ? ortho.value : dem.value
    if (!geo) return
    const info = crsInfo(geo)
    if (format === 'cog') {
      const deflate = compression === 'none' ? null : deflateBytes
      const tif = await orthoToCog(ortho.value, geo, { crs: info, deflate })
      downloadBlob(`${projectBase()}-ortho-cog.tif`, tif, 'image/tiff')
      log(`Ortho export: Cloud-Optimized GeoTIFF${deflate ? ' (DEFLATE)' : ''}`, 'success', 'Export')
      return
    }
    if (format === 'geotiff') {
      const deflate = compression === 'deflate' ? deflateBytes : null
      const tif = await orthoToGeoTiff(ortho.value, geo, { crs: info, deflate })
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
    downloadBlob(`${projectBase()}-ortho.wld`, rasterWorldFile(geo), 'text/plain;charset=utf-8')
    if (info.crs) downloadBlob(`${projectBase()}-ortho.prj`, prjText(info), 'text/plain;charset=utf-8')
    log(`Ortho export: ${jpeg ? 'JPEG' : 'PNG'} + world file`, 'success', 'Export')
  }

  // ── Undistorted images (COLMAP `image_undistorter` parity) ──────────────────
  //
  // Writes a workspace an external dense/mesh pipeline can consume directly —
  // OpenMVS, MVE and MVS-Texturing all want pinhole images plus a PINHOLE camera
  // model, with no distortion to apply. websfm's sparse model is *already*
  // pinhole (distortion is folded out of the keypoints at ingest), so only the
  // pixels have to move; the camera model needs no edit at all.
  //
  // The resampling map is the same one dense MVS uses (core/sfm/displayFrame.js
  // `makeSampleMap`), which is what makes the exported images agree with the
  // exported cameras for a self-calibrated lens *and* a film scan.
  //
  // Layout mirrors COLMAP's undistorter so downstream tools need no arguments:
  //   images/<name>.<ext>
  //   sparse/{cameras,images,points3D}.bin
  async function doExportUndistorted({
    mode = 'crop', format = 'jpeg', quality = 0.92, maxDim = 0,
  } = {}) {
    const cloud = sparseCloud()
    if (!cloud || !cloud.cameras?.size) return
    const imgByUuid = new Map(images.value.map((im) => [im.uuid, im]))
    const sensorById = new Map(sensors.value.map((s) => [s.id, s]))
    const sum = summary?.value ?? null
    const selfCalBySensor = new Map(
      (sum?.selfCalDistortion ?? []).map((d) => [d.sensorId, { k1: d.k1, k2: d.k2, k3: d.k3 }]))
    const fidByUuid = new Map(
      (sum?.fiducialTransforms ?? []).map((t) => [t.uuid, { A: t.A, transform: t.transform ?? null, frame: t.frame }]))

    // The observations must be in the BA (pinhole) frame — that is the only frame
    // the undistorted pixels are in. Raw store keypoints are in scan/distorted
    // space, so a legacy model without viewsPx would write marks that don't sit on
    // the images it ships beside them.
    const anyViewsPx = cloud.points.some((p) => p.viewsPx && p.viewsPx.size)
    if (!anyViewsPx && cloud.points.length) {
      throw new Error('This model has no BA-frame observations (viewsPx). Re-run reconstruction '
        + 'before exporting undistorted images.')
    }

    const ext = format === 'png' ? 'png' : 'jpg'
    const targets = [...cloud.cameras.entries()].filter(([uuid, cam]) => {
      const im = imgByUuid.get(uuid)
      return im && cam?.K && (im.computeUrl || im.url)
    })
    if (!targets.length) return

    const entries = []
    const outImages = []
    let bytesTotal = 0
    progress?.open?.(`Exporting ${targets.length} undistorted images`, targets.length, null,
      { unit: 'images' })
    try {
      for (let i = 0; i < targets.length; i++) {
        if (progress?.aborted?.value) break
        const [uuid, cam] = targets[i]
        const im = imgByUuid.get(uuid)
        const sensor = im.sensorId ? sensorById.get(im.sensorId) : null
        const sc = im.sensorId ? selfCalBySensor.get(im.sensorId) : null
        const fid = fidByUuid.get(uuid) ?? null
        if (sensor?.kind === 'film' && !fid) {
          log(`Undistort: ${im.name} skipped — no interior-orientation transform from the `
            + 'last sparse run (re-run reconstruction).', 'warn', 'Export')
          progress?.report?.(i + 1, targets.length, im.name)
          continue
        }
        const res = await undistortImage({
          url: im.computeUrl ?? im.url,
          K: { fx: cam.K.fx, fy: cam.K.fy, cx: cam.K.cx, cy: cam.K.cy },
          dist: sensor ? distortionOf(sensor) : null,
          selfCal: sc && (sc.k1 || sc.k2 || sc.k3)
            ? { k1: sc.k1 || 0, k2: sc.k2 || 0, k3: sc.k3 || 0 } : null,
          fid, mode, maxDim, format, quality,
        }, { onLog: (m, l, c) => log(m, l, c ?? 'Export') })

        const name = `${im.name.replace(/\.[^.]+$/, '')}.${ext}`
        const data = new Uint8Array(res.bytes)
        bytesTotal += data.length
        // Plain ZIP has a hard 4 GB ceiling (no ZIP64 writer — the same limit
        // .websfm export pre-flights). Stop with an actionable message rather
        // than emitting a file that unzips corrupt.
        if (bytesTotal > 4 * 1024 ** 3) {
          throw new Error('Undistorted images exceed the 4 GB ZIP limit. Lower the output '
            + 'resolution or the JPEG quality, or export in batches.')
        }
        entries.push({ name: `images/${name}`, data })
        outImages.push({
          uuid, name, width: res.width, height: res.height, K: res.K,
          R: cam.R, t: cam.t, outScale: res.outScale, rect: res.rect,
        })
        progress?.report?.(i + 1, targets.length, im.name)
      }
      if (!outImages.length) {
        log('Undistort: nothing exported', 'warn', 'Export')
        return
      }

      // Move each observation onto its image's output grid: the model's marks are
      // in K's full-resolution pinhole frame, the images are scaled by `outScale`
      // and then cropped, so the same affine applies to both.
      const gridByUuid = new Map(outImages.map((o) => [o.uuid, o]))
      const kept = new Set(outImages.map((o) => o.uuid))
      const points = cloud.points.map((p) => ({
        xyz: [p.x, p.y, p.z],
        color: p.color,
        views: p.views
          ? [...p.views.entries()].map(([u, kpIdx]) => {
            if (!kept.has(u)) return null
            const px = p.viewsPx?.get(u)
            if (!px) return null
            const g = gridByUuid.get(u)
            const x = px[0] * g.outScale - g.rect.x
            const y = px[1] * g.outScale - g.rect.y
            // A mark that the crop cut away is no longer observable in the
            // exported image; dropping it keeps the model self-consistent.
            if (x < 0 || y < 0 || x > g.width - 1 || y > g.height - 1) return null
            return { uuid: u, x, y }
          }).filter(Boolean)
          : [],
      }))

      // No `keypoints` — the store's are in scan space, and the compact
      // observed-points form is what a sparse-only consumer wants anyway.
      const model = buildColmapModel({ images: outImages, points })
      const files = serializeColmapModelBin(model)
      for (const [n, data] of Object.entries(files)) entries.push({ name: `sparse/${n}`, data })

      downloadBlob(`${projectBase()}-undistorted.zip`, zipStore(entries), 'application/zip')
      const cropped = outImages.filter((o) => o.rect.x || o.rect.y).length
      log(`Undistorted export: ${outImages.length} images (${ext.toUpperCase()}, ${mode}`
        + `${cropped ? `, ${cropped} cropped` : ''}) + PINHOLE sparse model, `
        + `${(bytesTotal / 1024 ** 2).toFixed(0)} MB`, 'success', 'Export')
    } finally {
      await progress?.close?.()
    }
  }

  // ── Cesium 3D Tiles (single tile) ───────────────────────────────────────────
  //
  // tileset.json + one .glb. The only real content is the placement: the tile
  // transform maps local metres to ECEF, and it is *measured* from probe points
  // rather than assuming the project's grid axes are east/north. That assumption
  // is the usual shortcut and it fails precisely here — near the poles a
  // projected CRS's convergence approaches the longitude difference itself.
  //
  // LOD tiling is deliberately not attempted (see docs/planning/plan-interop-formats.md).
  async function doExportTiles3d({ includeColor = true } = {}) {
    const cloud = cloudHasPoints(selectedCloud.value)
      ? selectedCloud.value
      : clouds.value.find(cloudHasPoints)
    if (!cloud) return

    const resolved = await effectiveFrameSpec?.()
    const g = resolved?.source === 'georef' ? { sim: resolved.frameSpec, crs: resolved.crs } : null
    const raw = cloud.kind === 'dense'
      ? { count: cloud.count, pos: cloud.pos, col: cloud.col }
      : cloud.points
    // Georeference first: a tileset is only placeable in the project CRS.
    const src = toFlatCloud(prepareCloudForExport(raw, { sim: g?.sim ?? null, cell: 0, onLog: log }))

    const origin = cloudCentroid(src)
    let transform = null
    const crs = g?.crs ?? null
    if (crs && crs !== 'local') {
      await ensureProjection(crs)
      // One project-CRS unit east and north of the origin. Both round-trip through
      // proj4, so the resulting basis carries the local rotation AND scale factor.
      const geo = async ([x, y, z]) => {
        const [lon, lat] = await transformAsync([x, y], crs, 'EPSG:4326')
        return { lon, lat, h: z * (metresPerCrsUnit(crs) ?? 1) }
      }
      transform = ecefTransformFromProbes({
        origin: await geo(origin),
        east: await geo([origin[0] + 1, origin[1], origin[2]]),
        north: await geo([origin[0], origin[1] + 1, origin[2]]),
        verticalMetresPerUnit: metresPerCrsUnit(crs) ?? 1,
      })
    } else {
      log('3D Tiles: no georeference — the tileset has no place on the globe. '
        + 'Georeference the model first for a viewer to position it.', 'warn', 'Export')
    }

    const glb = cloudToGlbPoints(src, { origin, color: includeColor })
    const { min, max } = localBounds(src, origin)
    const tileset = buildTileset({
      transform, box: boundingBox(min, max), contentUri: 'content.glb',
    })
    const entries = [
      { name: 'tileset.json', data: new TextEncoder().encode(JSON.stringify(tileset, null, 2)) },
      { name: 'content.glb', data: glb },
    ]
    downloadBlob(`${projectBase()}-3dtiles.zip`, zipStore(entries), 'application/zip')
    log(`3D Tiles export: ${src.count.toLocaleString()} points, `
      + `${transform ? `placed in ${crs}` : 'local frame (unplaced)'}`, 'success', 'Export')
  }

  return { exportKind, exportPoses, exportSensors, exportKeypoints, exportMatches, onExportRun }
}
