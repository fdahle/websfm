import { toRaw } from 'vue'
import { isStreamed } from '../../core/lod/streamed.js'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'
import {
  exportCloudFile,
  exportMeshFile,
  exportPointTiles as workerExportPointTiles,
  exportMeshTiles as workerExportMeshTiles,
} from '../../workers/computeClient.js'
import { downloadBlob, pickSaveTarget } from '../../utils/download.js'
import { buildTransformsJson } from '../../core/io/transforms.js'
import {
  reconstructionToJson,
  prepareCloudForExport,
  prepareMeshForExport,
  meshToGlbParts,
} from '../../core/products/exporters.js'
import { partsToBlob } from '../../utils/blobParts.js'
import {
  cloudCentroid,
  ecefTransformFromProbes,
  cloudToGlbPoints,
  localBounds,
  buildTileset,
  boundingBox,
  tilesSubject,
  defaultTiling,
  singleTileFits,
} from '../../core/products/tiles3d.js'
import { exportOrigin, lasEpsg } from '../../core/lod/tiles3d.js'
import { EXPORT_DEFAULTS } from '../../core/defaults.user.js'
import { EXPORT_TUNING } from '../../core/tuning.js'
import { estimateExportBytes } from '../../core/io/exportSize.js'
import { ensureProjection, transformAsync, metresPerCrsUnit } from '../../core/crs.js'
import { zipParts } from '../../utils/zip.js'
import { makeFrameModelResolver } from '../../core/sfm/displayFrame.js'
import { hasDistortion } from '../../core/sfm/distortion.js'
import { MAX_FLOAT64_XYZ_POINTS, tooManyPointsMessage } from '../../core/bufferLimit.js'
import { pluralize } from '../../core/textFormat.js'
import { defaultExportName, exportFileName } from '../../core/exportNames.js'

// Point cloud, mesh, model JSON and 3D Tiles exports, split out of useExports. A
// cloud is written in the frame THE resolver gives it (exportSimilarity): the CRS
// with a georeference, metric with scale bars only, raw SfM coordinates otherwise.
//
// Deps are useExports' injected refs and shared helpers.
export function createCloudExports({
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
  sensors = null,
  summary = null,
}) {
  // The main sparse cloud (what downstream stages consume — MC), or the selected
  // cloud if it carries cameras. Shared by the two model exporters.
  function sparseCloud() {
    return mainSparseCloud.value ?? (selectedCloud.value?.cameras?.size ? selectedCloud.value : null)
  }

  // Point cloud (selected, else the first non-empty) → PLY / LAS / LAZ / XYZ, with an
  // optional georeference transform (the stored Horn fit → project CRS) and an
  // optional voxel downsample (cell in target-frame units, applied after georef).
  const cloudHasPoints = (c) => c && (c.kind === 'dense' ? c.count > 0 : c.points?.length > 0)
  // Normalize either cloud shape to flat Float64 positions + colours (the 3D Tiles
  // export's input; its glb is built on this thread).
  function toFlatCloud(src) {
    if (src && src.pos) {
      const count = src.count ?? src.pos.length / 3
      // One copy per attribute: a restored cloud's attributes are views into ONE
      // shared sidecar buffer, and a transfer list may not name a buffer twice.
      const attributes =
        src.attributes && Object.keys(src.attributes).length
          ? Object.fromEntries(Object.entries(src.attributes).map(([k, v]) => [k, v.slice(0, count)]))
          : null
      // The result is one Float64 xyz plane, so it holds at most the buffer wall's
      // worth of points (core/bufferLimit.js): refuse a larger cloud with the reason
      // rather than fail on the allocation.
      if (count > MAX_FLOAT64_XYZ_POINTS) throw new Error(tooManyPointsMessage('This cloud', count))
      // A cloud prepared relative to `origin` (flatAxes.js) is made absolute again.
      const pos = new Float64Array(src.pos.subarray(0, count * 3))
      if (src.origin) for (let i = 0; i < pos.length; i++) pos[i] += src.origin[i % 3]
      return {
        count,
        pos,
        col: src.col ? new Uint8Array(src.col.subarray(0, count * 3)) : null,
        ...(attributes ? { attributes } : {}),
      }
    }
    // A sparse cloud (SparsePoints): colourless points at the writers' 200 grey.
    const flat = src.flatCopy()
    return { ...flat, col: flat.col ?? new Uint8Array(flat.count * 3).fill(200) }
  }

  // A cloud as the flat shape the export worker takes, every array a COPY (the
  // worker call transfers them, and a detached store cloud would be far worse than
  // one extra buffer during an export the user asked for). Unlike toFlatCloud this
  // keeps everything a writer could emit — normals, attributes, the source array
  // types — so the file is byte-identical to writing the store cloud directly. A
  // sparse cloud gets a colour plane when it has colour (colourless points at the
  // writers' 200 grey); it has no normals.
  function exportCloudCopy(cloud) {
    if (cloud.kind === 'dense') {
      const n = cloud.count
      const attributes =
        cloud.attributes && Object.keys(cloud.attributes).length
          ? Object.fromEntries(Object.entries(cloud.attributes).map(([k, v]) => [k, v.slice(0, n)]))
          : null
      return {
        count: n,
        pos: cloud.pos.slice(0, n * 3),
        ...(cloud.col ? { col: cloud.col.slice(0, n * 3) } : {}),
        ...(cloud.nrm ? { nrm: cloud.nrm.slice(0, n * 3) } : {}),
        ...(attributes ? { attributes } : {}),
      }
    }
    return cloud.points.flatCopy()
  }

  function logExportFrame(what, frame) {
    if (frame.source === 'georef') log(`${what} export: georeferenced to ${frame.crs}`, 'info', 'Export')
    else if (frame.source === 'scalebars') {
      log(
        `${what} export: scaled to metres (×${frame.sim.scale.toPrecision(6)}) ` +
          'from the scale bars — metric coordinates, no CRS',
        'info',
        'Export',
      )
    } else if (frame.source === 'orientation') {
      log(`${what} export: in the oriented local frame (Orient model) — model units, no CRS`, 'info', 'Export')
    }
  }

  // Serialization (and the georeference / downsample before it) runs in the export
  // worker, which streams the file into a Blob — see workers/ops/export.js.
  // The cloud a cloud export writes: the sidebar's target, else the selected cloud,
  // else the first with points.
  const exportCloudOf = (target) =>
    target ?? (cloudHasPoints(selectedCloud.value) ? selectedCloud.value : clouds.value.find(cloudHasPoints))
  // The mesh a mesh export writes: the target, else the selected mesh, else the first.
  const exportMeshOf = (target) =>
    target ??
    (selectedCloud.value?.kind === 'mesh'
      ? selectedCloud.value
      : clouds.value.find((c) => c.kind === 'mesh' && c.count > 0))
  // The default name of a cloud or mesh export (its File name field shows it).
  function cloudExportBase(kind, target = null) {
    if (kind === 'mesh') {
      const mesh = exportMeshOf(target)
      return target && mesh ? cloudFileBase(mesh, target) : `${projectBase()}-mesh`
    }
    const cloud = exportCloudOf(target)
    return cloud ? cloudFileBase(cloud, target) : projectBase()
  }

  // Where the export goes: a large one asks for its file first (pickSaveTarget, before
  // any await), and a small one, or a browser without the dialog, downloads.
  // → { save(blob) } or null when the user cancelled.
  async function saveTarget(filename, estimate, mime) {
    if (estimateExportBytes(estimate) < EXPORT_TUNING.savePickerMinMiB * 1024 ** 2) {
      return { save: (blob) => downloadBlob(filename, blob) }
    }
    const ext = filename.slice(filename.lastIndexOf('.'))
    const target = await pickSaveTarget(filename, [
      { description: `${ext.slice(1).toUpperCase()} file`, accept: { [mime]: [ext] } },
    ])
    if (!target) log(`Export of ${filename} cancelled`, 'info', 'Export')
    return target
  }

  async function doExportCloud({ format, includeColor, applyGeoref, downsampleCell, fileName }, target = null) {
    const cloud = exportCloudOf(target)
    if (!cloud) return
    const name = exportFileName(fileName, cloudFileBase(cloud, target))
    const ext = format === 'las' || format === 'laz' || format === 'xyz' ? format : 'ply'
    const out = await saveTarget(
      `${name}.${ext}`,
      { kind: 'cloud', format, points: cloud.count },
      format === 'xyz' || format === 'ply-ascii' ? 'text/plain' : 'application/octet-stream',
    )
    if (!out) return
    // A streamed cloud (core/lod/streamed.js) is written from its octree, node by node,
    // in its own coordinates (an imported LAS's own quantisation and projection).
    if (isStreamed(cloud)) {
      if (applyGeoref || downsampleCell > 0) {
        log(
          `Export: "${cloud.name}" is streamed, so it is written in its own coordinates` +
            `${downsampleCell > 0 ? ', without a downsample' : ''}`,
          'info',
          'Export',
        )
      }
      const { blob } = await useReconstructionStore().exportCloudLod(cloud, { format, color: includeColor })
      await out.save(blob)
      return
    }
    // Attributes (a computed distance, imported intensity/classification) ride along:
    // PLY and LAS write them, LAZ its standard LAS fields only (see core/io/laz.js).
    const frame = applyGeoref ? await exportSimilarity() : { sim: null, unit: 'model', crs: null, source: null }
    logExportFrame('Cloud', frame)
    // NEVER attach a CRS merely because the coordinates are metric: only a real
    // georeference names one.
    const m = frame.source === 'georef' && frame.crs ? /EPSG:(\d+)/i.exec(frame.crs) : null
    const crsCode = m ? Number(m[1]) : null
    const cell = downsampleCell > 0 ? downsampleCell : 0
    const copy = exportCloudCopy(cloud)
    let color = includeColor
    // A sparse cloud whose FIRST point has no colour: the writers decide "has colour"
    // from that point in two places (XYZ, and the georeference / downsample pass)
    // and per point everywhere else. Keep both rules.
    if (cloud.kind !== 'dense' && copy.col && !cloud.points.hasColorAt(0)) {
      if (frame.sim || cell) delete copy.col
      else if (format === 'xyz') color = false
    }
    const { blob } = await exportCloudFile(
      {
        cloud: copy,
        format,
        color,
        sim: frame.sim,
        cell,
        crsCode,
        geographic: crsCode === 4326,
      },
      { onLog: (msg, l, c) => log(msg, l, c ?? 'Export') },
    )
    await out.save(blob)
  }

  // Mesh (screened Poisson) → PLY (faces) / GLB / OBJ / STL, in the export worker.
  // Uses the selected mesh cloud, else the first mesh cloud.
  async function doExportMesh({ format, includeColor, includeTexture = true, applyGeoref, fileName }, target = null) {
    const cloud = exportMeshOf(target)
    if (!cloud) return
    const textured = includeTexture && !!(cloud.uv && cloud.texture)
    // The worker's extension rule (workers/ops/export.js exportMesh): a textured OBJ is a
    // zip of the .obj, its .mtl and the atlas pages.
    const ext =
      format === 'obj' && textured && cloud.texture.pages?.length
        ? 'zip'
        : ['glb', 'obj', 'stl'].includes(format)
          ? format
          : 'ply'
    const base = exportFileName(fileName, cloudExportBase('mesh', target))
    const out = await saveTarget(
      `${base}.${ext}`,
      { kind: 'mesh', format, vertices: cloud.nVerts, triangles: cloud.count },
      { zip: 'application/zip', glb: 'model/gltf-binary', stl: 'model/stl' }[ext] ??
        (format === 'obj' || format === 'ply-ascii' ? 'text/plain' : 'application/octet-stream'),
    )
    if (!out) return
    const frame = applyGeoref ? await exportSimilarity() : { sim: null, unit: 'model', crs: null, source: null }
    logExportFrame('Mesh', frame)
    const mesh = {
      nVerts: cloud.nVerts,
      count: cloud.count,
      pos: cloud.pos.slice(),
      idx: cloud.idx.slice(),
      ...(cloud.col ? { col: cloud.col.slice() } : {}),
      ...(textured ? { uv: cloud.uv.slice() } : {}),
    }
    const texture = textured
      ? {
          data: cloud.texture.data.slice(),
          pages: cloud.texture.pages.map((p) => ({ ...p })),
          groups: cloud.texture.groups.map((g) => ({ ...g })),
        }
      : null
    const { blob } = await exportMeshFile(
      { mesh, format, color: includeColor, sim: frame.sim, texture, name: base },
      { onLog: (msg, l, c) => log(msg, l, c ?? 'Export') },
    )
    await out.save(blob)
  }

  // SfM cameras → websfm JSON (cameras + optional tracks), or a NeRF/3DGS
  // transforms.json (camera-to-world OpenGL poses + intrinsics). Both use the
  // sparse cloud; transforms.json needs each camera's loaded image (width/height).
  function doExportModel({ format, includeTracks, fileName }) {
    const cloud = sparseCloud()
    if (!cloud) return
    const name = exportFileName(fileName, defaultExportName('model', { format, base: projectBase() }))
    if (format === 'transforms') {
      const imgByUuid = new Map(images.value.map((im) => [im.uuid, im]))
      // transforms.json pairs each photo with a pinhole K. A lens with distortion, a
      // self-calibrated radial term or a film scan's fiducial frame means the photos
      // are NOT that pinhole image: the poses would be right and every pixel wrong.
      // Those projects get transforms.json from Export ▸ Undistorted images instead.
      const frameModel = makeFrameModelResolver({
        summary: toRaw(summary?.value ?? null),
        sensors: sensors?.value ?? [],
      })
      let warped = 0
      const transformImages = [...cloud.cameras.entries()]
        .map(([uuid, cam]) => {
          const im = imgByUuid.get(uuid)
          if (!im || !cam.K || !im.meta?.width || !im.meta?.height) return null
          const f = frameModel(im)
          if (hasDistortion(f.dist) || f.selfCal || f.fiducial || f.filmMissing) warped++
          return { name: im.name, R: cam.R, t: cam.t, K: cam.K, width: im.meta.width, height: im.meta.height }
        })
        .filter(Boolean)
      if (!transformImages.length) return
      if (warped) {
        log(
          `transforms.json export: ${warped} of ${pluralize(transformImages.length, 'image')} ${warped === 1 ? 'is not a pinhole image' : 'are not pinhole images'} (lens ` +
            'distortion, self-calibrated radial terms or a film scan), so their pixels would not match the cameras. ' +
            'Use Export ▸ Undistorted images, which writes the undistorted images with their own transforms.json.',
          'error',
          'Export',
        )
        return
      }
      saveJson(buildTransformsJson({ images: transformImages }), `${name}.json`)
      log(`transforms.json export: ${pluralize(transformImages.length, 'camera')}`, 'success', 'Export')
      return
    }
    const cams = [...cloud.cameras.entries()].map(([uuid, c]) => ({ uuid, R: c.R, t: c.t, K: c.K }))
    // The points are written one at a time from the cloud itself (a lazyArray), never
    // copied into a second per-point structure first.
    saveJson(reconstructionToJson(cams, cloud.points, currentCrs.value, { tracks: !!includeTracks }), `${name}.json`)
  }

  // Sparse model → COLMAP text model (cameras/images/points3D.txt) zipped into
  // one download. One PINHOLE camera per image. The exported K/R/t are in the
  // BA (pinhole) frame, so the 2D observations MUST be too: prefer the cloud's
  // view pixels (the BA-frame pixels the SfM run baked in — undistorted /
  // fiducial-canonical / self-cal-folded), and fall back to the store keypoints
  // only when they're absent (pure pinhole with no self-cal, where the two frames are
  // identical, or a legacy cloud persisted before they existed — which we warn
  // about, since a distorted/film/self-cal project would export inconsistently).
  // Only cameras with a matching loaded image + resolved K are exported (COLMAP
  // needs width/height/name). Output is in the local SfM frame.

  // ── Cesium 3D Tiles ─────────────────────────────────────────────────────────
  //
  // tileset.json + one .glb, or a hierarchy of tiles (level of detail): a cloud's
  // octree node by node (core/lod/tiles3d.js), a mesh split and decimated per level
  // (core/products/tiles3dMesh.js), both written in the compute worker. The placement
  // is shared: the tile transform maps local metres to ECEF, and it is *measured*
  // from probe points rather than assuming the project's grid axes are east/north.
  // That assumption is the usual shortcut and it fails precisely here — near the
  // poles a projected CRS's convergence approaches the longitude difference itself.
  //
  // The tile transform for a tile-local origin in the project CRS, or null (logged)
  // when the project has no georeference.
  async function tileTransform(origin, crs) {
    if (!crs || crs === 'local') {
      log(
        '3D Tiles: no georeference — the tileset has no place on the globe. ' +
          'Georeference the model first for a viewer to position it.',
        'warn',
        'Export',
      )
      return null
    }
    await ensureProjection(crs)
    // One project-CRS unit east and north of the origin. Both round-trip through
    // proj4, so the resulting basis carries the local rotation AND scale factor.
    const geo = async ([x, y, z]) => {
      const [lon, lat] = await transformAsync([x, y], crs, 'EPSG:4326')
      return { lon, lat, h: z * (metresPerCrsUnit(crs) ?? 1) }
    }
    return ecefTransformFromProbes({
      origin: await geo(origin),
      east: await geo([origin[0] + 1, origin[1], origin[2]]),
      north: await geo([origin[0], origin[1] + 1, origin[2]]),
      verticalMetresPerUnit: metresPerCrsUnit(crs) ?? 1,
    })
  }

  // settings { includeColor, tiling: 'lod' | 'single' | null (by size, defaultTiling),
  // tileTriangles }. The subject is tilesSubject's: the selected mesh, else a cloud.
  async function doExportTiles3d({
    includeColor = true,
    tiling = null,
    tileTriangles = EXPORT_DEFAULTS.tileTriangles,
    fileName,
  } = {}) {
    const subject = tilesSubject(selectedCloud.value, clouds.value)
    if (!subject) return
    const name = exportFileName(fileName, defaultExportName('tiles3d', { base: projectBase() }))
    const resolved = await effectiveFrameSpec?.()
    const g = resolved?.source === 'georef' ? { sim: resolved.frameSpec, crs: resolved.crs } : null
    let mode = tiling ?? defaultTiling(subject)
    if (mode === 'single' && !singleTileFits(subject)) {
      log(
        `3D Tiles export: "${subject.cloud.name}" is ${
          subject.streamed ? 'streamed' : 'too large for one tile'
        } — writing a hierarchy of tiles (level of detail) instead`,
        'info',
        'Export',
      )
      mode = 'lod'
    }
    if (subject.kind === 'mesh') {
      // A mesh is the tile (with its photo texture when it has one), or a tree of them.
      return mode === 'lod'
        ? exportMeshTiles(subject.cloud, g, includeColor, tileTriangles, name)
        : exportMeshTile(subject.cloud, g, includeColor, name)
    }
    const cloud = subject.cloud
    if (mode === 'lod') return exportCloudTiles(cloud, g, includeColor, name)
    // One tile: its positions are one Float64 plane and one GLB buffer, so past the
    // browser's buffer wall it cannot be built (core/bufferLimit.js; singleTileFits).
    const points = subject.count
    if (points > MAX_FLOAT64_XYZ_POINTS) {
      log(
        `3D Tiles export: ${tooManyPointsMessage(`"${cloud.name}"`, points)} Export it with Tiling ▸ Level of detail.`,
        'error',
        'Export',
      )
      return
    }

    const raw =
      cloud.kind === 'dense' ? { count: cloud.count, pos: cloud.pos, col: cloud.col } : cloud.points.flatCopy()
    // Georeference first: a tileset is only placeable in the project CRS.
    const src = toFlatCloud(prepareCloudForExport(raw, { sim: g?.sim ?? null, cell: 0, onLog: log }))

    const origin = cloudCentroid(src)
    const crs = g?.crs ?? null
    const transform = await tileTransform(origin, crs)

    const glb = cloudToGlbPoints(src, { origin, color: includeColor })
    const { min, max } = localBounds(src, origin)
    const tileset = buildTileset({
      transform,
      box: boundingBox(min, max),
      contentUri: 'content.glb',
    })
    const entries = [
      { name: 'tileset.json', data: JSON.stringify(tileset, null, 2) },
      { name: 'content.glb', data: glb },
    ]
    downloadBlob(`${name}.zip`, new Blob(await zipParts(entries), { type: 'application/zip' }))
    log(
      `3D Tiles export: ${src.count.toLocaleString()} points, ` +
        `${transform ? `placed in ${crs}` : 'local frame (unplaced)'}`,
      'success',
      'Export',
    )
  }

  // A cloud as a hierarchy of tiles, one per node of its level-of-detail octree. A
  // cloud with an octree (a streamed cloud, a big dense one) is read from its files,
  // node by node; any other is copied to the worker, which builds the octree there.
  // A streamed cloud is in its own coordinates, as its LAS/LAZ export: placed in the
  // CRS its file names, else the project's.
  async function exportCloudTiles(cloud, g, includeColor, name) {
    const store = useReconstructionStore()
    const streamed = isStreamed(cloud)
    let sim = g?.sim ?? null,
      crs = g?.crs ?? null
    if (streamed) {
      const epsg = lasEpsg(cloud.lod)
      sim = null
      crs = epsg ? `EPSG:${epsg}` : currentCrs.value && currentCrs.value !== 'local' ? currentCrs.value : null
      log(
        `3D Tiles export: "${cloud.name}" is streamed, so it is written in its own coordinates` +
          `${crs ? `, placed as ${crs}${epsg ? ' (from the file)' : ' (the project CRS)'}` : ''}`,
        'info',
        'Export',
      )
    }
    const plain = (s) => (s ? JSON.parse(JSON.stringify(s)) : null)
    let input
    if (cloud.lod && (streamed || cloud.lod.points === cloud.count)) {
      input = { bounds: cloud.lod.bounds }
    } else {
      const raw =
        cloud.kind === 'dense'
          ? { count: cloud.count, pos: cloud.pos, col: cloud.col, attributes: cloud.attributes }
          : cloud.points.flatCopy()
      if ((raw.count ?? raw.pos.length / 3) > MAX_FLOAT64_XYZ_POINTS) {
        log(
          `3D Tiles export: ${tooManyPointsMessage(`"${cloud.name}"`, raw.count)} Its level-of-detail octree is not built yet: ` +
            'save the project and wait for it, then export again.',
          'error',
          'Export',
        )
        return
      }
      const flat = toFlatCloud(raw)
      input = { cloud: flat, bounds: localBounds(flat) }
    }
    const origin = exportOrigin(input.bounds, sim)
    const transform = await placement(origin, crs)
    const opts = { sim: plain(sim), origin, transform, color: includeColor }
    const res = input.cloud
      ? await workerExportPointTiles(
          { cloud: input.cloud, ...opts },
          {
            onLog: (m, l, c) => log(m, l, c ?? 'Export'),
            transfer: [
              input.cloud.pos.buffer,
              ...(input.cloud.col ? [input.cloud.col.buffer] : []),
              ...Object.values(input.cloud.attributes ?? {}).map((a) => a.buffer),
            ],
          },
        )
      : await store.exportCloudTiles(cloud, opts)
    downloadBlob(`${name}.zip`, res.blob)
    log(
      `3D Tiles export: "${cloud.name}", ${res.points.toLocaleString()} points in ${res.contentTiles.toLocaleString()} tiles ` +
        `(${res.levels} levels), ${transform ? `placed in ${crs}` : 'local frame (unplaced)'}`,
      'success',
      'Export',
    )
  }

  // A mesh as a hierarchy of tiles: split in space, decimated per level, the leaves
  // the mesh itself (textured: with its texture).
  async function exportMeshTiles(cloud, g, includeColor, tileTriangles, name) {
    const textured = !!(cloud.uv && cloud.texture)
    const crs = g?.crs ?? null
    const vertices = { count: cloud.nVerts, pos: cloud.pos }
    const origin = exportOrigin(localBounds(vertices), g?.sim ?? null)
    const transform = await placement(origin, crs)
    const mesh = {
      nVerts: cloud.nVerts,
      count: cloud.count,
      pos: Float64Array.from(cloud.pos.subarray(0, 3 * cloud.nVerts)),
      idx: cloud.idx.slice(),
      ...(cloud.col ? { col: cloud.col.slice() } : {}),
      ...(textured ? { uv: cloud.uv.slice() } : {}),
    }
    const texture = textured
      ? {
          data: cloud.texture.data.slice(),
          pages: cloud.texture.pages.map((p) => ({ ...p })),
          groups: cloud.texture.groups.map((x) => ({ ...x })),
        }
      : null
    const res = await workerExportMeshTiles(
      {
        mesh,
        texture,
        sim: g?.sim ? JSON.parse(JSON.stringify(g.sim)) : null,
        origin,
        transform,
        color: includeColor,
        tileTriangles,
      },
      {
        onLog: (m, l, c) => log(m, l, c ?? 'Export'),
        transfer: [
          mesh.pos.buffer,
          mesh.idx.buffer,
          ...(mesh.col ? [mesh.col.buffer] : []),
          ...(mesh.uv ? [mesh.uv.buffer] : []),
          ...(texture ? [texture.data.buffer] : []),
        ],
      },
    )
    downloadBlob(`${name}.zip`, res.blob)
    log(
      `3D Tiles export: mesh "${cloud.name}", ${cloud.count.toLocaleString()} triangles in ${res.tiles.toLocaleString()} tiles ` +
        `(${res.levels} levels${res.textured ? ', textured leaves' : ''}), ${transform ? `placed in ${crs}` : 'local frame (unplaced)'}`,
      'success',
      'Export',
    )
  }

  // The tile transform, or null when there is no CRS or it cannot be loaded (logged).
  async function placement(origin, crs) {
    try {
      return await tileTransform(origin, crs)
    } catch (err) {
      log(
        `3D Tiles: ${crs} could not be loaded (${err?.message ?? err}) — the tileset has no place on the globe`,
        'warn',
        'Export',
      )
      return null
    }
  }

  // A mesh as the tile: tile-local, Y-up GLB triangles (textured: its atlas pages
  // embedded, unlit), placed like a cloud tile.
  async function exportMeshTile(cloud, g, includeColor, name) {
    const textured = !!(cloud.uv && cloud.texture)
    const mesh = prepareMeshForExport(
      {
        nVerts: cloud.nVerts,
        count: cloud.count,
        pos: cloud.pos,
        idx: cloud.idx,
        col: cloud.col ?? null,
        uv: cloud.uv ?? null,
      },
      { sim: g?.sim ?? null },
    )
    const vertices = { count: mesh.nVerts, pos: mesh.pos }
    const origin = cloudCentroid(vertices)
    const crs = g?.crs ?? null
    const transform = await tileTransform(origin, crs)
    const texture = textured
      ? {
          pages: cloud.texture.pages.map((p) => ({
            type: p.type,
            bytes: cloud.texture.data.subarray(p.offset, p.offset + p.length),
          })),
          groups: cloud.texture.groups,
        }
      : null
    const glb = partsToBlob(
      meshToGlbParts(mesh, { color: includeColor, texture, origin, yUp: true }),
      'model/gltf-binary',
    )
    const { min, max } = localBounds(vertices, origin)
    const tileset = buildTileset({ transform, box: boundingBox(min, max), contentUri: 'content.glb' })
    const entries = [
      { name: 'tileset.json', data: JSON.stringify(tileset, null, 2) },
      { name: 'content.glb', data: glb },
    ]
    downloadBlob(`${name}.zip`, new Blob(await zipParts(entries), { type: 'application/zip' }))
    log(
      `3D Tiles export: mesh "${cloud.name}", ${cloud.count.toLocaleString()} triangles` +
        `${textured ? `, ${texture.pages.length} texture page${texture.pages.length === 1 ? '' : 's'}` : ''}, ` +
        `${transform ? `placed in ${crs}` : 'local frame (unplaced)'}`,
      'success',
      'Export',
    )
  }

  return {
    sparseCloud,
    toFlatCloud,
    exportCloudCopy,
    logExportFrame,
    doExportCloud,
    doExportMesh,
    doExportModel,
    doExportTiles3d,
    cloudExportBase,
    cloudHasPoints,
  }
}
