import { exportCloudFile, exportMeshFile } from '../../workers/computeClient.js'
import { downloadBlob } from '../../utils/download.js'
import { buildTransformsJson } from '../../core/io/transforms.js'
import { reconstructionToJson, prepareCloudForExport, prepareMeshForExport, meshToGlbParts } from '../../core/products/exporters.js'
import { partsToBlob } from '../../utils/blobParts.js'
import { cloudCentroid, ecefTransformFromProbes, cloudToGlbPoints, localBounds, buildTileset, boundingBox } from '../../core/products/tiles3d.js'
import { ensureProjection, transformAsync, metresPerCrsUnit } from '../../core/crs.js'
import { zipParts } from '../../utils/zip.js'

// Point cloud, mesh, model JSON and 3D Tiles exports, split out of useExports. A
// cloud is written in the frame THE resolver gives it (exportSimilarity): the CRS
// with a georeference, metric with scale bars only, raw SfM coordinates otherwise.
//
// Deps are useExports' injected refs and shared helpers.
export function createCloudExports({
  cloudFileBase, clouds, currentCrs, effectiveFrameSpec, exportSimilarity, images, log,
  mainSparseCloud, projectBase, saveJson, selectedCloud,
}) {
  // The main sparse cloud (what downstream stages consume — MC), or the selected
  // cloud if it carries cameras. Shared by the two model exporters.
  function sparseCloud() {
    return mainSparseCloud.value
      ?? (selectedCloud.value?.cameras?.size ? selectedCloud.value : null)
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
      const attributes = src.attributes && Object.keys(src.attributes).length
        ? Object.fromEntries(Object.entries(src.attributes).map(([k, v]) => [k, v.slice(0, count)]))
        : null
      return {
        count,
        pos: new Float64Array(src.pos.subarray(0, count * 3)),
        col: src.col ? new Uint8Array(src.col.subarray(0, count * 3)) : null,
        ...(attributes ? { attributes } : {}),
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

  // A cloud as the flat shape the export worker takes, every array a COPY (the
  // worker call transfers them, and a detached store cloud would be far worse than
  // one extra buffer during an export the user asked for). Unlike toFlatCloud this
  // keeps everything a writer could emit — normals, attributes, the source array
  // types — so the file is byte-identical to writing the store cloud directly. A
  // sparse cloud gets a colour plane when any point is coloured (the rest at the
  // writers' 200 grey) and a normal plane when its first point has one (the
  // writers' own test).
  function exportCloudCopy(cloud) {
    if (cloud.kind === 'dense') {
      const n = cloud.count
      const attributes = cloud.attributes && Object.keys(cloud.attributes).length
        ? Object.fromEntries(Object.entries(cloud.attributes).map(([k, v]) => [k, v.slice(0, n)])) : null
      return {
        count: n, pos: cloud.pos.slice(0, n * 3),
        ...(cloud.col ? { col: cloud.col.slice(0, n * 3) } : {}),
        ...(cloud.nrm ? { nrm: cloud.nrm.slice(0, n * 3) } : {}),
        ...(attributes ? { attributes } : {}),
      }
    }
    const pts = cloud.points, n = pts.length
    const byte = (v) => Math.max(0, Math.min(255, Math.round(v ?? 0)))
    const pos = new Float64Array(n * 3)
    const col = pts.some((p) => p.color) ? new Uint8Array(n * 3) : null
    const nrm = n && pts[0]?.normal ? new Float64Array(n * 3) : null
    for (let i = 0; i < n; i++) {
      const p = pts[i]
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z
      if (col) { const c = p.color || [200, 200, 200]; col[i * 3] = byte(c[0]); col[i * 3 + 1] = byte(c[1]); col[i * 3 + 2] = byte(c[2]) }
      if (nrm && p.normal) { nrm[i * 3] = p.normal[0]; nrm[i * 3 + 1] = p.normal[1]; nrm[i * 3 + 2] = p.normal[2] }
    }
    return { count: n, pos, ...(col ? { col } : {}), ...(nrm ? { nrm } : {}) }
  }

  function logExportFrame(what, frame) {
    if (frame.source === 'georef') log(`${what} export: georeferenced to ${frame.crs}`, 'info', 'Export')
    else if (frame.source === 'scalebars') {
      log(`${what} export: scaled to metres (×${frame.sim.scale.toPrecision(6)}) `
        + 'from the scale bars — metric coordinates, no CRS', 'info', 'Export')
    } else if (frame.source === 'orientation') {
      log(`${what} export: in the oriented local frame (Orient model) — model units, no CRS`, 'info', 'Export')
    }
  }

  // Serialization (and the georeference / downsample before it) runs in the export
  // worker, which streams the file into a Blob — see workers/ops/export.js.
  async function doExportCloud({ format, includeColor, applyGeoref, downsampleCell }, target = null) {
    const cloud = target ?? (cloudHasPoints(selectedCloud.value)
      ? selectedCloud.value
      : clouds.value.find(cloudHasPoints))
    if (!cloud) return
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
    if (cloud.kind !== 'dense' && copy.col && !cloud.points[0]?.color) {
      if (frame.sim || cell) delete copy.col
      else if (format === 'xyz') color = false
    }
    const { blob } = await exportCloudFile({
      cloud: copy, format, color, sim: frame.sim, cell, crsCode, geographic: crsCode === 4326,
    }, { onLog: (msg, l, c) => log(msg, l, c ?? 'Export') })
    const ext = format === 'las' || format === 'laz' || format === 'xyz' ? format : 'ply'
    downloadBlob(`${cloudFileBase(cloud, target)}.${ext}`, blob)
  }

  // Mesh (screened Poisson) → PLY (faces) / GLB / OBJ / STL, in the export worker.
  // Uses the selected mesh cloud, else the first mesh cloud.
  async function doExportMesh({ format, includeColor, includeTexture = true, applyGeoref }, target = null) {
    const cloud = target ?? (selectedCloud.value?.kind === 'mesh'
      ? selectedCloud.value
      : clouds.value.find((c) => c.kind === 'mesh' && c.count > 0))
    if (!cloud) return
    const frame = applyGeoref ? await exportSimilarity() : { sim: null, unit: 'model', crs: null, source: null }
    logExportFrame('Mesh', frame)
    const textured = includeTexture && !!(cloud.uv && cloud.texture)
    const mesh = { nVerts: cloud.nVerts, count: cloud.count, pos: cloud.pos.slice(), idx: cloud.idx.slice(),
      ...(cloud.col ? { col: cloud.col.slice() } : {}), ...(textured ? { uv: cloud.uv.slice() } : {}) }
    const texture = textured
      ? { data: cloud.texture.data.slice(), pages: cloud.texture.pages.map((p) => ({ ...p })), groups: cloud.texture.groups.map((g) => ({ ...g })) }
      : null
    const base = target ? cloudFileBase(cloud, target) : `${projectBase()}-mesh`
    const { blob, ext } = await exportMeshFile({ mesh, format, color: includeColor, sim: frame.sim, texture, name: base },
      { onLog: (msg, l, c) => log(msg, l, c ?? 'Export') })
    downloadBlob(`${base}.${ext}`, blob)
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
    // The points are written one at a time from the cloud itself (a lazyArray), never
    // copied into a second per-point structure first.
    saveJson(reconstructionToJson(cams, cloud.points, currentCrs.value, { tracks: !!includeTracks }),
      `${projectBase()}-model.json`)
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

  // ── Cesium 3D Tiles (single tile) ───────────────────────────────────────────
  //
  // tileset.json + one .glb. The only real content is the placement: the tile
  // transform maps local metres to ECEF, and it is *measured* from probe points
  // rather than assuming the project's grid axes are east/north. That assumption
  // is the usual shortcut and it fails precisely here — near the poles a
  // projected CRS's convergence approaches the longitude difference itself.
  //
  // LOD tiling is deliberately not attempted: the export is one tile.
  // The tile transform for a tile-local origin in the project CRS, or null (logged)
  // when the project has no georeference.
  async function tileTransform(origin, crs) {
    if (!crs || crs === 'local') {
      log('3D Tiles: no georeference — the tileset has no place on the globe. '
        + 'Georeference the model first for a viewer to position it.', 'warn', 'Export')
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

  async function doExportTiles3d({ includeColor = true } = {}) {
    const resolved = await effectiveFrameSpec?.()
    const g = resolved?.source === 'georef' ? { sim: resolved.frameSpec, crs: resolved.crs } : null
    // A selected mesh is the tile (with its photo texture when it has one).
    if (selectedCloud.value?.kind === 'mesh' && selectedCloud.value.count > 0) {
      return exportMeshTile(selectedCloud.value, g, includeColor)
    }
    const cloud = cloudHasPoints(selectedCloud.value)
      ? selectedCloud.value
      : clouds.value.find(cloudHasPoints)
    if (!cloud) return

    const raw = cloud.kind === 'dense'
      ? { count: cloud.count, pos: cloud.pos, col: cloud.col }
      : cloud.points
    // Georeference first: a tileset is only placeable in the project CRS.
    const src = toFlatCloud(prepareCloudForExport(raw, { sim: g?.sim ?? null, cell: 0, onLog: log }))

    const origin = cloudCentroid(src)
    const crs = g?.crs ?? null
    const transform = await tileTransform(origin, crs)

    const glb = cloudToGlbPoints(src, { origin, color: includeColor })
    const { min, max } = localBounds(src, origin)
    const tileset = buildTileset({
      transform, box: boundingBox(min, max), contentUri: 'content.glb',
    })
    const entries = [
      { name: 'tileset.json', data: JSON.stringify(tileset, null, 2) },
      { name: 'content.glb', data: glb },
    ]
    downloadBlob(`${projectBase()}-3dtiles.zip`, new Blob(await zipParts(entries), { type: 'application/zip' }))
    log(`3D Tiles export: ${src.count.toLocaleString()} points, `
      + `${transform ? `placed in ${crs}` : 'local frame (unplaced)'}`, 'success', 'Export')
  }

  // A mesh as the tile: tile-local, Y-up GLB triangles (textured: its atlas pages
  // embedded, unlit), placed like a cloud tile.
  async function exportMeshTile(cloud, g, includeColor) {
    const textured = !!(cloud.uv && cloud.texture)
    const mesh = prepareMeshForExport({ nVerts: cloud.nVerts, count: cloud.count, pos: cloud.pos, idx: cloud.idx,
      col: cloud.col ?? null, uv: cloud.uv ?? null }, { sim: g?.sim ?? null })
    const vertices = { count: mesh.nVerts, pos: mesh.pos }
    const origin = cloudCentroid(vertices)
    const crs = g?.crs ?? null
    const transform = await tileTransform(origin, crs)
    const texture = textured ? {
      pages: cloud.texture.pages.map((p) => ({ type: p.type, bytes: cloud.texture.data.subarray(p.offset, p.offset + p.length) })),
      groups: cloud.texture.groups,
    } : null
    const glb = partsToBlob(meshToGlbParts(mesh, { color: includeColor, texture, origin, yUp: true }), 'model/gltf-binary')
    const { min, max } = localBounds(vertices, origin)
    const tileset = buildTileset({ transform, box: boundingBox(min, max), contentUri: 'content.glb' })
    const entries = [
      { name: 'tileset.json', data: JSON.stringify(tileset, null, 2) },
      { name: 'content.glb', data: glb },
    ]
    downloadBlob(`${projectBase()}-3dtiles.zip`, new Blob(await zipParts(entries), { type: 'application/zip' }))
    log(`3D Tiles export: mesh "${cloud.name}", ${cloud.count.toLocaleString()} triangles`
      + `${textured ? `, ${texture.pages.length} texture page${texture.pages.length === 1 ? '' : 's'}` : ''}, `
      + `${transform ? `placed in ${crs}` : 'local frame (unplaced)'}`, 'success', 'Export')
  }

  return {
    sparseCloud, toFlatCloud, exportCloudCopy, logExportFrame, doExportCloud, doExportMesh,
    doExportModel, doExportTiles3d, cloudHasPoints,
  }
}
