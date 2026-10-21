// Keypoints, keypoint colours, descriptors and the packed matches document.
import { trackPersistence, persistenceLock, ignoreMissing } from '../persistence.js'
import { writeBinaryDocument, readBinaryDocument } from '../binaryDocument.js'
import { FLOATS_PER_KP, getProjectDir, getSubDir, readBin, readJson, writeBin, writeFileIn, writeJson } from './base.js'

// ── Keypoints ─────────────────────────────────────────────────────────────────
// keypoints/{uuid}.bin is the Keypoints `data` buffer itself (Float32, KP_STRIDE = 6:
// x, y, nx, ny, scale, response) and keypoint_colors/{uuid}.bin its `rgb` (Uint8,
// N×3): core/features/keypoints.js. Saving writes them as they are, loading wraps the
// bytes — no object per keypoint either way.

export async function saveKeypoints(projectId, uuid, keypoints) {
  return trackPersistence('saveKeypoints:' + String(projectId) + ':' + String(uuid), async () => {
    const dir = await getSubDir(projectId, 'keypoints')
    await writeFileIn(dir, uuid + '.bin', keypoints.data)
  })
}

// The Float32 data buffer, or null when the file is missing or malformed.
export async function loadKeypoints(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'keypoints')
    const buffer = await (await (await dir.getFileHandle(uuid + '.bin')).getFile()).arrayBuffer()
    if (buffer.byteLength % (FLOATS_PER_KP * 4)) return null
    return new Float32Array(buffer)
  } catch {
    return null
  }
}

// The uuids that have a keypoint file — one directory listing, no file opened. A
// project open reads this instead of the keypoints themselves (they load per image on
// demand, useImagesStore.ensureKeypoints), so a missing sidecar still turns into
// "re-run detection" at open rather than at the first viewer that asks.
export async function listKeypointFiles(projectId) {
  const uuids = new Set()
  try {
    const dir = await getSubDir(projectId, 'keypoints')
    for await (const name of dir.keys()) if (name.endsWith('.bin')) uuids.add(name.slice(0, -4))
  } catch { /* no directory ⇒ none */ }
  return uuids
}

export async function deleteKeypoints(projectId, uuid) {
  return trackPersistence('deleteKeypoints:' + String(projectId) + ':' + String(uuid), async () => {
    try {
      const dir = await getSubDir(projectId, 'keypoints')
      await dir.removeEntry(uuid + '.bin')
    } catch (error) { ignoreMissing(error) }
  })
}

// ── Keypoint colours ────────────────────────────────────────────────────────
// Per-keypoint RGB sampled at detection (Uint8Array, N×3), parallel to keypoints;
// used to colour the sparse cloud. Absent ⇔ the keypoints carry no colour.

export async function saveColors(projectId, uuid, keypoints) {
  return trackPersistence('saveColors:' + String(projectId) + ':' + String(uuid), async () => {
    const dir = await getSubDir(projectId, 'keypoint_colors')
    if (keypoints.rgb) await writeFileIn(dir, uuid + '.bin', keypoints.rgb)
    else await dir.removeEntry(uuid + '.bin').catch(ignoreMissing)
  })
}

// The Uint8 rgb buffer, or null.
export async function loadColors(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'keypoint_colors')
    return new Uint8Array(await (await (await dir.getFileHandle(uuid + '.bin')).getFile()).arrayBuffer())
  } catch {
    return null
  }
}

// ── Descriptors ───────────────────────────────────────────────────────────────
// Stored as raw Float32Array (N×128 floats) in descriptors/{uuid}.bin.
// Not loaded into the image object — fetched on-demand when matching.

export async function saveDescriptors(projectId, uuid, descriptors) {
  return trackPersistence('saveDescriptors:' + String(projectId) + ':' + String(uuid), async () => {
    const dir = await getSubDir(projectId, 'descriptors')
    await writeFileIn(dir, uuid + '.bin', descriptors.buffer)
  })
}

export async function loadDescriptors(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'descriptors')
    const fh = await dir.getFileHandle(uuid + '.bin')
    const file = await fh.getFile()
    return new Float32Array(await file.arrayBuffer())
  } catch {
    return null
  }
}

export async function deleteDescriptors(projectId, uuid) {
  return trackPersistence('deleteDescriptors:' + String(projectId) + ':' + String(uuid), async () => {
    try {
      const dir = await getSubDir(projectId, 'descriptors')
      await dir.removeEntry(uuid + '.bin')
    } catch (error) { ignoreMissing(error) }
  })
}

// ── Matches ───────────────────────────────────────────────────────────────────
// One packed binary document, `matches/matches.json` + its generation buffers
// (layout: core/features/matchStorage.js). Written whole by the store (coalesced);
// a buffer passed as `{ reuse }` keeps an earlier generation's file, so excluding a
// pair rewrites only the flags.

export async function saveMatchDocument(projectId, meta, buffers) {
  return trackPersistence('saveMatchDocument:' + String(projectId), async () => (
    persistenceLock(`matches:${projectId}`, async () => {
      const dir = await getSubDir(projectId, 'matches')
      return writeBinaryDocument(dir, 'matches.json', meta, buffers, { writeJson, writeBin })
    })))
}

// The document's INDEX — every column except the matches themselves — plus the
// matches column as a File (nothing read), from which a pair is one Blob slice
// (core/features/matchStorage.js has the offsets). { meta, buffers, files,
// matchesFile } or null when the project has no match document; throws when the
// document is there but unreadable (a buffer missing or the wrong size).
export async function loadMatchIndex(projectId, indexKeys) {
  return persistenceLock(`matches:${projectId}`, async () => {
    let dir, meta
    try {
      dir = await getSubDir(projectId, 'matches')
      meta = await readJson(dir, 'matches.json')
    } catch {
      return null
    }
    if (!meta?.binaryFiles) return null
    const files = meta.binaryFiles
    const index = Object.fromEntries(Object.entries(files).filter(([key]) => indexKeys.includes(key)))
    const buffers = await readBinaryDocument(dir, { binaryFiles: index }, readBin)
    const matchesFile = files.matches ? await matchFileIn(dir, files.matches) : null
    delete meta.binaryFiles
    return { meta, buffers, files, matchesFile }
  })
}

// The committed matches column of one generation, as a File (see loadMatchIndex).
export async function loadMatchesFile(projectId, file) {
  return matchFileIn(await getSubDir(projectId, 'matches'), file)
}

async function matchFileIn(dir, file) {
  if (!file?.name || /[/\\]/.test(file.name)) throw new Error('Invalid match document manifest')
  const f = await (await dir.getFileHandle(file.name)).getFile()
  if (f.size !== file.bytes) throw new Error('Incomplete saved buffer: matches')
  return f
}

export async function clearAllMatches(projectId) {
  return trackPersistence('clearAllMatches:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('matches', { recursive: true })
    } catch (error) { ignoreMissing(error) }
  })
}
