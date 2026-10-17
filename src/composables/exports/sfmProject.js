import { computeSourceOf } from '../../utils/image.js'
import { makeFrameModelResolver } from '../../core/sfm/displayFrame.js'
import { distortionOf } from '../../core/sfm/distortion.js'
import { buildColmapModel, serializeColmapModelBinParts, serializeColmapModelParts } from '../../core/io/colmapModel.js'
import { downloadBlob } from '../../utils/download.js'
import { partsToBlob } from '../../utils/blobParts.js'
import { buildNvmParts, buildOpenMvg } from '../../core/io/sfmInterop.js'
import { siftDescNorm, toMatchSpace } from '../../core/features/siftDescriptors.js'
import * as opfs from '../../utils/opfs.js'
import { imageIdsToPairId } from '../../core/io/colmapDatabase.js'
import { exportColmapDatabase } from '../../workers/colmapDbClient.js'
import { zipParts, crc32 } from '../../utils/zip.js'
import { undistortImage } from '../../workers/computeClient.js'
import { toScaledPx } from '../../core/sfm/geometry.js'

// The SfM project exports, split out of useExports: a COLMAP model (text or
// binary, optionally with its database and images) and the other interchange
// formats, and undistorted images in COLMAP `image_undistorter` parity — the one
// export long enough to run behind the progress bar.
//
// Deps are useExports' injected refs and shared helpers.
export function createSfmProjectExports({
  doExportModel, images, imagesStore, log, matchStore, matchesStore, progress, projectBase, projects,
  saveJson, sensors, sparseCloud, summary, swapPairs,
}) {
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
        return { uuid, name: im.name, width: im.meta.width, height: im.meta.height, K: cam.K, R: cam.R, t: cam.t, keypoints: null, file: im.file ?? null }
      })
      .filter(Boolean)
    if (!exportImages.length) return
    // The COLMAP model lists every keypoint of every exported image, so it needs them
    // all at once (TODO ▸ SC-7: the model is still built in memory). Read them from
    // disk here, past the keypoint cache, rather than assume they are resident.
    for (const im of exportImages) im.keypoints = (await imagesStore.readKeypoints(imgByUuid.get(im.uuid))) ?? []
    const exported = new Set(exportImages.map((im) => im.uuid))

    // Warn if we're about to fall back to raw store keypoints for a project whose BA
    // frame differs from scan/distorted space (distortion, film, or self-cal) but no
    // view pixels are present — those observations won't match the exported cameras.
    const anyViewsPx = cloud.points.hasPixels
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

    const keypointsByUuid = new Map(exportImages.map((im) => [im.uuid, im.keypoints]))
    const sp = cloud.points
    const points = Array.from({ length: sp.length }, (_, i) => {
      const views = []
      sp.forEachView(i, (uuid, kpIdx, px, py) => {
        if (!exported.has(uuid)) return
        if (Number.isFinite(px)) { views.push({ uuid, x: px, y: py, featureIdx: kpIdx }); return }
        const kps = keypointsByUuid.get(uuid)
        if (kps && kpIdx < kps.length) views.push({ uuid, x: kps.x(kpIdx), y: kps.y(kpIdx), featureIdx: kpIdx })
      })
      return { xyz: sp.xyz(i), color: sp.colorAt(i) ?? undefined, views }
    })

    const model = buildColmapModel({ images: exportImages, points })
    // Adapters share the deterministic COLMAP-like model so image, feature and
    // track ids remain stable across every export representation.
    model.images.forEach((im, i) => { im.R = exportImages[i].R; im.K = exportImages[i].K; im.width = exportImages[i].width; im.height = exportImages[i].height })
    if (format === 'nvm') {
      downloadBlob(`${projectBase()}.nvm`, partsToBlob(buildNvmParts(model), 'text/plain;charset=utf-8'))
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
      const wanted = [...matchStore.value.values()].filter((pair) => pair.status === 'done' && pair.nMatches > 0
        && imageIdByUuid.get(pair.idA) && imageIdByUuid.get(pair.idB))
      await matchesStore.streamPairMatches(wanted, (pair, m) => {
        const imageIdA = imageIdByUuid.get(pair.idA), imageIdB = imageIdByUuid.get(pair.idB)
        const flip = imageIdA > imageIdB
        pairs.push({
          pairId: imageIdsToPairId(imageIdA, imageIdB),
          // Flat [a, b, …]; flipped into COLMAP's image order when it differs from ours.
          // Always a copy: the stream hands views into its read windows, and posting a
          // view to the worker would clone that whole window once per pair.
          matches: flip ? swapPairs(m) : m.slice(),
          F: flip && pair.F ? [[pair.F[0][0], pair.F[1][0], pair.F[2][0]], [pair.F[0][1], pair.F[1][1], pair.F[2][1]], [pair.F[0][2], pair.F[1][2], pair.F[2][2]]] : (pair.F ?? null),
          E: pair.E ?? null, H: pair.H ?? null,
        })
      })
      const database = await exportColmapDatabase({ cameras: model.cameras, images: model.images, features, pairs })
      if (format === 'database') {
        downloadBlob(`${projectBase()}-database.db`, database, 'application/vnd.sqlite3')
        log(`COLMAP database export: ${model.images.length} images, ${pairs.length} match pairs`, 'success', 'Export')
        return
      }
      const modelFiles = serializeColmapModelBinParts(model)
      const entries = [
        { name: 'database.db', data: database },
        ...Object.entries(modelFiles).map(([name, data]) => ({ name: `sparse/0/${name}`, data })),
      ]
      // Source photos go in as Blobs: the zip references the files and never reads
      // the image set into memory (only a CRC pass, a slice at a time).
      if (includeImages) {
        for (const im of exportImages) if (im.file) entries.push({ name: `images/${im.name}`, data: im.file })
      }
      downloadBlob(`${projectBase()}-colmap-workspace.zip`, new Blob(await zipParts(entries), { type: 'application/zip' }))
      log(`COLMAP workspace export: database + sparse model${includeImages ? ' + images' : ''}`, 'success', 'Export')
      return
    }
    // Binary (.bin) or text (.txt) — both share the ColmapModel struct; only the
    // encoding differs. Each file is bounded parts (Uint8Arrays, or string parts the
    // zip writer UTF-8 encodes one at a time).
    const files = format === 'bin' ? serializeColmapModelBinParts(model) : serializeColmapModelParts(model)
    const entries = Object.entries(files).map(([name, data]) => ({ name, data }))
    downloadBlob(`${projectBase()}-colmap-${format === 'bin' ? 'bin' : 'txt'}.zip`,
      new Blob(await zipParts(entries), { type: 'application/zip' }))
    log(`COLMAP export: ${exportImages.length} cameras, ${points.length} points → ${format === 'bin' ? '.bin' : '.txt'} zip`, 'success', 'Export')
  }

  // zlib-DEFLATE a byte buffer via the browser-native CompressionStream (DOM/
  // worker-only — hence injected into the pure GeoTIFF writer rather than living
  // in it). Produces a zlib stream, exactly what TIFF Adobe DEFLATE (tag 8) wants.

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
    // Self-cal bags per sensor or per sensorless image (core/sfm/displayFrame.js).
    const frameModel = makeFrameModelResolver({ summary: sum, sensors: sensors.value })
    const fidByUuid = new Map(
      (sum?.fiducialTransforms ?? []).map((t) => [t.uuid, { A: t.A, transform: t.transform ?? null, frame: t.frame }]))

    // The observations must be in the BA (pinhole) frame — that is the only frame
    // the undistorted pixels are in. Raw store keypoints are in scan/distorted
    // space, so a legacy model without view pixels would write marks that don't sit
    // on the images it ships beside them.
    if (!cloud.points.hasPixels && cloud.points.length) {
      throw new Error('This model has no BA-frame observations. Re-run reconstruction '
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
        const fid = fidByUuid.get(uuid) ?? null
        if (sensor?.kind === 'film' && !fid) {
          log(`Undistort: ${im.name} skipped — no interior-orientation transform from the `
            + 'last sparse run (re-run reconstruction).', 'warn', 'Export')
          progress?.report?.(i + 1, targets.length, im.name)
          continue
        }
        const res = await undistortImage({
          url: computeSourceOf(im),
          K: { fx: cam.K.fx, fy: cam.K.fy, cx: cam.K.cx, cy: cam.K.cy },
          dist: frameModel(im).dist,
          selfCal: frameModel(im).selfCal,
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
        // Held as a Blob (browser blob storage, not the JS heap) with its CRC taken
        // now, while the bytes are in hand, so the zip never re-reads it.
        entries.push({ name: `images/${name}`, data: new Blob([data]), crc: crc32(data) })
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
      const sp = cloud.points
      const points = Array.from({ length: sp.length }, (_, i) => {
        const views = []
        sp.forEachPixel(i, (u, px, py) => {
          if (!kept.has(u)) return
          const g = gridByUuid.get(u)
          // Centre-aligned like the resample and scaleK (geometry.js toScaledPx).
          const x = toScaledPx(px, g.outScale) - g.rect.x
          const y = toScaledPx(py, g.outScale) - g.rect.y
          // A mark that the crop cut away is no longer observable in the
          // exported image; dropping it keeps the model self-consistent.
          if (x < 0 || y < 0 || x > g.width - 1 || y > g.height - 1) return
          views.push({ uuid: u, x, y })
        })
        return { xyz: sp.xyz(i), color: sp.colorAt(i) ?? undefined, views }
      })

      // No `keypoints` — the store's are in scan space, and the compact
      // observed-points form is what a sparse-only consumer wants anyway.
      const model = buildColmapModel({ images: outImages, points })
      const files = serializeColmapModelBinParts(model)
      for (const [n, data] of Object.entries(files)) entries.push({ name: `sparse/${n}`, data })

      downloadBlob(`${projectBase()}-undistorted.zip`, new Blob(await zipParts(entries), { type: 'application/zip' }))
      const cropped = outImages.filter((o) => o.rect.x || o.rect.y).length
      log(`Undistorted export: ${outImages.length} images (${ext.toUpperCase()}, ${mode}`
        + `${cropped ? `, ${cropped} cropped` : ''}) + PINHOLE sparse model, `
        + `${(bytesTotal / 1024 ** 2).toFixed(0)} MB`, 'success', 'Export')
    } finally {
      await progress?.close?.()
    }
  }

  return {
    doExportColmap, doExportUndistorted,
  }
}
