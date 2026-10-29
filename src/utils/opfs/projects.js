// Storage availability, the project index, app-level JSON, project records, the
// whole-project walk, binary documents and directory-handle utilities.
import { trackPersistence, persistenceLock, ignoreMissing } from '../persistence.js'
import { getProjectDir, getRoot, projectRoots, readJson, writeFileIn, writeJson } from './base.js'
import { PROJECT_FORMAT_VERSION } from '../../core/projectFormat.js'

// ── Availability ─────────────────────────────────────────────────────────────

export async function isAvailable() {
  try {
    await navigator.storage.getDirectory()
    return true
  } catch {
    return false
  }
}

export async function requestDurable() {
  return navigator.storage.persist()
}

// OPFS defaults to *best-effort* storage: the browser is free to evict the whole
// origin under disk pressure, taking a project's images, matches and depth maps
// with it — and a blob: URL held across a long run then fails with
// ERR_FILE_NOT_FOUND rather than reporting anything. Requesting persistence
// promotes the bucket so nothing is evicted without the user asking.
//
// Called on project create/open (opening a project is the point at which the user
// has committed to storing data), and memoized: the answer cannot change without
// a user action, Chromium decides it silently from engagement heuristics, and
// Firefox *prompts* — re-asking every project switch would re-prompt.
let durableRequest = null
export function ensureDurableStorage() {
  durableRequest ??= (async () => {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return { supported: false, durable: false }
    try {
      // persisted() first: a granted bucket must not be re-requested (Firefox
      // treats persist() as a permission request and would prompt again).
      if (await navigator.storage.persisted()) return { supported: true, durable: true, alreadyGranted: true }
      return { supported: true, durable: await navigator.storage.persist() }
    } catch (err) {
      return { supported: true, durable: false, error: err?.message ?? String(err) }
    }
  })()
  return durableRequest
}

export async function getQuota() {
  return navigator.storage.estimate()
}

// ── Index (project list) ──────────────────────────────────────────────────────

export async function readIndex() {
  const root = await getRoot()
  return readJson(root, 'index.json')
}

// The project store tracks the complete locked read/merge/write transaction.
// Retrying a bare index snapshot would overwrite edits from another tab.
export async function writeIndex(data) {
  const root = await getRoot()
  await writeJson(root, 'index.json', data)
}

// ── App-level (non-project) JSON ──────────────────────────────────────────────
// Files in the `websfm/` root that belong to the installation rather than to a
// project — today just `core/crs.js`'s fetched-proj4-definition cache. Exposed so
// that cache goes through the same per-path write queue as everything else
// instead of hand-rolling its own createWritable (which raced itself whenever two
// unknown CRS codes resolved at once, and swallowed the swap-file error).

export async function readAppJson(filename) {
  const root = await getRoot()
  return readJson(root, filename)
}

export async function writeAppJson(filename, data) {
  return trackPersistence('writeAppJson:' + String(filename), async () => {
    const root = await getRoot()
    await writeJson(root, filename, data)
  })
}

// ── Project ───────────────────────────────────────────────────────────────────

export async function readProject(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'project.json')
  } catch {
    return null
  }
}

// project.json has two writers: the images store rewrites it whole from memory,
// and the projects store changes the name or CRS. One lock per project serialises
// them, and updateProject reads inside it, so a rename never writes back an image
// list that a concurrent sync has already replaced.
// A document without `formatVersion` is stamped with the current one (core/projectFormat.js);
// a copied one (a connected folder, an imported .websfm) keeps the version it has.
export async function writeProject(projectId, data) {
  return trackPersistence('writeProject:' + String(projectId), () =>
    persistenceLock(`project:${projectId}`, async () => {
      const dir = await getProjectDir(projectId, true)
      await writeJson(dir, 'project.json', { ...data, formatVersion: data.formatVersion ?? PROJECT_FORMAT_VERSION })
    }),
  )
}

// Read-modify-write: `update(data)` returns the new document. False when there is
// no project.json to update.
export async function updateProject(projectId, update) {
  return trackPersistence('updateProject:' + String(projectId), () =>
    persistenceLock(`project:${projectId}`, async () => {
      const dir = await getProjectDir(projectId)
      const data = await readJson(dir, 'project.json')
      if (!data) return false
      await writeJson(dir, 'project.json', update(data))
      return true
    }),
  )
}

// Remove the project's OPFS tree. A folder-backed project has none — its files
// are on the user's disk, and deleting them is not ours to do (the store forgets
// the project instead and says so). This is why the check is here rather than at
// the call site: every path into deletion has to obey it.
export async function deleteProject(projectId) {
  return trackPersistence('deleteProject:' + String(projectId), async () => {
    if (projectRoots.has(projectId)) return
    const root = await getRoot()
    const projects = await root.getDirectoryHandle('projects', { create: true })
    await projects.removeEntry(projectId, { recursive: true }).catch(ignoreMissing)
  })
}

// Empty a folder WebSfM filled itself (a project file unpacked into a folder that
// was empty, whose unpack failed). Never called on a folder that held anything before.
export async function clearDirectory(dirHandle) {
  const names = []
  for await (const name of dirHandle.keys()) names.push(name)
  for (const name of names) await dirHandle.removeEntry(name, { recursive: true }).catch(ignoreMissing)
}

// Delete the OPFS tree regardless of any registered folder root — used by the
// OPFS→folder migration once the copy has been verified, where the source is
// known to be the OPFS tree even though the root is by then re-registered.
export async function deleteOpfsProjectTree(projectId) {
  return trackPersistence('deleteOpfsProjectTree:' + String(projectId), async () => {
    const root = await getRoot()
    const projects = await root.getDirectoryHandle('projects', { create: true })
    await projects.removeEntry(projectId, { recursive: true }).catch(ignoreMissing)
  })
}

// ── Whole-project file walk / write ───────────────────────────────────────────
// The per-project directory IS the project format: `project.json` + the sidecar
// trees below. These two helpers treat it as one opaque tree, which is what lets
// a project be zipped into a `.websfm` file (core/io/projectArchive.js) and, in
// future, copied between storage backends — without either of them knowing what
// any individual file means.
//
// `walkProjectFiles` yields `{ relPath, file, handle }` depth-first, `relPath` always
// '/'-joined and relative to the project dir. `skip(relPath, kind)` is consulted
// for both files and directories, so skipping a directory prunes the subtree
// (that is what makes "exclude derived data" cheap rather than a per-file test).

// Chromium's swap file for a write in progress (`<name>.crswap`, renamed over the
// file when the write closes): never project data, and gone a moment later. A file
// removed while the walk runs is skipped too, so a walk during writes neither counts
// nor copies what is not there.
const isSwapFile = (name) => name.endsWith('.crswap')
async function* walkDir(dir, prefix, skip) {
  for await (const [name, handle] of dir) {
    const relPath = prefix ? `${prefix}/${name}` : name
    if (skip?.(relPath, handle.kind)) continue
    if (handle.kind === 'directory') yield* walkDir(handle, relPath, skip)
    else if (!isSwapFile(name)) {
      let file
      try {
        file = await handle.getFile()
      } catch (err) {
        ignoreMissing(err)
        continue
      }
      yield { relPath, file, handle }
    }
  }
}

export async function* walkProjectFiles(projectId, { skip = null } = {}) {
  let dir
  try {
    dir = await getProjectDir(projectId)
  } catch {
    return // no such project — an empty walk, matching the "absence is empty" convention
  }
  yield* walkDir(dir, '', skip)
}

// ── Binary documents as one unit (the .websfm save, utils/projectFile.js) ─────
// A binary document (binaryDocument.js) is a metadata file plus the generation files
// it names, and a save replaces the metadata and then collects the old generation.
// A walk taken minutes earlier can therefore pair one save's metadata with another's
// files. The project file archives each document as a unit instead: under the lock
// its readers and writers hold (so no save commits or collects meanwhile), it reads
// the metadata and the files that metadata names.
//
// `binaryDocumentLockKey(projectId, relPath)` → the lock of the document whose metadata
// is at `relPath`, or null when `relPath` is not one. `binaryDocumentOf(relPath)` → the
// metadata path a generation file (`<doc>.<generation>.<key>.bin`) belongs to, or null.
const BINARY_DOCUMENTS = [
  { re: /^reconstruction\.json$/, lock: (id) => `reconstruction:${id}` },
  { re: /^matches\/matches\.json$/, lock: (id) => `matches:${id}` },
  { re: /^products\/([^/]+)\.json$/, lock: (id, m) => `product:${id}:${m[1]}` },
]

export function binaryDocumentLockKey(projectId, relPath) {
  for (const { re, lock } of BINARY_DOCUMENTS) {
    const m = re.exec(String(relPath))
    if (m) return lock(projectId, m)
  }
  return null
}

export function binaryDocumentOf(relPath) {
  const m = /^(.+?\.json)\.[^/]+\.bin$/.exec(String(relPath))
  return m && binaryDocumentLockKey('', m[1]) ? m[1] : null
}

/** Run `work` under the lock of the binary document at `relPath` (see above). */
export function withBinaryDocumentLock(projectId, relPath, work) {
  const key = binaryDocumentLockKey(projectId, relPath)
  if (!key) throw new Error(`not a binary document: ${relPath}`)
  return persistenceLock(key, work)
}

/** The project file at `relPath` ('/'-joined) as a File snapshot, or null when absent. */
export async function getProjectFile(projectId, relPath) {
  const parts = String(relPath).split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`unsafe project path "${relPath}"`)
  try {
    let dir = await getProjectDir(projectId)
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part)
    return await (await dir.getFileHandle(parts[parts.length - 1])).getFile()
  } catch (error) {
    if (error?.name === 'NotFoundError' || error?.name === 'TypeMismatchError') return null
    throw error
  }
}

// Remove only artifacts that are safe to regenerate. Source images,
// keypoints/matches, masks, sparse/dense clouds, GCPs, and imports are retained.
// This is also the exact set omitted by "exclude cached/derived data" archives.
export async function deleteProjectDerived(projectId) {
  return trackPersistence('deleteProjectDerived:' + String(projectId), async () => {
    const dir = await getProjectDir(projectId)
    for (const name of ['images-derived', 'depthmaps', 'products']) {
      await dir.removeEntry(name, { recursive: true }).catch(ignoreMissing)
    }
  })
}

// Write one file at `relPath` inside the project dir, creating intermediate
// directories. `data` is anything createWritable() accepts (Blob / ArrayBuffer /
// TypedArray / string). Rejects traversal outside the project dir — `relPath`
// can come from a zip entry name, which is attacker-controlled data.
export async function writeProjectFile(projectId, relPath, data) {
  return trackPersistence('writeProjectFile:' + String(projectId) + ':' + String(relPath), async () => {
    const dir = await getProjectDir(projectId, true)
    await writeFileAt(dir, relPath, data)
  })
}

// ── Directory-handle utilities (folder-backed projects / migration) ───────────
// These take a raw FileSystemDirectoryHandle rather than a project id, because
// migration has to hold BOTH roots at once — the registry can only name one.

export async function writeFileAt(dirHandle, relPath, data) {
  return trackPersistence('writeFileAt:' + String(relPath), async () => {
    const parts = String(relPath)
      .split('/')
      .filter((p) => p !== '' && p !== '.')
    if (!parts.length || parts.some((p) => p === '..')) {
      throw new Error(`writeFileAt: unsafe path "${relPath}"`)
    }
    let dir = dirHandle
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true })
    await writeFileIn(dir, parts[parts.length - 1], data)
  })
}

export async function readJsonAt(dirHandle, filename) {
  return readJson(dirHandle, filename)
}

export async function dirIsEmpty(dirHandle) {
  for await (const _ of dirHandle.keys()) return false // eslint-disable-line no-unused-vars
  return true
}

// The raw OPFS location of a project, ignoring any registered folder root. Only
// migration needs this — everything else must go through getProjectDir so it
// honours the backend the project is actually on.
export async function getOpfsProjectDir(projectId, create = false) {
  const root = await getRoot()
  const projects = await root.getDirectoryHandle('projects', { create: true })
  return projects.getDirectoryHandle(projectId, { create })
}

// Copy every file under `from` into `to`, preserving the layout. Returns
// { files, bytes }. Verified by the caller (byte totals) before it deletes the
// source — a half-copied project must never be the only copy.
export async function copyTree(from, to, { onProgress = null, skip = null } = {}) {
  return trackPersistence('copyTree:' + String(from), async () => {
    let files = 0
    let bytes = 0
    for await (const { relPath, file } of walkDir(from, '', skip)) {
      await writeFileAt(to, relPath, file)
      files++
      bytes += file.size
      onProgress?.({ files, bytes, label: relPath })
    }
    return { files, bytes }
  })
}

// Total file count + byte size of a tree, for verifying a copy.
export async function measureTree(dirHandle, { skip = null } = {}) {
  let files = 0
  let bytes = 0
  for await (const { file } of walkDir(dirHandle, '', skip)) {
    files++
    bytes += file.size
  }
  return { files, bytes }
}
