import { trackPersistence, persistenceLock, ignoreMissing } from './persistence.js'
import { writeBinaryDocument, readBinaryDocument } from './binaryDocument.js'
import { DEPTH_BIN_KEYS } from '../core/dense/depthMapCodec.js'
import { mapConcurrent } from './concurrency.js'

const FLOATS_PER_KP = 6 // x, y, nx, ny, scale, response

async function getRoot() {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle('websfm', { create: true })
}

async function readJson(dir, filename) {
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
  const run = prev ? prev.then(() => fn(), () => fn()) : fn()
  const tail = run.then(() => {}, () => {})
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
async function writeFileIn(dir, filename, data, { append = false } = {}) {
  return withFileLock(`${dir.name}/${filename}`, async () => {
    const fh = await dir.getFileHandle(filename, { create: true })
    const size = append ? (await fh.getFile()).size : 0
    const writable = await fh.createWritable(append ? { keepExistingData: true } : undefined)
    try {
      if (append) await writable.seek(size)
      if (data != null) await writable.write(data)
      await writable.close()
    } catch (error) {
      await writable.abort?.().catch(() => {})
      throw error
    }
  })
}

async function writeJson(dir, filename, data) {
  await writeFileIn(dir, filename, JSON.stringify(data))
}

async function writeBin(dir, filename, buffer) {
  await writeFileIn(dir, filename, buffer)
}

async function readBin(dir, filename) {
  const fh = await dir.getFileHandle(filename)
  const file = await fh.getFile()
  return file.arrayBuffer()
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
const projectRoots = new Map()

export function setProjectRoot(projectId, dirHandle) {
  projectRoots.set(projectId, dirHandle)
}

export function clearProjectRoot(projectId) {
  projectRoots.delete(projectId)
}

export function hasProjectRoot(projectId) {
  return projectRoots.has(projectId)
}

async function getProjectDir(projectId, create = false) {
  const registered = projectRoots.get(projectId)
  // A folder-backed project's directory always exists — `create` is moot, and
  // honouring it would be wrong anyway (we must never mint a subdirectory named
  // after the project id inside the user's folder).
  if (registered) return registered
  const root = await getRoot()
  const projects = await root.getDirectoryHandle('projects', { create: true })
  return projects.getDirectoryHandle(projectId, { create })
}

async function getSubDir(projectId, name) {
  const dir = await getProjectDir(projectId, true)
  return dir.getDirectoryHandle(name, { create: true })
}

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

export async function writeProject(projectId, data) {
  return trackPersistence('writeProject:' + String(projectId), async () => {
    const dir = await getProjectDir(projectId, true)
    await writeJson(dir, 'project.json', data)
  })
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
// `walkProjectFiles` yields `{ relPath, file }` depth-first, `relPath` always
// '/'-joined and relative to the project dir. `skip(relPath, kind)` is consulted
// for both files and directories, so skipping a directory prunes the subtree
// (that is what makes "exclude derived data" cheap rather than a per-file test).

async function* walkDir(dir, prefix, skip) {
  for await (const [name, handle] of dir) {
    const relPath = prefix ? `${prefix}/${name}` : name
    if (skip?.(relPath, handle.kind)) continue
    if (handle.kind === 'directory') yield* walkDir(handle, relPath, skip)
    else yield { relPath, file: await handle.getFile() }
  }
}

export async function* walkProjectFiles(projectId, { skip = null } = {}) {
  let dir
  try {
    dir = await getProjectDir(projectId)
  } catch {
    return   // no such project — an empty walk, matching the "absence is empty" convention
  }
  yield* walkDir(dir, '', skip)
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
    const parts = String(relPath).split('/').filter((p) => p !== '' && p !== '.')
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
  for await (const _ of dirHandle.keys()) return false   // eslint-disable-line no-unused-vars
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
export async function copyTree(from, to, { onProgress = null } = {}) {
  return trackPersistence('copyTree:' + String(from), async () => {
    let files = 0
    let bytes = 0
    for await (const { relPath, file } of walkDir(from, '', null)) {
      await writeFileAt(to, relPath, file)
      files++
      bytes += file.size
      onProgress?.({ files, bytes, label: relPath })
    }
    return { files, bytes }
  })
}

// Total file count + byte size of a tree, for verifying a copy.
export async function measureTree(dirHandle) {
  let files = 0
  let bytes = 0
  for await (const { file } of walkDir(dirHandle, '', null)) { files++; bytes += file.size }
  return { files, bytes }
}

// ── Images ────────────────────────────────────────────────────────────────────

export async function saveImage(projectId, uuid, file) {
  return trackPersistence('saveImage:' + String(projectId) + ':' + String(uuid), async () => {
    const dir = await getSubDir(projectId, 'images')
    await writeFileIn(dir, uuid, file)
  })
}

export async function loadImageBlob(projectId, uuid) {
  const dir = await getSubDir(projectId, 'images')
  const fh = await dir.getFileHandle(uuid)
  return fh.getFile()
}

export async function deleteImage(projectId, uuid) {
  return trackPersistence('deleteImage:' + String(projectId) + ':' + String(uuid), async () => {
    try {
      const dir = await getSubDir(projectId, 'images')
      await dir.removeEntry(uuid)
    } catch (error) { ignoreMissing(error) }
  })
}

// ── Derived (transcoded) image blobs ──────────────────────────────────────────
// Pure cache of the TIFF→JPEG/PNG transcode. `kind` is 'display' (JPEG, the
// viewer <img>) or 'compute' (lossless PNG, detection/dense). Recomputable
// from the immutable original at any time, so absence is never an error.
// NOTE: this cache assumes fixed transcode params (jpegQuality etc.); if those
// ever become user-configurable it needs a version/params check to invalidate.

async function derivedName(uuid, kind) {
  return `${uuid}.${kind === 'compute' ? 'compute' : 'display'}`
}

export async function saveImageDerived(projectId, uuid, kind, blob) {
  return trackPersistence('saveImageDerived:' + String(projectId) + ':' + String(uuid) + ':' + String(kind), async () => {
    const dir = await getSubDir(projectId, 'images-derived')
    await writeFileIn(dir, await derivedName(uuid, kind), blob)
  })
}

export async function loadImageDerivedBlob(projectId, uuid, kind) {
  try {
    const dir = await getSubDir(projectId, 'images-derived')
    const fh = await dir.getFileHandle(await derivedName(uuid, kind))
    return await fh.getFile()
  } catch {
    return null
  }
}

export async function deleteImageDerived(projectId, uuid) {
  return trackPersistence('deleteImageDerived:' + String(projectId) + ':' + String(uuid), async () => {
    try {
      const dir = await getSubDir(projectId, 'images-derived')
      await dir.removeEntry(await derivedName(uuid, 'display')).catch(ignoreMissing)
      await dir.removeEntry(await derivedName(uuid, 'compute')).catch(ignoreMissing)
    } catch (error) { ignoreMissing(error) }
  })
}

// ── Keypoints ─────────────────────────────────────────────────────────────────

export async function saveKeypoints(projectId, uuid, keypoints) {
  return trackPersistence('saveKeypoints:' + String(projectId) + ':' + String(uuid), async () => {
    const buf = new Float32Array(keypoints.length * FLOATS_PER_KP)
    keypoints.forEach((kp, i) => {
      const o = i * FLOATS_PER_KP
      buf[o] = kp.x; buf[o + 1] = kp.y; buf[o + 2] = kp.nx
      buf[o + 3] = kp.ny; buf[o + 4] = kp.scale; buf[o + 5] = kp.response
    })
    const dir = await getSubDir(projectId, 'keypoints')
    await writeFileIn(dir, uuid + '.bin', buf.buffer)
  })
}

export async function loadKeypoints(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'keypoints')
    const fh = await dir.getFileHandle(uuid + '.bin')
    const file = await fh.getFile()
    const buf = new Float32Array(await file.arrayBuffer())
    const n = buf.length / FLOATS_PER_KP
    const keypoints = []
    for (let i = 0; i < n; i++) {
      const o = i * FLOATS_PER_KP
      keypoints.push({ x: buf[o], y: buf[o + 1], nx: buf[o + 2], ny: buf[o + 3], scale: buf[o + 4], response: buf[o + 5] })
    }
    return keypoints
  } catch {
    return null
  }
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
// Per-keypoint RGB sampled at detection, stored separately from the packed
// keypoint floats (Uint8Array, N×3) so the keypoint format stays back-compatible.
// Parallel array to keypoints; used to colour the sparse cloud.

export async function saveColors(projectId, uuid, keypoints) {
  return trackPersistence('saveColors:' + String(projectId) + ':' + String(uuid), async () => {
    const buf = new Uint8Array(keypoints.length * 3)
    keypoints.forEach((kp, i) => {
      const c = kp.color
      if (c) { buf[i * 3] = c[0]; buf[i * 3 + 1] = c[1]; buf[i * 3 + 2] = c[2] }
    })
    const dir = await getSubDir(projectId, 'keypoint_colors')
    await writeFileIn(dir, uuid + '.bin', buf.buffer)
  })
}

export async function loadColors(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'keypoint_colors')
    const fh = await dir.getFileHandle(uuid + '.bin')
    const file = await fh.getFile()
    const buf = new Uint8Array(await file.arrayBuffer())
    const n = Math.floor(buf.length / 3)
    const colors = new Array(n)
    for (let i = 0; i < n; i++) colors[i] = [buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]]
    return colors
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
// JSON: { idA, idB, rawCount, inlierCount, F, matches: [[ia,ib],...], disabled, weak }
//   weak: valid-F pair below the accept gate — kept as a PnP registration bridge only.
// pairId = sorted([uuidA, uuidB]).join('--')

export async function saveMatches(projectId, pairId, data) {
  return trackPersistence('saveMatches:' + String(projectId) + ':' + String(pairId), async () => {
    const dir = await getSubDir(projectId, 'matches')
    await writeJson(dir, pairId + '.json', data)
  })
}

export async function loadMatches(projectId, pairId) {
  try {
    const dir = await getSubDir(projectId, 'matches')
    return readJson(dir, pairId + '.json')
  } catch {
    return null
  }
}

export async function deleteMatches(projectId, pairId) {
  return trackPersistence('deleteMatches:' + String(projectId) + ':' + String(pairId), async () => {
    try {
      const dir = await getSubDir(projectId, 'matches')
      await dir.removeEntry(pairId + '.json')
    } catch (error) { ignoreMissing(error) }
  })
}

export async function loadAllMatches(projectId) {
  try {
    const dir = await getSubDir(projectId, 'matches')
    const files = []
    for await (const [name, handle] of dir) {
      if (handle.kind !== 'file' || !name.endsWith('.json')) continue
      files.push({ name, handle })
    }
    const loaded = await mapConcurrent(files, 12, async ({ name, handle }) => {
      try {
        const file = await handle.getFile()
        const data = JSON.parse(await file.text())
        return { pairId: name.replace(/\.json$/, ''), ...data }
      } catch { return null }
    })
    return loaded.filter(Boolean)
  } catch {
    return []
  }
}

export async function clearAllMatches(projectId) {
  return trackPersistence('clearAllMatches:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('matches', { recursive: true })
    } catch (error) { ignoreMissing(error) }
  })
}

// ── Masks ─────────────────────────────────────────────────────────────────────

export async function saveMask(projectId, uuid, dataUrl) {
  return trackPersistence('saveMask:' + String(projectId) + ':' + String(uuid), async () => {
    const res = await fetch(dataUrl)
    const blob = await res.blob()
    const dir = await getSubDir(projectId, 'masks')
    await writeFileIn(dir, uuid + '.png', blob)
  })
}

export async function loadMaskDataUrl(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'masks')
    const fh = await dir.getFileHandle(uuid + '.png')
    const file = await fh.getFile()
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = (e) => resolve(e.target.result)
      reader.readAsDataURL(file)
    })
  } catch {
    return null
  }
}

export async function deleteMask(projectId, uuid) {
  return trackPersistence('deleteMask:' + String(projectId) + ':' + String(uuid), async () => {
    try {
      const dir = await getSubDir(projectId, 'masks')
      await dir.removeEntry(uuid + '.png')
    } catch (error) { ignoreMissing(error) }
  })
}

// ── Depth maps (display previews) ─────────────────────────────────────────────
// The per-image preview PNG shown in the viewer. The heavy float planes behind
// it are a separate concern — see "Depth-map planes" below.

export async function saveDepth(projectId, uuid, dataUrl) {
  return trackPersistence('saveDepth:' + String(projectId) + ':' + String(uuid), async () => {
    const res = await fetch(dataUrl)
    const blob = await res.blob()
    const dir = await getSubDir(projectId, 'depthmaps')
    await writeFileIn(dir, uuid + '.png', blob)
  })
}

export async function loadDepthDataUrl(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'depthmaps')
    const fh = await dir.getFileHandle(uuid + '.png')
    const file = await fh.getFile()
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = (e) => resolve(e.target.result)
      reader.readAsDataURL(file)
    })
  } catch {
    return null
  }
}

export async function deleteDepth(projectId, uuid) {
  return trackPersistence('deleteDepth:' + String(projectId) + ':' + String(uuid), async () => {
    try {
      const dir = await getSubDir(projectId, 'depthmaps')
      await dir.removeEntry(uuid + '.png').catch(ignoreMissing)
      // The float planes belong to the same image — drop them together, or an
      // image removal would leave orphaned (and much larger) sidecars behind.
      for (const key of DEPTH_BIN_KEYS) {
        await dir.removeEntry(`${uuid}.${key}.bin`).catch(ignoreMissing)
      }
    } catch (error) { ignoreMissing(error) }
  })
}

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
        else await dir.removeEntry(name).catch(ignoreMissing)   // e.g. nrm absent
      }
    }
    await writeJson(dir, 'index.json', index)
    await removeStaleDepthBins(dir, keep)   // drop planes of images no longer mapped
  })
}

// Rewrite the index alone, leaving the planes untouched (e.g. after dropping the
// entries of images that were removed).
export async function saveDepthIndex(projectId, index) {
  return trackPersistence('saveDepthIndex:' + String(projectId), async () => {
    const dir = await getSubDir(projectId, 'depthmaps')
    await writeJson(dir, 'index.json', index)
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

// Read the planes for the given metadata entries. A map whose sidecars are
// missing comes back with null buffers; the caller (codec) rejects it rather
// than fusing a partial set.
export async function loadDepthPlanes(projectId, metas) {
  const dir = await getSubDir(projectId, 'depthmaps')
  const out = []
  for (const meta of metas) {
    const buffers = {}
    for (const key of DEPTH_BIN_KEYS) {
      buffers[key] = await readBin(dir, `${meta.uuid}.${key}.bin`).catch(() => null)
    }
    out.push({ uuid: meta.uuid, buffers })
  }
  return out
}

export async function deleteDepthPlanes(projectId) {
  return trackPersistence('deleteDepthPlanes:' + String(projectId), async () => {
    try {
      const dir = await getSubDir(projectId, 'depthmaps')
      await dir.removeEntry('index.json').catch(ignoreMissing)
      await removeStaleDepthBins(dir, new Set())
    } catch (error) { ignoreMissing(error) }
  })
}

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

export async function deleteExternalPlane(projectId, id) {
  return trackPersistence('deleteExternalPlane:' + String(projectId) + ':' + String(id), async () => {
    try {
      const dir = await getSubDir(projectId, 'external')
      await dir.removeEntry(`${id}.bin`).catch(ignoreMissing)
      await dir.removeEntry(`${id}.src`).catch(ignoreMissing)
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
        const m = name.match(/^(.+)\.(?:bin|src)$/)
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

// ── Ground Control Points ───────────────────────────────────────────────────────
// JSON: { crs, importDefaults, gcps: [{ coordinates, covariance metadata,
// observations with pixel sigmas, role, enabled }] }

export async function saveGcps(projectId, data) {
  return trackPersistence('saveGcps:' + String(projectId), async () => {
    const dir = await getProjectDir(projectId, true)
    await writeJson(dir, 'gcps.json', data)
  })
}

export async function loadGcps(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'gcps.json')
  } catch {
    return null
  }
}

export async function deleteGcps(projectId) {
  return trackPersistence('deleteGcps:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('gcps.json')
    } catch (error) { ignoreMissing(error) }
  })
}

// ── Shapefiles (footprint / polygon vector layers) ────────────────────────────────
// JSON: { crs, sets: [{ id, name, source, onMap,
//         footprints: [{ id, imageId, imageName, rings }] }] }
// Older projects carry a flat { footprints: [...] } array — the store wraps those
// into one set on restore (see useFootprintsStore.normalizeStored).

export async function saveFootprints(projectId, data) {
  return trackPersistence('saveFootprints:' + String(projectId), async () => {
    const dir = await getProjectDir(projectId, true)
    await writeJson(dir, 'footprints.json', data)
  })
}

export async function loadFootprints(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'footprints.json')
  } catch {
    return null
  }
}

export async function deleteFootprints(projectId) {
  return trackPersistence('deleteFootprints:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('footprints.json')
    } catch (error) { ignoreMissing(error) }
  })
}

// ── Scale bars (known-distance constraints) ──────────────────────────────────────
// JSON: { bars: [{ id, name, a:{kind,id}, b:{kind,id}, knownDistanceM, accuracyM,
//                  displayUnit, enabled }] }
// This is *evidence* — what the user measured — and is deliberately separate from
// the derived fit, which lives in reconstruction.json as `scaleFit`. A scale is a
// cached result of (model × bars × marks); keeping the two apart is what lets the
// fit go stale without the measurements going with it.
// No `crs` field: a bar's distance is metres, which is CRS-independent — and a
// scale-bar project characteristically has no CRS at all.

export async function saveScaleBars(projectId, data) {
  return trackPersistence('saveScaleBars:' + String(projectId), async () => {
    const dir = await getProjectDir(projectId, true)
    await writeJson(dir, 'scalebars.json', data)
  })
}

export async function loadScaleBars(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'scalebars.json')
  } catch {
    return null
  }
}

export async function deleteScaleBars(projectId) {
  return trackPersistence('deleteScaleBars:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('scalebars.json')
    } catch (error) { ignoreMissing(error) }
  })
}

// ── Dev console log ──────────────────────────────────────────────────────────────
// Append-only NDJSON stream (`log.ndjson`): one { id, time, level, message,
// source } object per line. The console keeps only a bounded live *tail* in
// memory (SfM runs are verbose — thousands of lines); the file is the full
// record, so scroll-back and TXT export read from it rather than memory.
// Callers must serialise appends (≤1 in flight) — see useLogStore — since each
// append reads the current size to seek to the end.
// (Legacy `log.json` was a single rewritten array; migrated on first restore.)

export async function appendLog(projectId, entries) {
  return trackPersistence('appendLog:' + String(projectId), async () => {
    if (!entries || entries.length === 0) return
    const dir = await getProjectDir(projectId, true)
    await writeFileIn(dir, 'log.ndjson', entries.map(e => JSON.stringify(e)).join('\n') + '\n', { append: true })
  })
}

export async function readLog(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    const fh = await dir.getFileHandle('log.ndjson')
    const text = await (await fh.getFile()).text()
    const out = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try { out.push(JSON.parse(line)) } catch (error) { ignoreMissing(error) }
    }
    return out
  } catch {
    return null
  }
}

// Read only the live console window from the end of the append-only stream.
// Export/scroll-back still use readLog(), which deliberately returns everything.
export async function readLogTail(projectId, limit) {
  try {
    const dir = await getProjectDir(projectId)
    const fh = await dir.getFileHandle('log.ndjson')
    const file = await fh.getFile()
    if (!file.size || limit <= 0) return []
    let bytes = Math.min(file.size, Math.max(64 * 1024, limit * 256))
    while (true) {
      const start = file.size - bytes
      const text = await file.slice(start).text()
      const lines = text.split('\n')
      if (start > 0) lines.shift()
      const out = []
      for (const line of lines) {
        if (!line) continue
        try { out.push(JSON.parse(line)) } catch (error) { ignoreMissing(error) }
      }
      if (out.length >= limit || start === 0) return out.slice(-limit)
      bytes = Math.min(file.size, bytes * 2)
    }
  } catch {
    return null
  }
}

export async function truncateLog(projectId) {
  return trackPersistence('truncateLog:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId, true)
      await writeFileIn(dir, 'log.ndjson', null) // no keepExistingData ⇒ truncates
    } catch (error) { ignoreMissing(error) }
  })
}

export async function deleteLog(projectId) {
  return trackPersistence('deleteLog:' + String(projectId), async () => {
    for (const name of ['log.ndjson', 'log.json' /* legacy */]) {
      try {
        const dir = await getProjectDir(projectId)
        await dir.removeEntry(name)
      } catch (error) { ignoreMissing(error) }
    }
  })
}

// One-time migration off the legacy whole-array `log.json`. Returns its entries
// (to seed the stream) or null; caller appends them and removes the old file.
export async function loadLegacyLog(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'log.json')
  } catch {
    return null
  }
}

export async function deleteLegacyLog(projectId) {
  return trackPersistence('deleteLegacyLog:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('log.json')
    } catch (error) { ignoreMissing(error) }
  })
}

// ── Sensors (shared camera intrinsics) ──────────────────────────────────────────
// JSON: { sensors: [{ id, label, width, height, pixelSize, focal, cx, cy,
//                      k1, k2, k3, p1, p2, fixed, source }] }
// Intrinsics are CRS-free, so (unlike GCPs/footprints/poses) no `crs` field.

export async function saveSensors(projectId, data) {
  return trackPersistence('saveSensors:' + String(projectId), async () => {
    const dir = await getProjectDir(projectId, true)
    await writeJson(dir, 'sensors.json', data)
  })
}

export async function loadSensors(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'sensors.json')
  } catch {
    return null
  }
}

export async function deleteSensors(projectId) {
  return trackPersistence('deleteSensors:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('sensors.json')
    } catch (error) { ignoreMissing(error) }
  })
}

// ── Camera poses (exterior orientation / extrinsics) ────────────────────────────
// JSON: { crs, poses: [{ imageId, imageName, x, y, z, omega, phi, kappa,
//                        accuracyX/Y/Z, accXYZ, accuracyOmega/Phi/Kappa,
//                        accAngle, source, enabled }] }
// Positions live in the project CRS; angles (deg) pass through CRS changes
// unchanged and are consumed as camera-orientation priors during BA.

export async function savePoses(projectId, data) {
  return trackPersistence('savePoses:' + String(projectId), async () => {
    const dir = await getProjectDir(projectId, true)
    await writeJson(dir, 'poses.json', data)
  })
}

export async function loadPoses(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'poses.json')
  } catch {
    return null
  }
}

export async function deletePoses(projectId) {
  return trackPersistence('deletePoses:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('poses.json')
    } catch (error) { ignoreMissing(error) }
  })
}

// ── Reconstruction ────────────────────────────────────────────────────────────
// Metadata → reconstruction.json (version 3):
//   { version: 3, binaryFiles: { key: { name, bytes } }, clouds: [{ id, name, kind, createdAt, pointCount, hasColor,
//       cameras: [{ uuid, R, t, K }], viewUuids: [uuid, …] }],
//     georef, summary, denseSummary }
// The heavy per-point data lives in binary sidecars, one set per cloud, named
// `reconstruction.json.{generation}.{cloudId}.{key}.bin` (legacy: recon.{cloudId}.{key}.bin):
//   pos    Float64  3·N   x,y,z (world-frame precision)
//   col    Uint8    3·N   r,g,b (present only when hasColor)
//   colorMask Uint8 N     1 when a sparse point has colour; absent on legacy saves
//   nrm    Float32  3·N   world-space unit normals (dense-only; Poisson mesh input;
//                         absent on old projects / normal-less runs — do NOT heal)
//   idx    Uint32   3·T   triangle vertex indices (mesh clouds only)
//   vcount Uint32   N     view-tracks per point (CSR row lengths)
//   vcam   Uint32   ΣV    camera index into the cloud's viewUuids, per view
//   vkp    Uint32   ΣV    keypoint index, per view
// This replaces a multi-MB JSON.parse (which froze the main thread on open) with
// a transferable typed-array read. The store passes each cloud's typed arrays as
// `buffers: { pos, col, colorMask, nrm, idx, vcount, vcam, vkp, vx, vy }` (ArrayBuffers); load
// returns them the same way for the store to rebuild the point objects. vx/vy carry
// per-view BA-frame pixels (COLMAP export) and are absent on dense/legacy clouds.
const RECON_BIN_KEYS = ['pos', 'col', 'colorMask', 'nrm', 'idx', 'vcount', 'vcam', 'vkp', 'vx', 'vy']

async function removeStaleReconBins(dir, keepIds) {
  const stale = []
  for await (const name of dir.keys()) {
    const m = name.match(/^recon\.(.+)\.(?:pos|col|colorMask|nrm|idx|vcount|vcam|vkp|vx|vy)\.bin$/)
    if (m && !keepIds.has(m[1])) stale.push(name)
  }
  for (const name of stale) await dir.removeEntry(name).catch(ignoreMissing)
}

export async function saveReconstruction(projectId, data) {
  return trackPersistence('saveReconstruction:' + String(projectId), async () => {
    return persistenceLock(`reconstruction:${projectId}`, async () => {
      const dir = await getProjectDir(projectId, true)
      const { clouds = [], ...rest } = data
      const meta = { ...rest, version: 3, clouds: [] }
      const buffers = {}
      for (const c of clouds) {
        const { buffers: cloudBuffers, ...cmeta } = c
        meta.clouds.push(cmeta)
        for (const key of RECON_BIN_KEYS) {
          if (cloudBuffers?.[key]) buffers[`${c.id}.${key}`] = cloudBuffers[key]
        }
      }
      await writeBinaryDocument(dir, 'reconstruction.json', meta, buffers, { writeJson, writeBin })
    })
  })
}

export async function loadReconstruction(projectId) {
  return persistenceLock(`reconstruction:${projectId}`, async () => {
  try {
    const dir = await getProjectDir(projectId)
    const meta = await readJson(dir, 'reconstruction.json')
    if (!meta) return null
    // Legacy inline shape (points embedded in JSON) — hand back untouched; the
    // store still understands it. New saves write version 3 with immutable generation buffers.
    if (meta.version !== 2 && meta.version !== 3) return meta
    const saved = meta.binaryFiles ? await readBinaryDocument(dir, meta, readBin) : null
    await mapConcurrent(meta.clouds || [], 3, async (c) => {
      const buffers = {}
      const loaded = await mapConcurrent(RECON_BIN_KEYS, 6, async (key) => saved
        ? saved[`${c.id}.${key}`] ?? null
        : readBin(dir, `recon.${c.id}.${key}.bin`).catch(() => null))
      RECON_BIN_KEYS.forEach((key, index) => { buffers[key] = loaded[index] })
      const n = c.pointCount ?? 0
      if (!Number.isSafeInteger(n) || n < 0 || (buffers.pos?.byteLength ?? 0) !== n * 24
          || (c.hasColor && buffers.col?.byteLength !== n * 3)
          || (c.hasNormals && buffers.nrm?.byteLength !== n * 12)
          || (c.kind === 'mesh' && buffers.idx?.byteLength !== (c.triCount ?? 0) * 12)) {
        throw new Error('Incomplete saved reconstruction')
      }
      c.buffers = buffers
    })
    delete meta.binaryFiles
    return meta
  } catch {
    return null
  }
  })
}

export async function deleteReconstruction(projectId) {
  return trackPersistence('deleteReconstruction:' + String(projectId), () => persistenceLock(`reconstruction:${projectId}`, async () => {
    const dir = await getProjectDir(projectId)
    await dir.removeEntry('reconstruction.json').catch(ignoreMissing)
    await removeStaleReconBins(dir, new Set())
    if (dir.keys) for await (const name of dir.keys()) {
      if (name.startsWith('reconstruction.json.') && name.endsWith('.bin')) await dir.removeEntry(name).catch(ignoreMissing)
    }
  }))
}

// ── Products (DEM / orthophoto rasters) ──────────────────────────────────────
// Recomputable but expensive, so persisted like other project data. Metadata
// (dimensions, geotransform, CRS, preview PNG data URL) goes in products/{kind}.json;
// the raw sample arrays go in sibling .bin files so hover read-out survives a
// reload. DEM: Float32 heights (`data`) + Uint8 validity (`mask`). Ortho: Uint8
// RGBA (`rgba`).

function validateProduct(kind, product) {
  const n = product.width * product.height
  if (!Number.isSafeInteger(product.width) || product.width <= 0
      || !Number.isSafeInteger(product.height) || product.height <= 0 || !Number.isSafeInteger(n)
      || (kind === 'dem' ? !(product.data instanceof Float32Array) || product.data.length !== n
        || !(product.mask instanceof Uint8Array) || product.mask.length !== n
        : !(product.rgba instanceof Uint8Array || product.rgba instanceof Uint8ClampedArray) || product.rgba.length !== n * 4)) {
    throw new Error('Incomplete or invalid raster product')
  }
}

export async function saveProduct(projectId, kind, product) {
  return trackPersistence('saveProduct:' + String(projectId) + ':' + String(kind), async () => {
    validateProduct(kind, product)
    return persistenceLock(`product:${projectId}:${kind}`, async () => {
      const dir = await getSubDir(projectId, 'products')
      const { data, mask, rgba, ...meta } = product
      // Pass views, not their underlying buffer: subarrays may have a nonzero offset.
      await writeBinaryDocument(dir, `${kind}.json`, meta, { data, mask, rgba }, { writeJson, writeBin })
    })
  })
}

export async function loadProduct(projectId, kind) {
  return persistenceLock(`product:${projectId}:${kind}`, async () => {
    try {
      const dir = await getSubDir(projectId, 'products')
      const meta = await readJson(dir, `${kind}.json`)
      if (!meta) return null
      const buffers = meta.binaryFiles ? await readBinaryDocument(dir, meta, readBin) : null
      delete meta.binaryFiles
      const product = kind === 'dem' ? { ...meta,
        data: new Float32Array(buffers ? buffers.data : await readBin(dir, 'dem_data.bin')),
        mask: new Uint8Array(buffers ? buffers.mask : await readBin(dir, 'dem_mask.bin')),
      } : { ...meta, rgba: new Uint8Array(buffers ? buffers.rgba : await readBin(dir, `${kind}_rgba.bin`)) }
      validateProduct(kind, product)
      return product
    } catch { return null }
  })
}

export async function deleteProduct(projectId, kind) {
  return trackPersistence('deleteProduct:' + String(projectId) + ':' + String(kind), () => persistenceLock(`product:${projectId}:${kind}`, async () => {
    const dir = await getSubDir(projectId, 'products')
    await dir.removeEntry(`${kind}.json`).catch(ignoreMissing)
    for (const suffix of ['_data.bin', '_mask.bin', '_rgba.bin']) {
      await dir.removeEntry(`${kind}${suffix}`).catch(ignoreMissing)
    }
    if (dir.keys) for await (const name of dir.keys()) {
      if (name.startsWith(`${kind}.json.`) && name.endsWith('.bin')) await dir.removeEntry(name).catch(ignoreMissing)
    }
  }))
}

export async function deleteProducts(projectId) {
  return trackPersistence('deleteProducts:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('products', { recursive: true })
    } catch (error) { ignoreMissing(error) }
  })
}
