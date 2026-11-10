import {
  parseColmapModelBin,
  parseColmapModel,
  readColmapModel,
  makeNameResolver,
  colmapToSparse,
} from '../../core/io/colmapModel.js'
import { markRaw } from 'vue'
import { nounFor, pluralize } from '../../core/textFormat.js'

// External models into the reconstruction, split out of useReconstructionStore:
// a COLMAP / interop sparse model (added beside a computed one, never replacing it)
// and an imported point cloud or mesh (always a new, `imported` cloud).
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createImporters({
  clouds,
  images,
  log,
  mainSparseCloud,
  mainSparseId,
  makeCloudId,
  save,
  selectedCloudId,
  upsertSparseCloud,
}) {
  // Import a COLMAP sparse model (text OR binary) as a NEW sparse cloud (never
  // replaces a computed one — MC lets both coexist for comparison; becomes main
  // only when no sparse cloud exists yet). `files` is a map keyed by canonical
  // name — `cameras.txt`/`images.txt`/`points3D.txt` (string values) or the `.bin`
  // variants (Uint8Array values); the presence of a `.bin` key selects the binary
  // parser. Images are matched to the loaded set by name. Returns true on success.
  // Each COLMAP camera's lens is kept: its observations are undistorted with it and
  // the new cloud records it as its own calibration (importedCalibration).
  // An imported cloud's calibration: every camera its own group with the lens its file
  // gave (null: a pinhole camera — never the project sensor's lens, which these cameras
  // were not solved with).
  function importedCalibration(cameras, lensByUuid, source) {
    return {
      groups: [...cameras.keys()].map((uuid) => ({
        imageUuid: uuid,
        dist: lensByUuid.get(uuid) ?? null,
        selfCal: null,
      })),
      fiducialTransforms: [],
      source,
    }
  }

  function importColmapModel(files) {
    const isBin = files['cameras.bin'] || files['images.bin'] || files['points3D.bin']
    let colImages, colPoints, droppedDistortion
    try {
      const model = isBin ? parseColmapModelBin(files) : parseColmapModel(files)
      ;({ images: colImages, points: colPoints, droppedDistortion } = readColmapModel(model))
    } catch (err) {
      log(`COLMAP import: could not parse model — ${err?.message ?? err}`, 'error', 'Reconstruction')
      return false
    }
    if (!colImages.length) {
      log('COLMAP import: no images found (need cameras.txt + images.txt)', 'warn', 'Reconstruction')
      return false
    }

    const resolve = makeNameResolver(images.value.map((im) => ({ uuid: im.uuid, name: im.name })))
    const { cameras, points, matched, unmatched, lensByUuid } = colmapToSparse(
      { images: colImages, points: colPoints },
      resolve,
    )

    log(
      `COLMAP import: matched ${matched.length}/${colImages.length} images by name` +
        `, ${points.length}/${colPoints.length} points`,
      'info',
      'Reconstruction',
    )
    if (unmatched.length) {
      log(
        `COLMAP import: ${pluralize(unmatched.length, 'image')} not in this project (skipped): ` +
          unmatched.slice(0, 8).join(', ') +
          (unmatched.length > 8 ? '…' : ''),
        'warn',
        'Reconstruction',
      )
    }
    if (droppedDistortion.length) {
      log(
        `COLMAP import: ${nounFor(droppedDistortion.length, 'camera')} ${droppedDistortion.join(', ')} ` +
          'use a lens model WebSfM does not have — read as pinhole (fx/fy/cx/cy)',
        'warn',
        'Reconstruction',
      )
    }
    if (cameras.size < 2) {
      log(
        'COLMAP import: fewer than 2 images matched the loaded set — nothing to import. ' +
          'Load the matching images first (names must correspond).',
        'warn',
        'Reconstruction',
      )
      return false
    }

    upsertSparseCloud(cameras, points, {
      replaceId: null,
      asMain: !mainSparseCloud.value,
      name: 'Imported (COLMAP)',
      imported: true,
      calibration: importedCalibration(cameras, lensByUuid, 'colmap'),
    })
    if (lensByUuid.size)
      log(
        `COLMAP import: kept the lens of ${pluralize(lensByUuid.size, 'camera')} (observations undistorted with it)`,
        'info',
        'Reconstruction',
      )
    log(
      `COLMAP import: added sparse cloud (${cameras.size} cameras, ${points.length} points)` +
        `${mainSparseId.value === selectedCloudId.value ? ' — set as main' : ''}`,
      'success',
      'Reconstruction',
    )
    save()
    return true
  }

  function importInteropModel(model) {
    const resolve = makeNameResolver(images.value.map((im) => ({ uuid: im.uuid, name: im.name })))
    const loadedByUuid = new Map(images.value.map((im) => [im.uuid, im]))
    const normalizedImages = (model.images ?? []).map((im) => {
      const uuid = resolve(im.name),
        loaded = loadedByUuid.get(uuid)
      const width = im.width ?? loaded?.meta?.width ?? null,
        height = im.height ?? loaded?.meta?.height ?? null
      return {
        ...im,
        width,
        height,
        K: {
          fx: im.K?.fx,
          fy: im.K?.fy ?? im.K?.fx,
          cx: im.K?.cx ?? (width ? width / 2 : 0),
          cy: im.K?.cy ?? (height ? height / 2 : 0),
        },
      }
    })
    // Views written about the image centre (Bundler) become pixels, now the sizes are known.
    let modelPoints = model.points ?? []
    if (model.viewsCentered) {
      const centre = new Map(normalizedImages.map((im) => [im.imageId, [im.K.cx, im.K.cy]]))
      modelPoints = modelPoints.map((p) => ({
        ...p,
        views: p.views.map((v) => {
          const [cx, cy] = centre.get(v.imageId) ?? [0, 0]
          return { ...v, x: v.x + cx, y: v.y + cy }
        }),
      }))
    }
    const { cameras, points, matched, unmatched, lensByUuid } = colmapToSparse(
      { images: normalizedImages, points: modelPoints },
      resolve,
    )
    if (cameras.size < 2) {
      log(`${model.format} import: fewer than 2 cameras match loaded images`, 'warn', 'Reconstruction')
      return false
    }
    upsertSparseCloud(cameras, points, {
      replaceId: null,
      asMain: !mainSparseCloud.value,
      name: `Imported (${model.format})`,
      imported: true,
      calibration: importedCalibration(cameras, lensByUuid, String(model.format ?? 'import').toLowerCase()),
    })
    log(
      `${model.format} import: ${matched.length} cameras, ${points.length} points${unmatched.length ? `, ${unmatched.length} unmatched` : ''}`,
      'success',
      'Reconstruction',
    )
    save()
    return true
  }

  // Another project's model merged with this one (Import ▸ WebSfM Project, core/sfm/
  // modelMerge.js): a NEW sparse cloud that becomes the main model, so the model it was
  // made from stays beside it (Set as main brings it back). Not `imported`: its cameras
  // were solved by WebSfM, and every tool treats it as a computed model.
  function addMergedModel({ cameras, points, calibration, name }) {
    upsertSparseCloud(markRaw(cameras), markRaw(points), { replaceId: null, asMain: true, name, calibration })
    return save()
  }

  // Import an external point cloud or mesh (parsed off-thread by the `parseCloud`
  // worker op, transformed by applyImportTransform). Always ADDS a new cloud —
  // never replaces computed ones — flagged `imported: true` so upsertDense/Mesh
  // skip it on a re-fuse/re-mesh. Coordinates land verbatim in the current frame
  // (no CRS reprojection). Authoritative positions retain Float64 precision;
  // the renderer builds origin-relative Float32 buffers. Returns true
  // on success.
  function importCloud(parsed, fileName = 'file') {
    const isMesh = !!parsed.idx
    const n = isMesh ? (parsed.nVerts ?? 0) : (parsed.count ?? 0)
    if (!n) {
      log(`Cloud import: ${fileName} contained no points`, 'warn', 'Reconstruction')
      return false
    }
    const pos = parsed.pos instanceof Float64Array ? parsed.pos : Float64Array.from(parsed.pos)
    const cloud = {
      id: makeCloudId(),
      name: `Imported (${fileName})`,
      kind: isMesh ? 'mesh' : 'dense',
      createdAt: Date.now(),
      imported: true,
      cameras: markRaw(new Map()),
      pos: markRaw(pos),
      ...(parsed.attributes ? { attributes: markRaw(parsed.attributes) } : {}),
      ...(parsed.col ? { col: markRaw(parsed.col) } : { col: null }),
      ...(isMesh
        ? { nVerts: n, count: parsed.count, idx: markRaw(parsed.idx) }
        : { count: n, ...(parsed.nrm ? { nrm: markRaw(parsed.nrm) } : {}) }),
    }
    clouds.value.push(cloud)
    selectedCloudId.value = cloud.id
    log(
      `Cloud import: added "${cloud.name}" — ${n.toLocaleString()} ${isMesh ? `vertices, ${parsed.count.toLocaleString()} triangles` : 'points'}` +
        `${parsed.col ? ', color' : ''}${parsed.nrm ? ', normals' : ''}`,
      'success',
      'Reconstruction',
    )
    save()
    return true
  }

  return {
    addMergedModel,
    importColmapModel,
    importInteropModel,
    importCloud,
  }
}
