// Reconstructions (sparse and dense clouds, meshes) and level-of-detail octrees.
import { trackPersistence, persistenceLock, ignoreMissing } from '../persistence.js'
import { writeBinaryDocument, readBinaryDocument } from '../binaryDocument.js'
import { mapConcurrent } from '../concurrency.js'
import { getProjectDir, getRoot, getSubDir, readBin, writeBin, writeJson } from './base.js'

// ── Reconstruction ────────────────────────────────────────────────────────────
// Metadata → reconstruction.json (version 3):
//   { version: 3, binaryFiles: { key: { name, bytes } }, clouds: [{ id, name, kind, createdAt, pointCount, hasColor,
//       cameras: [{ uuid, R, t, K }], viewUuids: [uuid, …] }],
//     georef, summary, denseSummary }
// The heavy per-point data lives in binary sidecars, one set per cloud, named
// `reconstruction.json.{generation}.{cloudId}.{key}.bin`:
//   pos    Float64  3·N   x,y,z (world-frame precision)
//   col    Uint8    3·N   r,g,b (present only when hasColor)
//   colorMask Uint8 N     1 when a sparse point has colour; absent on legacy saves
//   nrm    Float32  3·N   world-space unit normals (dense-only; Poisson mesh input;
//                         absent on old projects / normal-less runs — do NOT heal)
//   idx    Uint32   3·T   triangle vertex indices (mesh clouds only)
//   uv     Float32  2·N   texture coordinates (textured meshes only, hasUv)
//   texture Uint8   —     the atlas pages' JPEG bytes, sliced by meta texture.pages
//   vcount Uint32   N     view-tracks per point (CSR row lengths)
//   vcam   Uint32   ΣV    camera index into the cloud's viewUuids, per view
//   vkp    Uint32   ΣV    keypoint index, per view
// This replaces a multi-MB JSON.parse (which froze the main thread on open) with
// a transferable typed-array read. The store passes each cloud's typed arrays as
// `buffers: { pos, col, colorMask, nrm, idx, vcount, vcam, vkp, vx, vy }` (ArrayBuffers); load
// returns them the same way for the store to rebuild the point objects. vx/vy carry
// per-view BA-frame pixels (COLMAP export) and are absent on dense/legacy clouds.
//
// A cloud whose buffers are unchanged since an earlier save passes
// `reuse: { key: { name, bytes } }` instead (the files that save committed, as returned
// here or by loadReconstruction's `savedFiles`), so an edit to one 25 M-point cloud
// does not rewrite every other. Returns `{ ok: true, files: { cloudId: { key: file } } }`,
// or `{ ok: false, stale: [cloudId] }` — nothing written — when a reused file has gone
// (another tab's save collected it); the caller then resends those clouds' buffers.
const RECON_BIN_KEYS = [
  'pos',
  'col',
  'colorMask',
  'nrm',
  'idx',
  'uv',
  'texture',
  'vcount',
  'vcam',
  'vkp',
  'vx',
  'vy',
  'attributes',
]

export async function saveReconstruction(projectId, data) {
  return trackPersistence('saveReconstruction:' + String(projectId), async () => {
    return persistenceLock(`reconstruction:${projectId}`, async () => {
      const dir = await getProjectDir(projectId, true)
      const { clouds = [], ...rest } = data
      const meta = { ...rest, version: 3, clouds: [] }
      const buffers = {}
      for (const c of clouds) {
        const { buffers: cloudBuffers, reuse, ...cmeta } = c
        meta.clouds.push(cmeta)
        for (const key of RECON_BIN_KEYS) {
          if (reuse?.[key]) buffers[`${c.id}.${key}`] = { reuse: reuse[key] }
          else if (cloudBuffers?.[key]) buffers[`${c.id}.${key}`] = cloudBuffers[key]
        }
      }
      const res = await writeBinaryDocument(dir, 'reconstruction.json', meta, buffers, { writeJson, writeBin })
      if (res.stale) {
        return { ok: false, stale: [...new Set(res.stale.map((k) => k.slice(0, k.lastIndexOf('.'))))] }
      }
      return { ok: true, files: filesByCloud(res.files) }
    })
  })
}

// `{ "cloudId.key": file }` → `{ cloudId: { key: file } }` (cloud ids may contain dots;
// buffer keys never do).
function filesByCloud(files) {
  const out = {}
  for (const [k, file] of Object.entries(files)) {
    const dot = k.lastIndexOf('.')
    ;(out[k.slice(0, dot)] ??= {})[k.slice(dot + 1)] = file
  }
  return out
}

// null means no model was ever saved. Anything else that stops the read (bad JSON,
// a missing or short buffer, a storage error) throws: the caller must not mistake
// an unreadable model for an empty one and then save the empty one over it.
export async function loadReconstruction(projectId) {
  return persistenceLock(`reconstruction:${projectId}`, async () => {
    let dir, file
    try {
      dir = await getProjectDir(projectId)
      file = await (await dir.getFileHandle('reconstruction.json')).getFile()
    } catch (error) {
      ignoreMissing(error)
      return null
    }
    const meta = JSON.parse(await file.text())
    if (!meta) return null
    if (meta.version !== 3) throw new Error(`unsupported document version ${meta.version ?? '(none)'}`)
    const saved = await readBinaryDocument(dir, meta, readBin)
    const savedFiles = filesByCloud(meta.binaryFiles)
    await mapConcurrent(meta.clouds || [], 3, async (c) => {
      const buffers = {}
      RECON_BIN_KEYS.forEach((key) => {
        buffers[key] = saved[`${c.id}.${key}`] ?? null
      })
      const n = c.pointCount ?? 0
      // A dense/mesh pos is stored at its in-memory width (Float32 = 12 bytes per
      // point, Float64 = 24; cloudSerde posArray); a sparse pos is always Float64.
      const posBytes = buffers.pos?.byteLength ?? 0
      const posOk =
        posBytes === n * 24 ||
        (c.kind !== 'sparse' && c.kind != null && posBytes === n * 12) ||
        // A streamed cloud's points are only in its octree (lod/), never here.
        (c.kind === 'dense' && c.streamed && c.lod && posBytes === 0)
      if (
        !Number.isSafeInteger(n) ||
        n < 0 ||
        !posOk ||
        (c.hasColor && buffers.col?.byteLength !== n * 3) ||
        (c.hasNormals && buffers.nrm?.byteLength !== n * 12) ||
        (c.kind === 'mesh' && buffers.idx?.byteLength !== (c.triCount ?? 0) * 12) ||
        (c.hasUv && (buffers.uv?.byteLength !== n * 8 || buffers.texture?.byteLength !== c.texture?.bytes))
      ) {
        throw new Error('Incomplete saved reconstruction')
      }
      c.buffers = buffers
      // The committed files behind these buffers, so the store's next save can reuse
      // them for a cloud it has not changed (see saveReconstruction).
      if (savedFiles[c.id]) c.savedFiles = savedFiles[c.id]
    })
    delete meta.binaryFiles
    return meta
  })
}

export async function deleteReconstruction(projectId) {
  return trackPersistence('deleteReconstruction:' + String(projectId), () =>
    persistenceLock(`reconstruction:${projectId}`, async () => {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('reconstruction.json').catch(ignoreMissing)
      if (dir.keys)
        for await (const name of dir.keys()) {
          if (name.startsWith('reconstruction.json.') && name.endsWith('.bin'))
            await dir.removeEntry(name).catch(ignoreMissing)
        }
    }),
  )
}

// ── Level-of-detail octrees (dev/planning/plan-lod.md) ──────────────────────
// lod/{name}.lod (the nodes' points) + lod/{name}.hier (the hierarchy), one pair per
// octree; a cloud's metadata names its pair (`cloud.lod.dataFile` / `hierarchyFile`).
// An imported COPC file is kept as lod/{name}.copc.laz, its own octree (no .hier).
// Kept by "exclude derived data": a streamed cloud's octree is its only copy.

export async function lodDir(projectId) {
  return getSubDir(projectId, 'lod')
}

export async function loadLodFile(projectId, name) {
  const dir = await getSubDir(projectId, 'lod')
  return (await dir.getFileHandle(name)).getFile()
}

// Remove every octree file not named in `keepNames`, and chunk files left in OPFS by
// a build that never finished (a closed tab) unless `building`.
export async function pruneLodFiles(projectId, keepNames, { building = false } = {}) {
  return trackPersistence('pruneLodFiles:' + String(projectId), async () => {
    const dir = await getSubDir(projectId, 'lod')
    const stale = []
    for await (const name of dir.keys())
      if (/\.(lod|hier)$|\.copc\.laz$/.test(name) && !keepNames.has(name)) stale.push(name)
    for (const name of stale) await dir.removeEntry(name).catch(ignoreMissing)
    if (!building) {
      const root = await getRoot()
      await root.removeEntry('tmp', { recursive: true }).catch(ignoreMissing)
    }
    return stale.length
  })
}
