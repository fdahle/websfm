// The storage plumbing every other opfs module builds on: the OPFS root, a
// project's directory (OPFS or a picked folder), and serialized, quota-aware writes.

import { MAX_BUFFER_BYTES } from '../../core/bufferLimit.js'
import { chunksOf, isSharedArray, shareableArray } from '../../core/bigArray.js'
import { blobChunks } from '../blobParts.js'

export const FLOATS_PER_KP = 6 // x, y, nx, ny, scale, response

export async function getRoot() {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle('websfm', { create: true })
}

export async function readJson(dir, filename) {
  try {
    const fh = await dir.getFileHandle(filename)
    const file = await fh.getFile()
    return JSON.parse(await file.text())
  } catch {
    return null
  }
}

// ── Serialized writes ─────────────────────────────────────────────────────────
// `createWritable()` does not write in place: Chromium stages the bytes in a
// sibling `<name>.crswap` file and renames it over the target on close(). Two
// writables open on the SAME file therefore collide on that one swap name, and
// the loser throws **"Failed to create swap file"** — reported from a
// folder-backed project on 2026-08-18, where the slower real-disk I/O widens the
// overlap window that OPFS usually wins by luck.
//
// Stores coalesce their own writes for their own reasons (useImagesStore.sync,
// useSensorsStore.save: fewer redundant rewrites), but the invariant is a
// property of this layer, not of any one store — a store cannot know that
// another one is mid-write, and every project JSON has call sites that can
// overlap. So EVERY write in this module goes through writeFileIn, which queues
// per file: writes to one path run in order, different paths still run in
// parallel.
//
// The key is `<containing dir name>/<filename>` — handles are re-created per
// call, so they cannot be compared, and this is stable for both OPFS and picked
// folders. Two projects with the same directory name would over-serialize, which
// costs nothing (only one project is open at a time) and is never wrong.
const fileLocks = new Map() // key → promise resolving when the queued write settles

async function withFileLock(key, fn) {
  const prev = fileLocks.get(key)
  // Run regardless of how the predecessor settled: a queue must not cancel the
  // writes behind a failed one.
  const run = prev
    ? prev.then(
        () => fn(),
        () => fn(),
      )
    : fn()
  const tail = run.then(
    () => {},
    () => {},
  )
  fileLocks.set(key, tail)
  try {
    return await run
  } finally {
    // Only the tail clears the entry, so a write that queued behind us keeps the
    // chain alive (and the map doesn't grow without bound).
    if (fileLocks.get(key) === tail) fileLocks.delete(key)
  }
}

/**
 * Write one file, serialized against every other write to the same path.
 * `data` null ⇒ create/truncate only. `append` seeks to the current end INSIDE
 * the lock — reading the size outside it is the same race one level up (two
 * appends would compute the same offset and one would overwrite the other).
 */
export async function writeFileIn(dir, filename, data, { append = false } = {}) {
  return withFileLock(`${dir.name}/${filename}`, async () => {
    try {
      const fh = await dir.getFileHandle(filename, { create: true })
      const size = append ? (await fh.getFile()).size : 0
      const writable = await fh.createWritable(append ? { keepExistingData: true } : undefined)
      try {
        if (append) await writable.seek(size)
        // A shared array (core/bigArray.js, a cloud past 2 GiB) is refused by write():
        // it goes in plain chunks.
        if (ArrayBuffer.isView(data) && isSharedArray(data)) for (const c of chunksOf(data)) await writable.write(c)
        else if (data != null) await writable.write(data)
        await writable.close()
      } catch (error) {
        await writable.abort?.().catch(() => {})
        throw error
      }
    } catch (error) {
      throw isStorageFull(error) || (await outOfSpace(data)) ? storageFullError(filename, error) : error
    }
  })
}

// Out of space: the browser's quota for this site (OPFS), or the disk under it or
// under a folder-backed project. The raw errors do not say what to do, so a write
// that fails this way says it here, once. Chromium names a plain over-quota write
// QuotaExceededError, but a write that runs out part-way (depth planes, 2026-10-17,
// both under a capped site quota and on a full filesystem) fails as AbortError
// "Failed to write data to data pipe": the bytes could not be put on disk. Neither
// case shows in navigator.storage.estimate(), so the space left is only a third test.
const PIPE_WRITE_FAILED = /failed to write data to data pipe/i
export const isStorageFull = (error) =>
  error?.name === 'QuotaExceededError' ||
  error?.storageFull === true ||
  (error?.name === 'AbortError' && PIPE_WRITE_FAILED.test(error?.message ?? ''))
async function outOfSpace(data) {
  try {
    const { usage, quota } = await navigator.storage.estimate()
    const bytes = data?.byteLength ?? data?.size ?? (typeof data === 'string' ? data.length : 0)
    return Number.isFinite(quota) && quota - usage < Math.max(bytes, 1 << 20)
  } catch {
    return false
  }
}
function storageFullError(filename, cause) {
  if (cause?.storageFull) return cause
  const err = new Error(
    'Storage is full: the browser or the disk refused to save project data. Free space (delete ' +
      'projects you no longer need, or Project settings… ▸ Clear derived data), or move this project to a folder on ' +
      `disk, then run the step again. (${filename})`,
  )
  err.name = 'QuotaExceededError'
  err.storageFull = true
  err.cause = cause
  return err
}

export async function writeJson(dir, filename, data) {
  await writeFileIn(dir, filename, JSON.stringify(data))
}

export async function writeBin(dir, filename, buffer) {
  await writeFileIn(dir, filename, buffer)
}

// An ArrayBuffer; a file past the browser's largest ArrayBuffer (a cloud of more than
// 178 M points) comes as a shareable Uint8Array (core/bigArray.js) read in chunks, which
// readers take with viewAs.
export async function readBin(dir, filename) {
  const fh = await dir.getFileHandle(filename)
  const file = await fh.getFile()
  if (file.size <= MAX_BUFFER_BYTES) return file.arrayBuffer()
  const out = shareableArray(Uint8Array, file.size)
  let off = 0
  for await (const chunk of blobChunks(file, { chunkBytes: 64 * 2 ** 20 })) {
    out.set(chunk, off)
    off += chunk.byteLength
  }
  return out
}

// ── Pluggable project root ────────────────────────────────────────────────────
// A project normally lives at OPFS `websfm/projects/{id}`, but it can instead be
// a directory the user picked on disk (File System Access). The two handle types
// expose the IDENTICAL async API, so registering a picked handle here is the
// whole of the feature: every helper below is untouched and neither knows which
// backend it is writing to.
//
// The project *index* (`websfm/index.json`) always stays in OPFS — it is the list
// of projects, not project content, and must be readable before any folder
// permission has been granted.
//
// Registration is runtime-only and deliberately not persisted here: the handle
// itself lives in IndexedDB (utils/handleStore.js), and re-registering it needs a
// permission check, which is the store's job.
export const projectRoots = new Map()

export function setProjectRoot(projectId, dirHandle) {
  projectRoots.set(projectId, dirHandle)
}

export function clearProjectRoot(projectId) {
  projectRoots.delete(projectId)
}

export async function getProjectDir(projectId, create = false) {
  const registered = projectRoots.get(projectId)
  // A folder-backed project's directory always exists — `create` is moot, and
  // honouring it would be wrong anyway (we must never mint a subdirectory named
  // after the project id inside the user's folder).
  if (registered) return registered
  const root = await getRoot()
  const projects = await root.getDirectoryHandle('projects', { create: true })
  return projects.getDirectoryHandle(projectId, { create })
}

export async function getSubDir(projectId, name) {
  const dir = await getProjectDir(projectId, true)
  return dir.getDirectoryHandle(name, { create: true })
}
