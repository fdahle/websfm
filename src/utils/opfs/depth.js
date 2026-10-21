// Depth-map planes (Stage A) and their index.
import { trackPersistence, ignoreMissing } from '../persistence.js'
import { DEPTH_BIN_KEYS, planeBytes } from '../../core/dense/depthMapCodec.js'
import { getSubDir, readJson, writeBin, writeJson } from './base.js'

// ── Depth-map planes ──────────────────────────────────────────────────────────
// The dense Stage A output: minutes of PatchMatch per image, so it is persisted
// rather than recomputed (the one exception to "everything recomputable is
// recomputed" — see core/dense/depthMapCodec.js for the layout and why).
// Metadata → depthmaps/index.json:
//   { version: 1, sparseCloudId, sparseCreatedAt, settings,
//     maps: [{ uuid, width, height, K, R, t, hasNormals }] }
// The per-pixel planes go in sibling binaries, `{uuid}.{depth|cost|nrm|rgb}.bin`,
// so the store can read the index (tiny) on project open and hydrate the planes
// (hundreds of MB) only when densify / ortho actually need them.

async function removeStaleDepthBins(dir, keepUuids) {
  const stale = []
  for await (const name of dir.keys()) {
    const m = name.match(/^(.+)\.(?:depth|cost|nrm|rgb)\.bin$/)
    if (m && !keepUuids.has(m[1])) stale.push(name)
  }
  for (const name of stale) await dir.removeEntry(name).catch(ignoreMissing)
}

// `entries`: [{ uuid, buffers: { depth, cost, nrm, rgb } }] — buffers as
// ArrayBuffers (writing does not detach them, so the caller's cache stays live).
export async function saveDepthPlanes(projectId, index, entries) {
  return trackPersistence('saveDepthPlanes:' + String(projectId), async () => {
    const dir = await getSubDir(projectId, 'depthmaps')
    const keep = new Set()
    for (const { uuid, buffers } of entries) {
      keep.add(uuid)
      for (const key of DEPTH_BIN_KEYS) {
        const buf = buffers?.[key]
        const name = `${uuid}.${key}.bin`
        if (buf && buf.byteLength) await writeBin(dir, name, buf)
        else await dir.removeEntry(name).catch(ignoreMissing) // e.g. nrm absent
      }
    }
    await writeJson(dir, 'index.json', index)
    await removeStaleDepthBins(dir, keep) // drop planes of images no longer mapped
  })
}

// Streamed Stage A (TODO ▸ SC-4) writes one map's planes as it finishes and the
// index last, so a run that dies midway never leaves an index pointing at a
// half-written set; `beginDepthPlanes` drops the old index first for the same reason.
export async function beginDepthPlanes(projectId) {
  return trackPersistence('beginDepthPlanes:' + String(projectId), async () => {
    const dir = await getSubDir(projectId, 'depthmaps')
    await dir.removeEntry('index.json').catch(ignoreMissing)
  })
}

// Write the given planes of one map (`{ depth, cost, nrm, rgb }` ArrayBuffers or
// views). A key set to null is removed (e.g. no normals); an absent key is untouched,
// which is how the filter pass rewrites depth alone.
export async function saveDepthPlane(projectId, uuid, buffers) {
  return trackPersistence('saveDepthPlane:' + String(projectId) + ':' + String(uuid), async () => {
    const dir = await getSubDir(projectId, 'depthmaps')
    for (const key of DEPTH_BIN_KEYS) {
      if (!(key in buffers)) continue
      const buf = buffers[key],
        name = `${uuid}.${key}.bin`
      if (buf && buf.byteLength) await writeBin(dir, name, buf)
      else await dir.removeEntry(name).catch(ignoreMissing)
    }
  })
}

// Commit a streamed set: the index, then drop planes of images it does not list.
export async function commitDepthIndex(projectId, index) {
  return trackPersistence('commitDepthIndex:' + String(projectId), async () => {
    const dir = await getSubDir(projectId, 'depthmaps')
    await writeJson(dir, 'index.json', index)
    await removeStaleDepthBins(dir, new Set(index.maps.map((m) => m.uuid)))
  })
}

export async function loadDepthIndex(projectId) {
  try {
    const dir = await getSubDir(projectId, 'depthmaps')
    return await readJson(dir, 'index.json')
  } catch {
    return null
  }
}

// Read handles, not planes. Validate every required sidecar before computation.
export async function loadDepthFiles(projectId, metas) {
  const dir = await getSubDir(projectId, 'depthmaps'),
    out = []
  for (const meta of metas) {
    const files = {}
    for (const key of DEPTH_BIN_KEYS) {
      try {
        files[key] = await (await dir.getFileHandle(`${meta.uuid}.${key}.bin`)).getFile()
      } catch (error) {
        ignoreMissing(error)
        files[key] = null
      }
    }
    if (['depth', 'cost', 'rgb'].every((k) => !files[k]?.size)) continue
    for (const [key, size] of Object.entries(planeBytes(meta.width, meta.height))) {
      if (key === 'nrm' && !files.nrm?.size) continue
      if (files[key]?.size !== size) throw new Error(`Corrupt depth map ${meta.uuid} (${key}); recompute depth maps`)
    }
    out.push({ ...meta, files })
  }
  return out
}

export async function deleteDepthPlanes(projectId) {
  return trackPersistence('deleteDepthPlanes:' + String(projectId), async () => {
    try {
      const dir = await getSubDir(projectId, 'depthmaps')
      await dir.removeEntry('index.json').catch(ignoreMissing)
      await removeStaleDepthBins(dir, new Set())
    } catch (error) {
      ignoreMissing(error)
    }
  })
}
