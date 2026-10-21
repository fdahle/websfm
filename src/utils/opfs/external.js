// External reference rasters: the index, height planes, sources and COGs.
import { trackPersistence, ignoreMissing } from '../persistence.js'
import { getSubDir, readBin, readJson, writeBin, writeFileIn, writeJson } from './base.js'

// ── External reference rasters ────────────────────────────────────────────────
// Imported georeferenced DEMs / orthophotos: evidence the user brought in, which
// the pipeline never overwrites. Same lazy shape as the depth-map planes, and
// for the same reason — a REMA tile is hundreds of MB, so eagerly loading it on
// project open would undo the dense memory budget.
//
// Metadata → external/index.json:
//   { version: 1, rasters: [RasterMeta] }   (RasterMeta incl. previewDataUrl)
// Pixel plane → external/{id}.bin, read only by ensureRasterLoaded(id).
// Original file → external/{id}.src, kept as the source of truth so
//   "Treat as DEM / orthophoto" can re-decode (a DEM plane is Float32, an ortho
//   plane is RGBA — the interpretations are NOT interchangeable in memory, so a
//   flip is a re-decode, not a relabel). Same arrangement as an ingested TIFF,
//   whose original stays in OPFS behind the derived display/compute blobs.

export async function saveExternalIndex(projectId, index) {
  return trackPersistence('saveExternalIndex:' + String(projectId), async () => {
    const dir = await getSubDir(projectId, 'external')
    await writeJson(dir, 'index.json', index)
  })
}

export async function loadExternalIndex(projectId) {
  try {
    const dir = await getSubDir(projectId, 'external')
    return await readJson(dir, 'index.json')
  } catch {
    return null
  }
}

// Write one raster's plane. Does not detach `buffer` (matching saveDepthPlanes),
// so the caller's in-memory source stays usable straight after the import.
export async function saveExternalPlane(projectId, id, buffer) {
  return trackPersistence('saveExternalPlane:' + String(projectId) + ':' + String(id), async () => {
    const dir = await getSubDir(projectId, 'external')
    await writeBin(dir, `${id}.bin`, buffer)
  })
}

export async function loadExternalPlane(projectId, id) {
  try {
    const dir = await getSubDir(projectId, 'external')
    return await readBin(dir, `${id}.bin`)
  } catch {
    return null
  }
}

// Existence only — an ortho imported for tiled display has no plane by design,
// and reading hundreds of MB just to learn that one exists would undo lazy loading.
export async function hasExternalPlane(projectId, id) {
  try {
    await (await getSubDir(projectId, 'external')).getFileHandle(`${id}.bin`)
    return true
  } catch {
    return false
  }
}

export async function deleteExternalPlane(projectId, id) {
  return trackPersistence('deleteExternalPlane:' + String(projectId) + ':' + String(id), async () => {
    try {
      const dir = await getSubDir(projectId, 'external')
      await dir.removeEntry(`${id}.bin`).catch(ignoreMissing)
      await dir.removeEntry(`${id}.src`).catch(ignoreMissing)
      await dir.removeEntry(`${id}.cog`).catch(ignoreMissing)
    } catch (error) { ignoreMissing(error) }
  })
}

// The original imported file, kept so a kind flip can re-decode.
export async function saveExternalSource(projectId, id, blob) {
  return trackPersistence('saveExternalSource:' + String(projectId) + ':' + String(id), async () => {
    const dir = await getSubDir(projectId, 'external')
    await writeFileIn(dir, `${id}.src`, blob)
  })
}

export async function saveExternalCog(projectId, id, blob) {
  return trackPersistence('saveExternalCog:' + String(projectId) + ':' + id, async () => {
    await writeFileIn(await getSubDir(projectId, 'external'), `${id}.cog`, blob)
  })
}
export async function loadExternalCog(projectId, id) {
  try { return await (await (await getSubDir(projectId, 'external')).getFileHandle(`${id}.cog`)).getFile() }
  catch { return null }
}

export async function loadExternalSource(projectId, id) {
  try {
    const dir = await getSubDir(projectId, 'external')
    const fh = await dir.getFileHandle(`${id}.src`)
    return await fh.getFile()
  } catch {
    return null
  }
}

// Drop every raster sidecar (plane + original) not in `keepIds`.
export async function pruneExternalPlanes(projectId, keepIds) {
  return trackPersistence('pruneExternalPlanes:' + String(projectId), async () => {
    try {
      const dir = await getSubDir(projectId, 'external')
      const stale = []
      for await (const name of dir.keys()) {
        const m = name.match(/^(.+)\.(?:bin|src|cog)$/)
        if (m && !keepIds.has(m[1])) stale.push(name)
      }
      for (const name of stale) await dir.removeEntry(name).catch(ignoreMissing)
    } catch (error) { ignoreMissing(error) }
  })
}

export async function deleteExternalAll(projectId) {
  return trackPersistence('deleteExternalAll:' + String(projectId), async () => {
    try {
      const dir = await getSubDir(projectId, 'external')
      await dir.removeEntry('index.json').catch(ignoreMissing)
      await pruneExternalPlanes(projectId, new Set())
    } catch (error) { ignoreMissing(error) }
  })
}
