import { markRaw } from 'vue'
import { textureMesh as workerTextureMesh } from '../../workers/computeClient.js'
import { computeSourceOf } from '../../utils/image.js'

// Tools ▸ Mesh ▾ ▸ Texture (dev/planning/plan-texture.md): a NEW mesh with per-vertex
// UVs and JPEG atlas pages, textured from the registered photos. Like every mesh tool
// it leaves its source alone.
export function createMeshTexture({
  addDerivedMesh, clouds, frameModelFor, images, imagesStore, log, mainSparseCloud, reconStatus, save,
}) {
  // { sourceId, settings, name } → the new cloud, or null (refused, failed, empty).
  async function textureMesh({ sourceId, settings = {}, name } = {}, onProgress) {
    const source = clouds.value.find((c) => c.id === sourceId && c.kind === 'mesh')
    if (!source?.count) {
      log('Texture: choose a mesh to texture', 'warn', 'Products')
      return null
    }
    const cameras = mainSparseCloud.value?.cameras
    if (!cameras?.size) {
      log('Texture: needs a sparse model with registered cameras', 'error', 'Products')
      return null
    }
    const frameModel = frameModelFor.value
    const views = []
    let unready = 0
    for (const im of images.value) {
      const cam = cameras.get(im.uuid)
      if (!cam) continue
      // A TIFF's lossless compute source may still be encoding right after ingest.
      try { await imagesStore.whenComputeReady(im) } catch { unready++; continue }
      const { dist, selfCal, fiducial } = frameModel(im)
      views.push({
        uuid: im.uuid, name: im.name, url: computeSourceOf(im),
        R: cam.R.map((row) => [...row]), t: [...cam.t],
        K: { fx: cam.K.fx, fy: cam.K.fy, cx: cam.K.cx, cy: cam.K.cy },
        // The photo in scan pixels; without metadata, the extent K implies.
        width: im.meta?.width || Math.round(2 * (cam.K.cx + 0.5)),
        height: im.meta?.height || Math.round(2 * (cam.K.cy + 0.5)),
        dist, selfCal, fiducial,
        mask: settings.useMasks !== false ? (im.mask?.blob ?? null) : null,
      })
    }
    if (unready) log(`Texture: ${unready} photo(s) not readable yet were left out`, 'warn', 'Products')
    if (!views.length) {
      log('Texture: no registered photo is available', 'error', 'Products')
      return null
    }
    const pos = source.pos.slice(), idx = source.idx.slice(), col = source.col?.slice() ?? null
    const transfer = [pos.buffer, idx.buffer]
    if (col) transfer.push(col.buffer)
    reconStatus.value = 'running'
    try {
      const res = await workerTextureMesh(
        { mesh: { pos, idx, col }, views, settings },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f), transfer },
      )
      const cloud = addDerivedMesh({ ...res.mesh, uv: res.mesh.uv, texture: res.texture }, {
        name: name || `${source.name} (textured)`, imported: !!source.imported,
      })
      cloud.textureSummary = { ...res.summary, sourceId: source.id, sourceName: source.name, settings }
      // Show the result in place of its source; the source stays one toggle away.
      source.visible = false
      log(`Texture: added "${cloud.name}"`, 'success', 'Products')
      reconStatus.value = 'done'
      await save()
      return cloud
    } catch (err) {
      log(`Texture error: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
      return null
    }
  }

  return { textureMesh }
}

// The atlas pages of a textured mesh as Blobs (the viewer and the exporters).
export function texturePageBlobs(texture) {
  if (!texture?.data || !texture.pages?.length) return []
  return texture.pages.map((p) => new Blob([texture.data.subarray(p.offset, p.offset + p.length)], { type: p.type }))
}

// Plain-object form of the texture for in-memory clouds (markRaw: large typed data).
export const rawTexture = (texture) => (texture ? markRaw({
  data: texture.data, pages: texture.pages.map((p) => ({ ...p })), groups: texture.groups.map((g) => ({ ...g })),
}) : null)
